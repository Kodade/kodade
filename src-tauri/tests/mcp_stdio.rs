use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use kodade_lib::memory::{
    MemoryKind, MemorySource, MemoryStore, NewCheckpoint, NewMemory, WorkingMemoryMode,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

struct McpProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    protocol_version: Option<String>,
}

impl McpProcess {
    fn spawn_uninitialized(db: &Path, read_only: bool, workspace: Option<&Path>) -> Self {
        let mut command = mcp_command(db, read_only, workspace);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let mut child = command.spawn().expect("spawn kodade-mcp");
        let stdin = child.stdin.take().expect("capture MCP stdin");
        let stdout = BufReader::new(child.stdout.take().expect("capture MCP stdout"));
        Self {
            child,
            stdin,
            stdout,
            next_id: 1,
            protocol_version: None,
        }
    }

    fn spawn(db: &Path, read_only: bool, protocol_version: &str) -> Self {
        Self::spawn_scoped(db, read_only, protocol_version, None)
    }

    fn spawn_scoped(
        db: &Path,
        read_only: bool,
        protocol_version: &str,
        workspace: Option<&Path>,
    ) -> Self {
        let mut process = Self::spawn_uninitialized(db, read_only, workspace);
        process.protocol_version = Some(protocol_version.to_owned());
        let result = if protocol_version == "2026-07-28" {
            let discovered = process.request("server/discover", json!({}));
            assert!(discovered["result"]["supportedVersions"]
                .as_array()
                .expect("supported MCP protocol versions")
                .iter()
                .any(|version| version == protocol_version));
            discovered["result"].clone()
        } else {
            let initialized = process.request(
                "initialize",
                json!({
                    "protocolVersion": protocol_version,
                    "capabilities": {},
                    "clientInfo": { "name": "kodade-integration-test", "version": "1" }
                }),
            );
            assert_eq!(
                initialized["result"]["protocolVersion"], protocol_version,
                "server should negotiate the client's supported protocol version"
            );
            process.notify("notifications/initialized", None);
            initialized["result"].clone()
        };
        let instructions = result["instructions"]
            .as_str()
            .expect("KödMCP should provide automatic workflow instructions");
        assert!(instructions.contains("call get_context"));
        assert!(instructions.contains("call checkpoint"));
        process
    }

    fn request(&mut self, method: &str, mut params: Value) -> Value {
        if self.protocol_version.as_deref() == Some("2026-07-28") {
            let params = params
                .as_object_mut()
                .expect("MCP request params should be an object");
            let meta = params.entry("_meta").or_insert_with(|| json!({}));
            let meta = meta
                .as_object_mut()
                .expect("MCP request metadata should be an object");
            meta.insert(
                "io.modelcontextprotocol/protocolVersion".into(),
                json!("2026-07-28"),
            );
            meta.insert(
                "io.modelcontextprotocol/clientCapabilities".into(),
                json!({}),
            );
            meta.insert(
                "io.modelcontextprotocol/clientInfo".into(),
                json!({ "name": "kodade-integration-test", "version": "1" }),
            );
        }
        self.request_raw(method, params)
    }

    fn request_raw(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read MCP response");
        assert!(
            !line.is_empty(),
            "kodade-mcp closed stdout before responding"
        );
        let response: Value = serde_json::from_str(&line).expect("valid JSON-RPC response");
        assert_eq!(response["id"], id, "response id should match request id");
        response
    }

    fn notify(&mut self, method: &str, params: Option<Value>) {
        let mut message = json!({ "jsonrpc": "2.0", "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write(message);
    }

    fn call_tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
    }

    fn write(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").expect("write MCP message");
        self.stdin.flush().expect("flush MCP message");
    }
}

fn mcp_command(db: &Path, read_only: bool, workspace: Option<&Path>) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kodade-mcp"));
    command
        .arg("--db")
        .arg(db)
        .arg("--client")
        .arg("mcp-stdio-test");
    if let Some(workspace) = workspace {
        command.arg("--workspace").arg(workspace);
    }
    if read_only {
        command.arg("--read-only");
    }
    command
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn registered_store() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let temp = tempfile::tempdir().expect("create MCP fixture");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).expect("create registered workspace");
    let workspace = std::fs::canonicalize(workspace).expect("canonicalize registered workspace");
    let db = temp.path().join("kodade-memory.sqlite3");
    MemoryStore::open(&db)
        .expect("open MCP fixture store")
        .register_workspace(&workspace, "MCP Fixture", None)
        .expect("register MCP fixture workspace");
    (temp, db, workspace)
}

fn file_hash(path: &Path) -> Vec<u8> {
    Sha256::digest(std::fs::read(path).expect("read database bytes")).to_vec()
}

fn tool_names(response: &Value) -> Vec<&str> {
    response["result"]["tools"]
        .as_array()
        .expect("tools/list result")
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect()
}

