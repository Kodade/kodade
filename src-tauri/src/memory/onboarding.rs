use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::shell::ShellEnvironment;

use super::{LegacyMigrationStatus, MemoryStore, Workspace};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpHealthAction {
    SetupProjectKnowledge,
    MigrateLegacyMemory,
    RecoverMigration,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    ok: bool,
    client: String,
    access: String,
    workspace_id: String,
    project_id: Option<String>,
    state_hash: Option<String>,
    tools: Vec<String>,
    stage: String,
    message: String,
    action: Option<McpHealthAction>,
}

#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct McpDiscoveryProcess {
    pub executable: PathBuf,
    pub path: Option<OsString>,
    pub timeout: Duration,
}

pub(super) fn failed_mcp_health(
    client: &str,
    read_only: bool,
    workspace_id: &str,
    stage: &str,
    message: &str,
) -> McpHealth {
    McpHealth {
        ok: false,
        client: client.into(),
        access: if read_only { "read-only" } else { "read-write" }.into(),
        workspace_id: workspace_id.into(),
        project_id: None,
        state_hash: None,
        tools: Vec::new(),
        stage: stage.into(),
        message: message.into(),
        action: None,
    }
}

fn failed_authority_health(
    client: &str,
    read_only: bool,
    workspace_id: &str,
    project_id: &str,
    action: McpHealthAction,
) -> McpHealth {
    let message = match action {
        McpHealthAction::SetupProjectKnowledge => {
            "Set up project knowledge before enabling writable agent access"
        }
        McpHealthAction::MigrateLegacyMemory => {
            "Migrate legacy project memory before enabling writable agent access"
        }
        McpHealthAction::RecoverMigration => {
            "Recover or roll back the project knowledge migration before enabling writable agent access"
        }
    };
    McpHealth {
        ok: false,
        client: client.into(),
        access: if read_only { "read-only" } else { "read-write" }.into(),
        workspace_id: workspace_id.into(),
        project_id: Some(project_id.into()),
        state_hash: None,
        tools: Vec::new(),
        stage: "authority".into(),
        message: message.into(),
        action: Some(action),
    }
}

pub(super) fn run_mcp_health(
    binary: PathBuf,
    db: PathBuf,
    workspace: Workspace,
    expected_project_id: String,
    client: String,
    read_only: bool,
) -> McpHealth {
    let shell = ShellEnvironment::current();
    let Some((executable, path)) = shell.resolve_executable_with_login_path(&client) else {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "discovery",
            "the agent CLI is unavailable for KödMCP discovery",
        );
    };
    run_mcp_health_with_discovery(
        binary,
        db,
        workspace,
        expected_project_id,
        client,
        read_only,
        McpDiscoveryProcess {
            executable,
            path,
            timeout: Duration::from_secs(5),
        },
    )
}

