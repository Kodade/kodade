use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::shell::ShellEnvironment;

use super::Workspace;

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
    if !client_discovers_mcp(&workspace, &client) {
        return failed_mcp_health(
            &client,
            read_only,
            &workspace.id,
            "discovery",
            "the agent CLI did not discover this KödMCP connection",
        );
    }
    let mut command = Command::new(binary);
    command
        .arg("--db")
        .arg(db)
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
    let state_hash = context
        .pointer("/projectKnowledge/sources")
        .and_then(Value::as_array)
        .and_then(|sources| {
            sources
                .iter()
                .find(|source| source.get("kind").and_then(Value::as_str) == Some("state"))
        })
        .and_then(|source| source.get("sha256").and_then(Value::as_str))
        .map(str::to_owned);
    McpHealth {
        ok: true,
        client,
        access: if read_only { "read-only" } else { "read-write" }.into(),
        workspace_id: workspace.id,
        project_id,
        state_hash,
        tools,
        stage: "ready".into(),
        message: "KödMCP returned context for this workspace".into(),
    }
}

fn client_discovers_mcp(workspace: &Workspace, client: &str) -> bool {
    let shell = ShellEnvironment::current();
    let Some((executable, login_path)) = shell.resolve_executable_with_login_path(client) else {
        return false;
    };
    let server_name = server_name(client, &workspace.id);
    let mut command = Command::new(executable);
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
    if let Some(path) = login_path {
        command.env("PATH", path);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
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
            "projectKnowledge": { "projectId": "kodade" }
        });
        assert_eq!(context_project_id(&context).as_deref(), Some("kodade"));
        assert_eq!(
            context_project_id(&json!({ "workspace": { "id": "ws_01" } })),
            None
        );
    }
}