#[test]
fn stdio_supports_final_2026_discovery_and_cache_metadata() {
    let (_temp, db, workspace) = registered_store();
    let mut process = McpProcess::spawn_uninitialized(&db, false, None);
    process.protocol_version = Some("2026-07-28".into());

    let discovery = process.request("server/discover", json!({}));
    let result = &discovery["result"];
    assert!(result["supportedVersions"]
        .as_array()
        .expect("supported MCP protocol versions")
        .iter()
        .any(|version| version == "2026-07-28"));
    assert_eq!(
        result["capabilities"],
        json!({ "prompts": {}, "tools": {} })
    );
    assert_eq!(result["resultType"], "complete");
    assert_eq!(result["ttlMs"], 0);
    assert_eq!(result["cacheScope"], "private");
    assert_eq!(
        result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "kodade-mcp"
    );
    let instructions = result["instructions"]
        .as_str()
        .expect("KödMCP should provide automatic workflow instructions");
    assert!(instructions.contains("call get_context"));
    assert!(instructions.contains("call checkpoint"));

    let missing_metadata = process.request_raw("tools/list", json!({}));
    assert_eq!(missing_metadata["error"]["code"], -32602);

    for method in ["tools/list", "prompts/list"] {
        let response = process.request(method, json!({}));
        assert_eq!(response["result"]["resultType"], "complete");
        assert_eq!(response["result"]["ttlMs"], 0);
        assert_eq!(response["result"]["cacheScope"], "private");
    }

    let context = process.call_tool(
        "get_context",
        json!({ "workspaceRoot": workspace.to_string_lossy() }),
    );
    assert_eq!(context["result"]["resultType"], "complete");
    assert!(context["result"]["ttlMs"].is_null());
    assert!(context["result"]["cacheScope"].is_null());

    let prompt = process.request("prompts/get", json!({ "name": "kodade_workflow" }));
    assert_eq!(prompt["result"]["resultType"], "complete");
    assert!(prompt["result"]["ttlMs"].is_null());
    assert!(prompt["result"]["cacheScope"].is_null());
}

#[test]
fn stdio_keeps_legacy_lifecycle_and_result_shape() {
    let (_temp, db, _workspace) = registered_store();
    for protocol_version in ["2025-06-18", "2025-11-25"] {
        let mut process = McpProcess::spawn(&db, false, protocol_version);

        let tools = process.request("tools/list", json!({}));
        assert!(tools["result"]["tools"].is_array());
        assert!(tools["result"]["resultType"].is_null());
        assert!(tools["result"]["ttlMs"].is_null());
        assert!(tools["result"]["cacheScope"].is_null());

        let prompt = process.request("prompts/get", json!({ "name": "kodade_workflow" }));
        assert!(prompt["result"]["messages"].is_array());
        assert!(prompt["result"]["resultType"].is_null());
    }
}

#[test]
fn stdio_advertises_write_tools_only_when_writable() {
    let (_temp, db, _workspace) = registered_store();

    {
        let mut process = McpProcess::spawn(&db, false, "2026-07-28");
        let tools = process.request("tools/list", json!({}));
        assert_eq!(
            tool_names(&tools),
            [
                "get_context",
                "search_memories",
                "get_memory",
                "remember",
                "revise_memory",
                "forget_memory",
                "checkpoint",
            ]
        );
    }

    let mut process = McpProcess::spawn(&db, true, "2025-11-25");
    let tools = process.request("tools/list", json!({}));
    assert_eq!(
        tool_names(&tools),
        ["get_context", "search_memories", "get_memory"]
    );
    let rejected = process.call_tool(
        "remember",
        json!({
            "workspaceRoot": "/not/used",
            "kind": "fact",
            "title": "Not stored",
            "body": "Read-only mode blocks this call."
        }),
    );
    assert_eq!(rejected["result"]["isError"], true);
    assert_eq!(rejected["result"]["structuredContent"]["type"], "read_only");
}