#[doc(hidden)]
pub fn run_mcp_health_with_discovery(
    binary: PathBuf,
    db: PathBuf,
    workspace: Workspace,
    expected_project_id: String,
    client: String,
    read_only: bool,
    discovery: McpDiscoveryProcess,
) -> McpHealth {
    if let Err(message) = client_discovers_mcp(&workspace, &client, &discovery) {
        return failed_mcp_health(&client, read_only, &workspace.id, "discovery", message);
    }
    let mut command = Command::new(binary);
    command
        .arg("--db")
        .arg(&db)
        .arg("--workspace")
        .arg(&workspace.canonical_root)
        .arg("--client")
        .arg(&client)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if read_only {
        command.arg("--read-only");
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return failed_mcp_health(
                &client,
                read_only,
                &workspace.id,
                "spawn",
                "KödMCP could not be started",
            )
        }
    };
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "stdio",
            "KödMCP stdin was unavailable",
        );
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "stdio",
            "KödMCP stdout was unavailable",
        );
    };
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let requests = [
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": { "name": "kodade-onboarding-health", "version": env!("CARGO_PKG_VERSION") } }
        }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "get_context", "arguments": { "workspaceRoot": workspace.canonical_root }
        }}),
    ];
    for request in requests {
        if writeln!(stdin, "{request}").is_err() || stdin.flush().is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return failed_mcp_health(
                &client,
                read_only,
                &workspace.id,
                "stdio",
                "KödMCP request failed",
            );
        }
    }
    let mut responses = std::collections::HashMap::<u64, Value>::new();
    while responses.len() < 3 {
        let line = match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => line,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return failed_mcp_health(
                    &client,
                    read_only,
                    &workspace.id,
                    "protocol",
                    "KödMCP health check timed out",
                );
            }
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            responses.insert(id, value);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    if responses
        .get(&1)
        .and_then(|value| value.get("result"))
        .is_none()
    {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "initialize",
            "KödMCP initialization failed",
        );
    }
    let tools = responses
        .get(&2)
        .and_then(|value| value.pointer("/result/tools"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !tool_access_matches(&tools, read_only) {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "tools",
            "KödMCP advertised the wrong access mode",
        );
    }
    let authority_action = match project_authority_action(&db, &workspace.id) {
        Ok(action) => action,
        Err(()) => Some(McpHealthAction::RecoverMigration),
    };
    if let Some(action) = authority_action {
        if !read_only || action != McpHealthAction::SetupProjectKnowledge {
            return failed_authority_health(
                &client,
                read_only,
                &workspace.id,
                &expected_project_id,
                action,
            );
        }
    }
    let Some(context) = responses
        .get(&3)
        .and_then(|value| value.pointer("/result/structuredContent"))
    else {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "context",
            "KödMCP did not return project context",
        );
    };
    if context.pointer("/workspace/id").and_then(Value::as_str) != Some(workspace.id.as_str()) {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "context",
            "KödMCP returned context for another workspace",
        );
    }
    let project_id = context_project_id(context);
    if project_id.as_deref() != Some(expected_project_id.as_str()) {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "context",
            "KödMCP returned context for another logical project",
        );
    }
    if !context_is_current(context) {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "context",
            "KödMCP could not refresh the mapped project context",
        );
    }
    let Some(state_hash) = context_state_hash(context) else {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "context",
            "KödMCP did not return the current state hash",
        );
    };
    McpHealth {
        ok: true,
        client,
        access: if read_only { "read-only" } else { "read-write" }.into(),
        workspace_id: workspace.id,
        project_id,
        state_hash: Some(state_hash),
        tools,
        stage: "ready".into(),
        message: if authority_action.is_some() {
            "KödMCP returned read-only legacy context; set up project knowledge before writable access"
                .into()
        } else {
            "KödMCP returned context for this workspace".into()
        },
        action: authority_action,
    }
}

fn project_authority_action(
    db: &std::path::Path,
    workspace_id: &str,
) -> Result<Option<McpHealthAction>, ()> {
    let store = MemoryStore::open(db).map_err(|_| ())?;
    match store.portable_authority(workspace_id) {
        Ok(Some(_)) => Ok(None),
        Ok(None) => Ok(Some(McpHealthAction::SetupProjectKnowledge)),
        Err(_) => Ok(Some(match store.preview_legacy_migration(workspace_id) {
            Ok(plan) if plan.status == LegacyMigrationStatus::Ready => {
                McpHealthAction::MigrateLegacyMemory
            }
            _ => McpHealthAction::RecoverMigration,
        })),
    }
}

fn client_discovers_mcp(
    workspace: &Workspace,
    client: &str,
    discovery: &McpDiscoveryProcess,
) -> Result<(), &'static str> {
    let server_name = server_name(client, &workspace.id);
    let mut command = Command::new(&discovery.executable);
    command
        .current_dir(&workspace.canonical_root)
        .arg("mcp")
        .arg("get")
        .arg(server_name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if client == "codex" {
        command.arg("--json");
    }
    if let Some(path) = &discovery.path {
        command.env("PATH", path);
    }
    let Ok(mut child) = command.spawn() else {
        return Err("the agent CLI discovery process could not be started");
    };
    let deadline = Instant::now() + discovery.timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err("the agent CLI did not discover this KödMCP connection"),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the agent CLI discovery check timed out");
            }
        }
    }
}