#[test]
fn stdio_drives_the_registered_workspace_memory_workflow() {
    let (temp, db, workspace) = registered_store();
    let unregistered = temp.path().join("unregistered");
    let root = workspace.to_string_lossy();
    let mut process = McpProcess::spawn(&db, false, "2026-07-28");

    let context = process.call_tool("get_context", json!({ "workspaceRoot": root }));
    assert_eq!(context["result"]["isError"], false);
    assert_eq!(
        context["result"]["structuredContent"]["workspace"]["canonicalRoot"],
        root.as_ref()
    );
    assert!(
        context["result"]["structuredContent"]["projection"].is_null()
            || context["result"]["structuredContent"]["projection"]["truncated"] == false,
        "ordinary context must not claim that provider projection removed data"
    );

    let missing = process.call_tool(
        "get_context",
        json!({ "workspaceRoot": unregistered.to_string_lossy() }),
    );
    assert_eq!(missing["result"]["isError"], true);
    assert_eq!(
        missing["result"]["structuredContent"]["type"],
        "workspace_not_registered"
    );
    assert!(missing["result"]["structuredContent"]["message"]
        .as_str()
        .expect("workspace error message")
        .contains("workspace is not registered in Kodade"));

    let remember_args = json!({
        "workspaceRoot": root,
        "kind": "decision",
        "title": "MCP integration decision",
        "body": "Use the real stdio protocol boundary.",
        "idempotencyKey": "mcp-integration-decision"
    });
    let created = process.call_tool("remember", remember_args.clone());
    assert_eq!(created["result"]["isError"], false);
    let created_record = &created["result"]["structuredContent"];
    assert_eq!(created_record["version"], 1);
    assert_eq!(created_record["source"], "agent");
    assert_eq!(created_record["sourceClient"], "mcp-stdio-test");

    let retry = process.call_tool("remember", remember_args);
    assert_eq!(
        retry["result"]["structuredContent"]["id"], created_record["id"],
        "an idempotent retry should return the original record"
    );

    let search = process.call_tool(
        "search_memories",
        json!({
            "workspaceRoot": root,
            "query": "MCP integration decision",
            "limit": 500
        }),
    );
    assert_eq!(search["result"]["isError"], false);
    assert_eq!(search["result"]["structuredContent"]["limit"], 50);
    assert_eq!(search["result"]["structuredContent"]["total"], 1);
    assert_eq!(
        search["result"]["structuredContent"]["items"][0]["id"],
        created_record["id"]
    );

    let id = created_record["id"].as_str().expect("created memory id");
    let loaded = process.call_tool("get_memory", json!({ "workspaceRoot": root, "id": id }));
    assert_eq!(loaded["result"]["isError"], false);
    assert_eq!(loaded["result"]["structuredContent"]["id"], id);
    let revised = process.call_tool(
        "revise_memory",
        json!({
            "id": id,
            "expectedVersion": 1,
            "body": "Use raw JSON-RPC over the real stdio protocol boundary.",
            "pinned": true
        }),
    );
    assert_eq!(revised["result"]["isError"], false);
    assert_eq!(revised["result"]["structuredContent"]["version"], 2);
    assert_eq!(revised["result"]["structuredContent"]["pinned"], true);

    let stale = process.call_tool(
        "revise_memory",
        json!({
            "id": id,
            "expectedVersion": 1,
            "title": "Stale overwrite"
        }),
    );
    assert_eq!(stale["result"]["isError"], true);
    assert_eq!(
        stale["result"]["structuredContent"]["type"],
        "version_conflict"
    );
    assert_eq!(stale["result"]["structuredContent"]["currentVersion"], 2);
    assert!(stale["result"]["structuredContent"]["message"]
        .as_str()
        .expect("version conflict message")
        .contains("current version is 2"));

    let oversized_title = process.call_tool(
        "remember",
        json!({
            "workspaceRoot": root,
            "kind": "fact",
            "title": "O".repeat(201),
            "body": "This record must be rejected by the MCP layer."
        }),
    );
    assert_eq!(oversized_title["result"]["isError"], true);
    assert_eq!(
        oversized_title["result"]["structuredContent"]["type"],
        "size_limit"
    );
    assert_eq!(
        oversized_title["result"]["structuredContent"]["maxCharacters"],
        200
    );
    assert!(oversized_title["result"]["structuredContent"]["message"]
        .as_str()
        .expect("title limit message")
        .contains("200 characters"));

    let stale_forget = process.call_tool(
        "forget_memory",
        json!({
            "id": id,
            "expectedVersion": 1
        }),
    );
    assert_eq!(stale_forget["result"]["isError"], true);
    assert_eq!(
        stale_forget["result"]["structuredContent"]["type"],
        "version_conflict"
    );
    assert_eq!(
        stale_forget["result"]["structuredContent"]["expectedVersion"],
        1
    );
    assert_eq!(
        stale_forget["result"]["structuredContent"]["currentVersion"],
        2
    );

    let checkpoint = process.call_tool(
        "checkpoint",
        json!({
            "workspaceRoot": root,
            "summary": "The MCP integration workflow is covered.",
            "nextActions": ["Run the full Rust suite."],
            "sessionId": "mcp-integration-session",
            "idempotencyKey": "mcp-integration-checkpoint"
        }),
    );
    assert_eq!(checkpoint["result"]["isError"], false);
    assert_eq!(checkpoint["result"]["structuredContent"]["source"], "agent");
    assert_eq!(
        checkpoint["result"]["structuredContent"]["sourceClient"],
        "mcp-stdio-test"
    );

    let context = process.call_tool("get_context", json!({ "workspaceRoot": root }));
    assert_eq!(
        context["result"]["structuredContent"]["latestCheckpoint"]["summary"],
        "The MCP integration workflow is covered."
    );

    let secret_body = format!(
        "Never persist {}{} in project memory.",
        "AKIA", "0123456789ABCDEF"
    );
    let secret = process.call_tool(
        "remember",
        json!({
            "workspaceRoot": root,
            "kind": "fact",
            "title": "Rejected credential fixture",
            "body": secret_body
        }),
    );
    assert_eq!(secret["result"]["isError"], true);
    assert_eq!(
        secret["result"]["structuredContent"]["type"],
        "secret_detected"
    );

    let residue = process.call_tool(
        "search_memories",
        json!({
            "workspaceRoot": root,
            "query": "Rejected credential fixture"
        }),
    );
    assert_eq!(residue["result"]["structuredContent"]["total"], 0);

    let prompt = process.request(
        "prompts/get",
        json!({ "name": "kodade_workflow", "arguments": {} }),
    );
    let prompt_text = prompt["result"]["messages"][0]["content"]["text"]
        .as_str()
        .expect("workflow prompt text");
    assert!(prompt_text.contains("get_context"));
    assert!(prompt_text.contains("checkpoint"));
    assert!(prompt_text.split_whitespace().count() < 200);
}

#[test]
fn read_only_stdio_serves_fresh_mapped_project_markdown_with_provenance() {
    let temp = tempfile::tempdir().expect("create mapped MCP fixture");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).expect("create workspace");
    let workspace = std::fs::canonicalize(workspace).expect("canonicalize workspace");
    let vault = temp.path().join("projects-vault");
    std::fs::create_dir_all(vault.join(".obsidian")).expect("create Obsidian config");
    let project = vault.join("10-Projects/mcp-project");
    std::fs::create_dir_all(&project).expect("create mapped project");
    std::fs::write(
        project.join("Project.md"),
        "# MCP project\n\nStable charter.\n",
    )
    .expect("write project hub");
    std::fs::write(
        project.join("STATE.md"),
        "# State\n\nInitial mapped state.\n",
    )
    .expect("write state");
    let db = temp.path().join("kodade-memory.sqlite3");
    let store = MemoryStore::open(&db).expect("open mapped MCP store");
    store
        .register_projects_vault(&vault)
        .expect("register vault");
    let registered = store
        .register_workspace(&workspace, "Mapped MCP", None)
        .expect("register workspace");
    store
        .map_workspace_to_project(&registered.id, None, "mcp-project", "MCP project")
        .expect("map workspace");
    drop(store);

    let root = workspace.to_string_lossy();
    let mut process = McpProcess::spawn(&db, true, "2026-07-28");
    let context = process.call_tool("get_context", json!({ "workspaceRoot": root }));
    assert_eq!(
        context["result"]["structuredContent"]["projectKnowledge"]["projectId"],
        "mcp-project"
    );
    assert!(
        context["result"]["structuredContent"]["projectKnowledge"]["origin"].is_null(),
        "standalone KödMCP must not expose the machine-local vault origin to providers"
    );
    assert_eq!(
        context["result"]["structuredContent"]["projectKnowledge"]["sync"]["status"],
        "current"
    );
    assert!(
        context["result"]["structuredContent"]["projection"].is_null(),
        "ordinary mapped context must not claim provider truncation"
    );
    assert_eq!(
        context["result"]["structuredContent"]["projectKnowledge"]["sources"][1]["relativePath"],
        "STATE.md"
    );

    std::fs::write(
        project.join("STATE.md"),
        "# State\n\nExternal mcp-refresh-nebula edit.\n",
    )
    .expect("edit mapped state externally");
    let search = process.call_tool(
        "search_memories",
        json!({ "workspaceRoot": root, "query": "mcp-refresh-nebula" }),
    );
    assert_eq!(search["result"]["structuredContent"]["total"], 1);
    assert_eq!(
        search["result"]["structuredContent"]["items"][0]["projectSource"]["relativePath"],
        "STATE.md"
    );
    assert_eq!(
        search["result"]["structuredContent"]["items"][0]["projectSource"]["sha256"]
            .as_str()
            .expect("bounded source hash")
            .len(),
        64
    );

    std::fs::remove_file(project.join("STATE.md")).expect("break mapped state externally");
    let failed = process.call_tool("get_context", json!({ "workspaceRoot": root }));
    assert_eq!(
        failed["result"]["structuredContent"]["projectKnowledge"]["sync"]["status"],
        "error"
    );
    assert_eq!(
        failed["result"]["structuredContent"]["projectKnowledge"]["sync"]["error"],
        "Refresh failed. Repair the mapped project in the local Memory pane, then retry."
    );
    assert!(
        !failed
            .to_string()
            .contains(vault.to_string_lossy().as_ref()),
        "provider-facing sync errors must not reveal the machine-local vault origin"
    );
}