fn server_name(client: &str, workspace_id: &str) -> String {
    if client == "claude" {
        "kodade-mem".to_string()
    } else {
        format!("kodade-mem-{workspace_id}")
    }
}

fn tool_access_matches(tools: &[String], read_only: bool) -> bool {
    let required = ["get_context", "search_memories", "get_memory"];
    let write_tools = ["remember", "revise_memory", "forget_memory", "checkpoint"];
    required
        .iter()
        .all(|name| tools.iter().any(|tool| tool == name))
        && if read_only {
            write_tools
                .iter()
                .all(|name| !tools.iter().any(|tool| tool == name))
        } else {
            write_tools
                .iter()
                .all(|name| tools.iter().any(|tool| tool == name))
        }
}

fn context_project_id(context: &Value) -> Option<String> {
    context
        .pointer("/projectKnowledge/projectId")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn context_is_current(context: &Value) -> bool {
    context
        .pointer("/projectKnowledge/sync/status")
        .and_then(Value::as_str)
        == Some("current")
}

fn context_state_hash(context: &Value) -> Option<String> {
    context
        .pointer("/projectKnowledge/sources")
        .and_then(Value::as_array)
        .and_then(|sources| {
            sources
                .iter()
                .find(|source| source.get("kind").and_then(Value::as_str) == Some("state"))
        })
        .and_then(|source| source.get("sha256").and_then(Value::as_str))
        .filter(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_tools() -> Vec<String> {
        ["get_context", "search_memories", "get_memory"]
            .map(str::to_owned)
            .to_vec()
    }

    #[test]
    fn client_discovery_names_are_project_distinct_where_needed() {
        assert_eq!(server_name("claude", "ws_01"), "kodade-mem");
        assert_eq!(server_name("codex", "ws_01"), "kodade-mem-ws_01");
        assert_eq!(server_name("codex", "ws_02"), "kodade-mem-ws_02");
    }

    #[test]
    fn health_requires_the_exact_mode_specific_tool_surface() {
        let reads = read_tools();
        assert!(tool_access_matches(&reads, true));
        assert!(!tool_access_matches(&reads, false));

        let mut writable = reads;
        writable.extend(
            ["remember", "revise_memory", "forget_memory", "checkpoint"].map(str::to_owned),
        );
        assert!(tool_access_matches(&writable, false));
        assert!(!tool_access_matches(&writable, true));
    }

    #[test]
    fn health_reads_only_the_returned_logical_project_identity() {
        let context = json!({
            "workspace": { "id": "ws_01" },
            "projectKnowledge": {
                "projectId": "kodade",
                "sync": { "status": "current" }
            }
        });
        assert_eq!(context_project_id(&context).as_deref(), Some("kodade"));
        assert!(context_is_current(&context));
        assert_eq!(
            context_project_id(&json!({ "workspace": { "id": "ws_01" } })),
            None
        );
        assert!(!context_is_current(&json!({
            "projectKnowledge": { "projectId": "kodade", "sync": { "status": "error" } }
        })));
    }

    #[test]
    fn health_requires_a_current_state_hash_for_checkpoint_cas() {
        let hash = "a".repeat(64);
        let context = json!({
            "projectKnowledge": {
                "sources": [
                    { "kind": "project", "sha256": "b".repeat(64) },
                    { "kind": "state", "sha256": hash }
                ]
            }
        });
        assert_eq!(context_state_hash(&context), Some("a".repeat(64)));
        assert_eq!(
            context_state_hash(&json!({ "projectKnowledge": { "sources": [] } })),
            None
        );
        assert_eq!(
            context_state_hash(&json!({
                "projectKnowledge": { "sources": [{ "kind": "state", "sha256": "NOT-A-HASH" }] }
            })),
            None
        );
    }
}