#[test]
fn stdio_get_context_bounds_the_complete_worst_case_response() {
    let temp = tempfile::tempdir().expect("create bounded MCP fixture");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).expect("create workspace");
    let workspace = std::fs::canonicalize(workspace).expect("canonicalize workspace");
    let vault = temp.path().join("projects-vault");
    std::fs::create_dir_all(vault.join(".obsidian")).expect("create Obsidian config");
    let project = vault.join("10-Projects/bounded-project");
    std::fs::create_dir_all(&project).expect("create mapped project");
    let mapped_body = "m".repeat(255 * 1024);
    std::fs::write(
        project.join("Project.md"),
        format!("# Bounded project\n\n{mapped_body}"),
    )
    .expect("write large project hub");
    std::fs::write(
        project.join("STATE.md"),
        format!("# State\n\n{mapped_body}"),
    )
    .expect("write large mapped state");

    let db = temp.path().join("kodade-memory.sqlite3");
    let store = MemoryStore::open(&db).expect("open bounded MCP store");
    store
        .register_projects_vault(&vault)
        .expect("register projects vault");
    let registered = store
        .register_workspace(&workspace, "Bounded MCP", None)
        .expect("register workspace");
    store
        .map_workspace_to_project(&registered.id, None, "bounded-project", "Bounded project")
        .expect("map workspace");

    let memory_body = "\"".repeat(256 * 1024);
    for (kind, count, pinned, label) in [
        (MemoryKind::Decision, 20, true, "decision"),
        (MemoryKind::Task, 50, false, "task"),
        (MemoryKind::Fact, 30, false, "recent"),
    ] {
        for index in 0..count {
            store
                .remember(NewMemory {
                    workspace_id: registered.id.clone(),
                    kind,
                    title: format!("Worst-case {label} {index:02}"),
                    body: memory_body.clone(),
                    source: MemorySource::Agent,
                    source_client: "bounded-mcp-fixture".into(),
                    session_id: Some("worst-case-session".into()),
                    pinned,
                    idempotency_key: None,
                    links: Vec::new(),
                })
                .expect("remember worst-case record");
        }
    }
    store
        .checkpoint(NewCheckpoint {
            workspace_id: registered.id.clone(),
            summary: "c".repeat(64 * 1024),
            decisions: (0..100)
                .map(|index| format!("decision-{index:03}-{}", "d".repeat(1_000)))
                .collect(),
            next_actions: (0..100)
                .map(|index| format!("action-{index:03}-{}", "a".repeat(1_000)))
                .collect(),
            changed_paths: (0..100)
                .map(|index| format!("path-{index:03}-{}", "p".repeat(1_000)))
                .collect(),
            source: MemorySource::Agent,
            source_client: "bounded-mcp-fixture".into(),
            session_id: Some("worst-case-session".into()),
            idempotency_key: None,
        })
        .expect("checkpoint worst-case context");
    drop(store);

    let mut process = McpProcess::spawn(&db, true, "2026-07-28");
    let response = process.call_tool(
        "get_context",
        json!({ "workspaceRoot": workspace.to_string_lossy() }),
    );
    let serialized = serde_json::to_vec(&response).expect("serialize actual MCP response");

    assert!(
        serialized.len() <= 64 * 1024,
        "the complete MCP get_context response was {} bytes",
        serialized.len()
    );
    let context = &response["result"]["structuredContent"];
    let projection = &context["projection"];
    assert_eq!(projection["truncated"], true);
    assert_eq!(projection["affectedLanesTruncated"], false);
    let text_context: Value = serde_json::from_str(
        response["result"]["content"][0]["text"]
            .as_str()
            .expect("provider text context"),
    )
    .expect("parse provider text context");
    assert_eq!(&text_context["projection"], projection);
    assert_eq!(projection["originalCounts"]["pinnedDecisions"], 20);
    assert_eq!(projection["originalCounts"]["openTasks"], 50);
    assert_eq!(projection["originalCounts"]["recentMemories"], 30);
    assert_eq!(projection["originalCounts"]["checkpointDecisions"], 100);
    assert_eq!(projection["originalCounts"]["checkpointNextActions"], 100);
    assert_eq!(projection["originalCounts"]["checkpointChangedPaths"], 100);
    assert_eq!(projection["originalCounts"]["projectSources"], 2);
    assert_eq!(projection["returnedCounts"]["pinnedDecisions"], 3);
    assert_eq!(projection["returnedCounts"]["openTasks"], 5);
    assert_eq!(projection["returnedCounts"]["recentMemories"], 5);
    assert_eq!(projection["returnedCounts"]["checkpointDecisions"], 3);
    assert_eq!(projection["returnedCounts"]["checkpointNextActions"], 3);
    assert_eq!(projection["returnedCounts"]["checkpointChangedPaths"], 3);
    assert_eq!(projection["returnedCounts"]["projectSources"], 2);
    let affected_lanes = projection["affectedLanes"]
        .as_array()
        .expect("bounded projection lanes")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    assert!(affected_lanes.windows(2).all(|pair| pair[0] < pair[1]));
    for lane in [
        "latestCheckpoint.summary",
        "latestCheckpoint.decisions",
        "latestCheckpoint.decisions.items",
        "pinnedDecisions",
        "pinnedDecisions.body",
        "openTasks",
        "openTasks.body",
        "recentMemories",
        "recentMemories.body",
        "projectKnowledge.sources.content",
    ] {
        assert!(
            affected_lanes.contains(&lane),
            "missing affected projection lane {lane}"
        );
    }
    assert!(context["latestCheckpoint"]["summary"]
        .as_str()
        .is_some_and(|summary| summary.ends_with('…')));
    for (field, expected_items) in [
        ("pinnedDecisions", 3),
        ("openTasks", 5),
        ("recentMemories", 5),
    ] {
        let memories = context[field].as_array().expect("bounded memory lane");
        assert_eq!(memories.len(), expected_items);
        assert!(memories[0]["body"]
            .as_str()
            .is_some_and(|body| body.ends_with('…')));
        assert!(memories[0]["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("mem_")));
        assert_eq!(memories[0]["source"], "agent");
        assert_eq!(memories[0]["sourceClient"], "bounded-mcp-fixture");
    }
    assert_eq!(
        context["latestCheckpoint"]["decisions"]
            .as_array()
            .expect("bounded checkpoint decisions")
            .len(),
        3
    );
    assert_eq!(
        context["projectKnowledge"]["sources"][0]["relativePath"],
        "Project.md"
    );
    assert_eq!(
        context["projectKnowledge"]["sources"][0]["sha256"]
            .as_str()
            .expect("mapped source provenance")
            .len(),
        64
    );
}

#[test]
fn stdio_context_search_and_checkpoint_round_trip_project_working_files() {
    let (_temp, db, workspace_root) = registered_store();
    let store = MemoryStore::open(&db).expect("open fixture store");
    let workspace = store
        .resolve_workspace(&workspace_root)
        .expect("resolve fixture workspace");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate working memory");
    std::fs::write(
        workspace_root.join(".kodade/memory/STATE.md"),
        "# Project state\n\nThe orbital renderer is ready for integration.\n",
    )
    .expect("edit readable state");

    let root = workspace_root.to_string_lossy();
    let mut process = McpProcess::spawn(&db, false, "2026-07-28");
    let context = process.call_tool("get_context", json!({ "workspaceRoot": root }));
    assert!(
        context["result"]["structuredContent"]["workingMemory"]["state"]
            .as_str()
            .expect("working state")
            .contains("orbital renderer")
    );
    let search = process.call_tool(
        "search_memories",
        json!({ "workspaceRoot": root, "query": "orbital renderer" }),
    );
    assert_eq!(search["result"]["structuredContent"]["total"], 1);
    assert_eq!(
        search["result"]["structuredContent"]["items"][0]["filePath"],
        ".kodade/memory/STATE.md"
    );

    let checkpoint = process.call_tool(
        "checkpoint",
        json!({
            "workspaceRoot": root,
            "summary": "Integrated the orbital renderer.",
            "decisions": ["Keep the renderer streaming."],
            "nextActions": ["Run the visual regression suite."],
            "changedPaths": ["src/renderer.ts"],
            "sessionId": "mcp-working-files",
            "idempotencyKey": "mcp-working-files:handoff"
        }),
    );
    assert_eq!(checkpoint["result"]["isError"], false);
    assert_eq!(
        checkpoint["result"]["structuredContent"]["decisions"][0],
        "Keep the renderer streaming."
    );
    assert_eq!(
        checkpoint["result"]["structuredContent"]["changedPaths"][0],
        "src/renderer.ts"
    );
    let state = std::fs::read_to_string(workspace_root.join(".kodade/memory/STATE.md"))
        .expect("read checkpointed state");
    assert!(state.contains("Integrated the orbital renderer"));
    assert!(state.contains("Run the visual regression suite"));
    assert!(state.contains("src/renderer.ts"));
    let decisions = std::fs::read_to_string(workspace_root.join(".kodade/memory/decisions.md"))
        .expect("read checkpoint decisions");
    assert!(decisions.contains("Keep the renderer streaming"));
}

#[test]
fn read_only_stdio_never_changes_or_creates_the_database() {
    let (temp, db, workspace) = registered_store();
    let recovery_lock = std::path::PathBuf::from(format!("{}.recovery.lock", db.display()));
    std::fs::remove_file(&recovery_lock).expect("remove writable fixture recovery lock");
    let before = file_hash(&db);

    {
        let mut process = McpProcess::spawn(&db, true, "2026-07-28");
        let context = process.call_tool(
            "get_context",
            json!({ "workspaceRoot": workspace.to_string_lossy() }),
        );
        assert_eq!(context["result"]["isError"], false);

        for name in ["remember", "revise_memory", "forget_memory", "checkpoint"] {
            let rejected = process.call_tool(name, json!({}));
            assert_eq!(rejected["result"]["isError"], true, "tool: {name}");
            assert_eq!(
                rejected["result"]["structuredContent"]["type"], "read_only",
                "tool: {name}"
            );
        }
    }

    assert_eq!(file_hash(&db), before, "read-only calls changed DB bytes");
    assert!(
        !recovery_lock.exists(),
        "read-only calls recreated the recovery lock"
    );

    let missing_parent = temp.path().join("missing-parent");
    let missing_db = missing_parent.join("missing.sqlite3");
    let output = mcp_command(&missing_db, true, None)
        .output()
        .expect("run read-only server with a missing database");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("read-only memory database does not exist"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!missing_db.exists(), "read-only open created the database");
    assert!(
        !missing_parent.exists(),
        "read-only open created parent directories"
    );
}

#[test]
fn read_only_stdio_rejects_an_older_schema_without_migrating() {
    let temp = tempfile::tempdir().expect("create old-schema fixture");
    let db = temp.path().join("kodade-memory.sqlite3");
    let connection = rusqlite::Connection::open(&db).expect("create old-schema database");
    connection
        .execute_batch(
            "CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
             );
             INSERT INTO schema_migrations(version, applied_at) VALUES (6, 0);",
        )
        .expect("mark old schema version");
    drop(connection);
    let before = file_hash(&db);

    let output = mcp_command(&db, true, None)
        .output()
        .expect("run read-only server with an old schema");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("schema 6 is older than current version 11"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(file_hash(&db), before, "read-only startup migrated the DB");
}

#[test]
fn workspace_restriction_denies_other_workspace_roots_and_raw_ids() {
    let temp = tempfile::tempdir().expect("create restricted MCP fixture");
    let workspace_a = temp.path().join("workspace-a");
    let workspace_b = temp.path().join("workspace-b");
    std::fs::create_dir(&workspace_a).expect("create workspace A");
    std::fs::create_dir(&workspace_b).expect("create workspace B");
    let workspace_a = std::fs::canonicalize(workspace_a).expect("canonicalize workspace A");
    let workspace_b = std::fs::canonicalize(workspace_b).expect("canonicalize workspace B");
    let db = temp.path().join("kodade-memory.sqlite3");
    let store = MemoryStore::open(&db).expect("open restricted MCP fixture store");
    let registered_a = store
        .register_workspace(&workspace_a, "Workspace A", None)
        .expect("register workspace A");
    let registered_b = store
        .register_workspace(&workspace_b, "Workspace B", None)
        .expect("register workspace B");
    let memory_b = store
        .remember(NewMemory {
            workspace_id: registered_b.id,
            kind: MemoryKind::Fact,
            title: "Workspace B memory".into(),
            body: "This record must stay outside workspace A's scope.".into(),
            source: MemorySource::Agent,
            source_client: "mcp-stdio-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("seed workspace B memory");
    assert_ne!(registered_a.id, memory_b.workspace_id);

    let mut process =
        McpProcess::spawn_scoped(&db, false, "2026-07-28", Some(workspace_a.as_path()));
    for (tool, arguments) in [
        (
            "get_context",
            json!({ "workspaceRoot": workspace_b.to_string_lossy() }),
        ),
        (
            "search_memories",
            json!({
                "workspaceRoot": workspace_b.to_string_lossy(),
                "query": "Workspace B memory"
            }),
        ),
        (
            "get_memory",
            json!({
                "workspaceRoot": workspace_b.to_string_lossy(),
                "id": memory_b.id
            }),
        ),
        (
            "revise_memory",
            json!({
                "id": memory_b.id,
                "expectedVersion": 1,
                "title": "Out-of-scope revision"
            }),
        ),
        (
            "forget_memory",
            json!({ "id": memory_b.id, "expectedVersion": 1 }),
        ),
    ] {
        let denied = process.call_tool(tool, arguments);
        assert_eq!(denied["result"]["isError"], true, "tool: {tool}");
        assert_eq!(
            denied["result"]["structuredContent"]["type"], "workspace_restricted",
            "tool: {tool}"
        );
    }
}

#[test]
fn unscoped_get_memory_refuses_cross_workspace_id() {
    let temp = tempfile::tempdir().expect("create unscoped MCP fixture");
    let workspace_a = temp.path().join("workspace-a");
    let workspace_b = temp.path().join("workspace-b");
    std::fs::create_dir(&workspace_a).expect("create workspace A");
    std::fs::create_dir(&workspace_b).expect("create workspace B");
    let workspace_a = std::fs::canonicalize(workspace_a).expect("canonicalize workspace A");
    let workspace_b = std::fs::canonicalize(workspace_b).expect("canonicalize workspace B");
    let db = temp.path().join("kodade-memory.sqlite3");
    let store = MemoryStore::open(&db).expect("open unscoped MCP fixture store");
    store
        .register_workspace(&workspace_a, "Workspace A", None)
        .expect("register workspace A");
    let registered_b = store
        .register_workspace(&workspace_b, "Workspace B", None)
        .expect("register workspace B");
    let memory_b = store
        .remember(NewMemory {
            workspace_id: registered_b.id,
            kind: MemoryKind::Fact,
            title: "Workspace B memory".into(),
            body: "This record must stay outside workspace A's scope.".into(),
            source: MemorySource::Agent,
            source_client: "mcp-stdio-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("seed workspace B memory");

    let mut process = McpProcess::spawn(&db, false, "2026-07-28");
    let denied = process.call_tool(
        "get_memory",
        json!({
            "workspaceRoot": workspace_a.to_string_lossy(),
            "id": memory_b.id
        }),
    );
    assert_eq!(denied["result"]["isError"], true);
    assert_eq!(
        denied["result"]["structuredContent"]["type"],
        "memory_not_found"
    );
}

#[test]
fn checkpoint_rejects_next_action_item_and_aggregate_size_breaches() {
    let (_temp, db, workspace) = registered_store();
    let root = workspace.to_string_lossy();
    let mut process = McpProcess::spawn(&db, false, "2026-07-28");

    let oversized_item = process.call_tool(
        "checkpoint",
        json!({
            "workspaceRoot": root,
            "summary": "Reject one oversized next action.",
            "nextActions": ["x".repeat(3_000)]
        }),
    );
    assert_eq!(oversized_item["result"]["isError"], true);
    assert_eq!(
        oversized_item["result"]["structuredContent"]["type"],
        "size_limit"
    );
    assert_eq!(
        oversized_item["result"]["structuredContent"]["maxCharactersPerItem"],
        2_000
    );

    let aggregate_breach = process.call_tool(
        "checkpoint",
        json!({
            "workspaceRoot": root,
            "summary": "Reject an oversized next action aggregate.",
            "nextActions": vec!["y".repeat(2_000); 9]
        }),
    );
    assert_eq!(aggregate_breach["result"]["isError"], true);
    assert_eq!(
        aggregate_breach["result"]["structuredContent"]["type"],
        "size_limit"
    );
    assert_eq!(
        aggregate_breach["result"]["structuredContent"]["maxBytes"],
        16 * 1024
    );

    for (field, value, expected_limit) in [
        ("decisions", "d".repeat(2_001), 2_000),
        ("changedPaths", "p".repeat(4_097), 4_096),
    ] {
        let rejected = process.call_tool(
            "checkpoint",
            json!({
                "workspaceRoot": root,
                "summary": format!("Reject oversized {field}."),
                (field): [value]
            }),
        );
        assert_eq!(rejected["result"]["isError"], true);
        assert_eq!(rejected["result"]["structuredContent"]["field"], field);
        assert_eq!(
            rejected["result"]["structuredContent"]["maxCharactersPerItem"],
            expected_limit
        );
    }
}

#[test]
fn secret_split_across_fields_in_one_call_is_rejected() {
    let (_temp, db, workspace) = registered_store();
    let mut process = McpProcess::spawn(&db, false, "2026-07-28");

    let rejected = process.call_tool(
        "remember",
        json!({
            "workspaceRoot": workspace.to_string_lossy(),
            "kind": "fact",
            "title": "api_key=",
            "body": "abcdefghijklmnop"
        }),
    );
    assert_eq!(rejected["result"]["isError"], true);
    assert_eq!(
        rejected["result"]["structuredContent"]["type"],
        "secret_detected"
    );
}

#[test]
fn search_memories_offset_walks_past_the_first_page() {
    let (_temp, db, workspace) = registered_store();
    let root = workspace.to_string_lossy();
    let mut process = McpProcess::spawn(&db, false, "2026-07-28");
    for index in 1..=3 {
        let created = process.call_tool(
            "remember",
            json!({
                "workspaceRoot": root,
                "kind": "fact",
                "title": format!("Offset fixture {index}"),
                "body": "Shared offset pagination marker."
            }),
        );
        assert_eq!(created["result"]["isError"], false);
    }

    let first_page = process.call_tool(
        "search_memories",
        json!({
            "workspaceRoot": root,
            "query": "offset pagination marker",
            "limit": 2
        }),
    );
    let third = process.call_tool(
        "search_memories",
        json!({
            "workspaceRoot": root,
            "query": "offset pagination marker",
            "limit": 2,
            "offset": 2
        }),
    );
    assert_eq!(third["result"]["isError"], false);
    assert_eq!(third["result"]["structuredContent"]["total"], 3);
    assert_eq!(third["result"]["structuredContent"]["offset"], 2);
    assert_eq!(
        third["result"]["structuredContent"]["items"]
            .as_array()
            .expect("offset page items")
            .len(),
        1
    );
    let third_id = &third["result"]["structuredContent"]["items"][0]["id"];
    assert!(first_page["result"]["structuredContent"]["items"]
        .as_array()
        .expect("first page items")
        .iter()
        .all(|item| &item["id"] != third_id));
}
