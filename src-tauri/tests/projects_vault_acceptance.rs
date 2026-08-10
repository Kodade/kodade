use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use kodade_lib::memory::{
    MemoryKind, MemoryLink, MemoryQuery, MemorySource, MemoryStore, NewCheckpoint, NewMemory,
    Workspace,
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use serde_json::{json, Value};

const PROJECT_ID: &str = "acceptance-project";

struct MappedFixture {
    _temp: TempDir,
    vault: PathBuf,
    checkout: PathBuf,
    db: PathBuf,
    store: MemoryStore,
    workspace: Workspace,
}

struct McpProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr: Option<ChildStderr>,
    next_id: u64,
}

#[derive(Debug, PartialEq)]
struct SemanticSnapshot {
    project_id: String,
    checkpoint_summary: String,
    checkpoint_decisions: Vec<String>,
    checkpoint_next_actions: Vec<String>,
    checkpoint_changed_paths: Vec<String>,
    decision_title: String,
    decision_body: String,
    decision_kind: MemoryKind,
    decision_pinned: bool,
    decision_links: Vec<String>,
    fact_title: String,
    fact_body: String,
    fact_kind: MemoryKind,
}

impl MappedFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("create acceptance fixture");
        let vault = temp.path().join("machine-a-vault");
        fs::create_dir_all(vault.join(".obsidian")).expect("create Obsidian vault");
        fs::create_dir(vault.join("10-Projects")).expect("create project lane");
        let checkout = temp.path().join("machine-a-checkout");
        fs::create_dir(&checkout).expect("create checkout");
        let checkout = fs::canonicalize(checkout).expect("canonicalize checkout");
        let db = temp.path().join("machine-a.sqlite3");
        let store = MemoryStore::open(&db).expect("open machine A store");
        store
            .register_projects_vault(&vault)
            .expect("register projects vault");
        let workspace = store
            .register_workspace(&checkout, "Acceptance project", None)
            .expect("register machine A workspace");
        store
            .map_workspace_to_project(&workspace.id, None, PROJECT_ID, "Acceptance project")
            .expect("map machine A workspace");
        let plan = store
            .preview_project_scaffold(&workspace.id)
            .expect("preview canonical scaffold");
        store
            .apply_project_scaffold(&workspace.id, &plan.fingerprint)
            .expect("apply canonical scaffold");
        Self {
            _temp: temp,
            vault: fs::canonicalize(vault).expect("canonicalize projects vault"),
            checkout,
            db,
            store,
            workspace,
        }
    }

    fn project_root(&self) -> PathBuf {
        self.vault.join("10-Projects").join(PROJECT_ID)
    }
}

impl McpProcess {
    fn spawn(db: &Path, workspace: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kodade-mcp"))
            .arg("--db")
            .arg(db)
            .arg("--client")
            .arg("projects-vault-acceptance")
            .arg("--workspace")
            .arg(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn scoped KödMCP");
        let stdin = child.stdin.take().expect("capture KödMCP stdin");
        let stdout = BufReader::new(child.stdout.take().expect("capture KödMCP stdout"));
        let stderr = child.stderr.take().expect("capture KödMCP stderr");
        let mut process = Self {
            child,
            stdin: Some(stdin),
            stdout,
            stderr: Some(stderr),
            next_id: 1,
        };
        let initialized = process.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "projects-vault-acceptance", "version": "1" }
            }),
        );
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        process.write(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }));
        process
    }

    fn call_tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        let mut line = String::new();
        self.stdout
            .read_line(&mut line)
            .expect("read KödMCP response");
        assert!(!line.is_empty(), "KödMCP closed before responding");
        let response: Value = serde_json::from_str(&line).expect("parse KödMCP response");
        assert_eq!(response["id"], id);
        response
    }

    fn write(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().expect("KödMCP stdin remains open");
        writeln!(stdin, "{message}").expect("write KödMCP request");
        stdin.flush().expect("flush KödMCP request");
    }

    fn finish(mut self) -> String {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        let mut stderr = String::new();
        self.stderr
            .take()
            .expect("KödMCP stderr")
            .read_to_string(&mut stderr)
            .expect("read KödMCP stderr");
        stderr
    }
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn fresh_machine_and_corrupt_index_rebuild_exact_canonical_semantics() {
    let machine_a = MappedFixture::new();
    let fact = machine_a
        .store
        .remember(NewMemory {
            workspace_id: machine_a.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Portable acceptance fact".into(),
            body: "canonical-fact-beacon".into(),
            source: MemorySource::User,
            source_client: "acceptance-machine-a".into(),
            session_id: Some("acceptance-seed".into()),
            pinned: false,
            idempotency_key: Some("acceptance-fact".into()),
            links: Vec::new(),
        })
        .expect("write canonical fact");
    machine_a
        .store
        .remember(NewMemory {
            workspace_id: machine_a.workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Portable acceptance decision".into(),
            body: "canonical-decision-beacon".into(),
            source: MemorySource::Agent,
            source_client: "acceptance-machine-a".into(),
            session_id: Some("acceptance-seed".into()),
            pinned: true,
            idempotency_key: Some("acceptance-decision".into()),
            links: vec![MemoryLink {
                target_id: fact.id,
                relation: "supports".into(),
            }],
        })
        .expect("write canonical decision");
    let state_hash = file_hash(&machine_a.project_root().join("STATE.md"));
    machine_a
        .store
        .checkpoint_with_state_hash(
            NewCheckpoint {
                workspace_id: machine_a.workspace.id.clone(),
                summary: "Portable acceptance checkpoint".into(),
                decisions: vec!["Keep Markdown canonical".into()],
                next_actions: vec!["Rebuild on another machine".into()],
                changed_paths: vec!["src/portable.rs".into()],
                source: MemorySource::Agent,
                source_client: "acceptance-machine-a".into(),
                session_id: Some("acceptance-seed".into()),
                idempotency_key: Some("acceptance-checkpoint".into()),
            },
            Some(&state_hash),
        )
        .expect("write canonical checkpoint");

    let expected = SemanticSnapshot {
        project_id: PROJECT_ID.into(),
        checkpoint_summary: "Portable acceptance checkpoint".into(),
        checkpoint_decisions: vec!["Keep Markdown canonical".into()],
        checkpoint_next_actions: vec!["Rebuild on another machine".into()],
        checkpoint_changed_paths: vec!["src/portable.rs".into()],
        decision_title: "Portable acceptance decision".into(),
        decision_body: "canonical-decision-beacon".into(),
        decision_kind: MemoryKind::Decision,
        decision_pinned: true,
        decision_links: vec!["supports".into()],
        fact_title: "Portable acceptance fact".into(),
        fact_body: "canonical-fact-beacon".into(),
        fact_kind: MemoryKind::Fact,
    };
    assert_eq!(
        semantic_snapshot(&machine_a.store, &machine_a.workspace),
        expected
    );

    let machine_b = tempfile::tempdir().expect("create machine B");
    let vault_b = machine_b.path().join("machine-b-vault");
    copy_tree(&machine_a.vault, &vault_b);
    let canonical_before = tree_hash(&vault_b);
    let checkout_b = machine_b.path().join("machine-b-checkout");
    fs::create_dir(&checkout_b).expect("create machine B checkout");
    let checkout_b = fs::canonicalize(checkout_b).expect("canonicalize machine B checkout");
    let db_b = machine_b.path().join("machine-b.sqlite3");
    let store_b = MemoryStore::open(&db_b).expect("open empty machine B store");
    let discovered = store_b
        .register_projects_vault(&vault_b)
        .expect("discover copied vault");
    assert!(discovered
        .projects
        .iter()
        .any(|project| project.id == PROJECT_ID));
    let workspace_b = store_b
        .register_workspace(&checkout_b, "Machine B checkout", None)
        .expect("register machine B workspace");
    store_b
        .map_workspace_to_project(&workspace_b.id, None, PROJECT_ID, "Acceptance project")
        .expect("relink portable identity on machine B");
    store_b
        .rebuild_project_from_markdown(&workspace_b.id)
        .expect("rebuild empty projection");
    assert_eq!(semantic_snapshot(&store_b, &workspace_b), expected);
    assert_eq!(tree_hash(&vault_b), canonical_before);
    let markdown = read_markdown_tree(&vault_b);
    assert!(!markdown.contains(machine_a.checkout.to_string_lossy().as_ref()));
    assert!(!markdown.contains(checkout_b.to_string_lossy().as_ref()));
    drop(store_b);

    fs::write(&db_b, b"not a sqlite database\0acceptance corruption")
        .expect("corrupt derived machine B database");
    let recovered = MemoryStore::open(&db_b).expect("recover corrupt derived store");
    let backup = recovered
        .recovery_backup()
        .expect("preserve corrupt derived database");
    assert_eq!(
        fs::read(backup).expect("read corrupt backup"),
        b"not a sqlite database\0acceptance corruption"
    );
    recovered
        .register_projects_vault(&vault_b)
        .expect("re-register vault after DB recovery");
    let recovered_workspace = recovered
        .register_workspace(&checkout_b, "Recovered machine B checkout", None)
        .expect("re-register checkout after DB recovery");
    recovered
        .map_workspace_to_project(
            &recovered_workspace.id,
            None,
            PROJECT_ID,
            "Acceptance project",
        )
        .expect("relink project after DB recovery");
    recovered
        .rebuild_project_from_markdown(&recovered_workspace.id)
        .expect("rebuild corrupt projection from Markdown");
    assert_eq!(
        semantic_snapshot(&recovered, &recovered_workspace),
        expected
    );
    assert_eq!(tree_hash(&vault_b), canonical_before);
}

#[test]
fn two_processes_force_overlap_and_preserve_distinct_checkpoints_exactly_once() {
    let machine_a = MappedFixture::new();
    let machine_b = tempfile::tempdir().expect("create second writer store");
    let checkout_b = machine_b.path().join("writer-b-checkout");
    fs::create_dir(&checkout_b).expect("create writer B checkout");
    let checkout_b = fs::canonicalize(checkout_b).expect("canonicalize writer B checkout");
    let db_b = machine_b.path().join("writer-b.sqlite3");
    let store_b = MemoryStore::open(&db_b).expect("open writer B store");
    store_b
        .register_projects_vault(&machine_a.vault)
        .expect("register shared vault for writer B");
    let workspace_b = store_b
        .register_workspace(&checkout_b, "Writer B", None)
        .expect("register writer B workspace");
    store_b
        .map_workspace_to_project(&workspace_b.id, None, PROJECT_ID, "Acceptance project")
        .expect("map writer B to shared project");
    drop(store_b);

    let start_a = machine_b.path().join("writer-a-started");
    let ready_a = machine_b.path().join("writer-a-locked");
    let release_a = machine_b.path().join("writer-a-release");
    let result_a = machine_b.path().join("writer-a-result");
    let start_b = machine_b.path().join("writer-b-started");
    let contended_b = machine_b.path().join("writer-b-contended");
    let ready_b = machine_b.path().join("writer-b-locked");
    let release_b = machine_b.path().join("writer-b-release");
    let result_b = machine_b.path().join("writer-b-result");
    fs::write(&release_b, b"release").expect("pre-release writer B after it acquires lock");

    let mut writer_a = checkpoint_child_command(
        &machine_a.db,
        &machine_a.workspace.id,
        "Concurrent writer A",
        "acceptance-concurrent-a",
        &start_a,
        &ready_a,
        &release_a,
        &result_a,
    )
    .spawn()
    .expect("spawn writer A");
    wait_for_path(
        &ready_a,
        &mut writer_a,
        "writer A lock",
        Duration::from_secs(10),
    );

    let mut writer_b_command = checkpoint_child_command(
        &db_b,
        &workspace_b.id,
        "Concurrent writer B",
        "acceptance-concurrent-b",
        &start_b,
        &ready_b,
        &release_b,
        &result_b,
    );
    writer_b_command.env("KODADE_TEST_PORTABLE_LOCK_EXPECT_CONTENDED", &contended_b);
    let mut writer_b = writer_b_command.spawn().expect("spawn writer B");
    wait_for_path(
        &start_b,
        &mut writer_b,
        "writer B start",
        Duration::from_secs(10),
    );
    wait_for_path(
        &contended_b,
        &mut writer_b,
        "writer B real lock contention",
        Duration::from_secs(10),
    );
    assert!(
        !ready_b.exists(),
        "writer B remains outside the acquired-lock barrier"
    );

    fs::write(&release_a, b"release").expect("release writer A");
    wait_for_child(writer_a, "writer A", Duration::from_secs(10));
    wait_for_child(writer_b, "writer B", Duration::from_secs(10));
    assert_eq!(
        fs::read_to_string(&result_a).unwrap(),
        "Concurrent writer A"
    );
    assert_eq!(
        fs::read_to_string(&result_b).unwrap(),
        "Concurrent writer B"
    );

    let worklog = read_markdown_tree(&machine_a.project_root().join("Worklog"));
    assert_eq!(
        worklog
            .matches("\"summary\":\"Concurrent writer A\"")
            .count(),
        1
    );
    assert_eq!(
        worklog
            .matches("\"summary\":\"Concurrent writer B\"")
            .count(),
        1
    );
    assert_eq!(worklog.matches("<!-- kodmem-checkpoint {").count(), 2);

    machine_a
        .store
        .checkpoint_with_authority(
            checkpoint_input(
                &machine_a.workspace.id,
                "Concurrent writer A",
                "acceptance-concurrent-a",
            ),
            false,
            None,
        )
        .expect("retry writer A checkpoint");
    let reopened_b = MemoryStore::open(&db_b).expect("reopen writer B store");
    reopened_b
        .checkpoint_with_authority(
            checkpoint_input(
                &workspace_b.id,
                "Concurrent writer B",
                "acceptance-concurrent-b",
            ),
            false,
            None,
        )
        .expect("retry writer B checkpoint");
    let retried_worklog = read_markdown_tree(&machine_a.project_root().join("Worklog"));
    assert_eq!(
        retried_worklog
            .matches("\"summary\":\"Concurrent writer A\"")
            .count(),
        1
    );
    assert_eq!(
        retried_worklog
            .matches("\"summary\":\"Concurrent writer B\"")
            .count(),
        1
    );
    assert_eq!(
        retried_worklog.matches("<!-- kodmem-checkpoint {").count(),
        2
    );
    assert!(!portable_journal_path(&machine_a.project_root()).exists());
    assert!(walk_files(&machine_a.project_root()).iter().all(|path| {
        !path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with(".kodmem")
    }));
}

#[test]
fn obsidian_edit_after_hash_read_conflicts_then_retries_with_reconciled_state() {
    let fixture = MappedFixture::new();
    let mut mcp = McpProcess::spawn(&fixture.db, &fixture.checkout);
    let root = fixture.checkout.to_string_lossy();
    let context = mcp.call_tool("get_context", json!({ "workspaceRoot": root }));
    let stale_hash = state_source_hash(&context);
    let state_path = fixture.project_root().join("STATE.md");
    let mut human_state = fs::read_to_string(&state_path).expect("read state before Obsidian edit");
    human_state.push_str("\nObsidian human edit: preserve-the-cedar-note.\n");
    fs::write(&state_path, &human_state).expect("write direct Obsidian edit");

    let stale = mcp.call_tool(
        "checkpoint",
        json!({
            "workspaceRoot": root,
            "summary": "Reconcile preserve-the-cedar-note",
            "nextActions": ["Continue after reconciling the human edit"],
            "idempotencyKey": "acceptance-obsidian-race",
            "expectedStateHash": stale_hash
        }),
    );
    assert_eq!(stale["result"]["isError"], true);
    assert_eq!(
        stale["result"]["structuredContent"]["type"],
        "content_conflict"
    );
    assert_eq!(
        fs::read_to_string(&state_path).expect("read conflicted state"),
        human_state
    );
    assert!(!portable_journal_path(&fixture.project_root()).exists());
    assert_eq!(
        read_markdown_tree(&fixture.project_root().join("Worklog"))
            .matches("<!-- kodmem-checkpoint {")
            .count(),
        0
    );

    let refreshed = mcp.call_tool("get_context", json!({ "workspaceRoot": root }));
    let fresh_hash = state_source_hash(&refreshed);
    assert_ne!(fresh_hash, stale_hash);
    assert_eq!(fresh_hash, file_hash(&state_path));
    let retry = mcp.call_tool(
        "checkpoint",
        json!({
            "workspaceRoot": root,
            "summary": "Reconciled Obsidian edit: preserve-the-cedar-note",
            "nextActions": ["Continue from the reconciled state"],
            "idempotencyKey": "acceptance-obsidian-race",
            "expectedStateHash": fresh_hash
        }),
    );
    assert_eq!(retry["result"]["isError"], false);
    assert!(fs::read_to_string(&state_path)
        .expect("read reconciled state")
        .contains("preserve-the-cedar-note"));
    assert_eq!(
        read_markdown_tree(&fixture.project_root().join("Worklog"))
            .matches("<!-- kodmem-checkpoint {")
            .count(),
        1
    );
    assert!(!portable_journal_path(&fixture.project_root()).exists());
    let stderr = mcp.finish();
    assert!(!stderr.contains(fixture.vault.to_string_lossy().as_ref()));
}

#[test]
fn scoped_mcp_isolates_projects_and_rejected_secrets_leave_zero_residue() {
    let fixture = MappedFixture::new();
    let alpha_state = fixture.project_root().join("STATE.md");
    fs::write(&alpha_state, "# Alpha state\n\nalpha-only-orchid\n")
        .expect("write alpha state sentinel");

    let beta_checkout = fixture._temp.path().join("beta-checkout");
    fs::create_dir(&beta_checkout).expect("create beta checkout");
    let beta_checkout = fs::canonicalize(beta_checkout).expect("canonicalize beta checkout");
    let beta_workspace = fixture
        .store
        .register_workspace(&beta_checkout, "Beta project", None)
        .expect("register beta workspace");
    fixture
        .store
        .map_workspace_to_project(&beta_workspace.id, None, "beta-project", "Beta project")
        .expect("map beta project");
    let beta_plan = fixture
        .store
        .preview_project_scaffold(&beta_workspace.id)
        .expect("preview beta scaffold");
    fixture
        .store
        .apply_project_scaffold(&beta_workspace.id, &beta_plan.fingerprint)
        .expect("apply beta scaffold");
    let beta_root = fixture.vault.join("10-Projects/beta-project");
    fs::write(
        beta_root.join("STATE.md"),
        "# Beta state\n\nbeta-only-lantern\n",
    )
    .expect("write beta state sentinel");
    let beta_record = fixture
        .store
        .remember(NewMemory {
            workspace_id: beta_workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Beta private fact".into(),
            body: "beta-only-record".into(),
            source: MemorySource::Agent,
            source_client: "acceptance-beta".into(),
            session_id: Some("beta-session".into()),
            pinned: false,
            idempotency_key: Some("acceptance-beta-record".into()),
            links: Vec::new(),
        })
        .expect("write beta record");
    let alpha_before = tree_hash(&fixture.project_root());
    let beta_before = tree_hash(&beta_root);

    let mut mcp = McpProcess::spawn(&fixture.db, &fixture.checkout);
    let alpha_root = fixture.checkout.to_string_lossy();
    let beta_checkout_text = beta_checkout.to_string_lossy();
    let mut responses = Vec::new();
    let alpha_context = mcp.call_tool("get_context", json!({ "workspaceRoot": alpha_root }));
    assert!(alpha_context.to_string().contains("alpha-only-orchid"));
    assert!(!alpha_context.to_string().contains("beta-only-lantern"));
    responses.push(alpha_context);

    let beta_search = mcp.call_tool(
        "search_memories",
        json!({
            "workspaceRoot": alpha_root,
            "query": "beta-only-record"
        }),
    );
    assert_eq!(beta_search["result"]["structuredContent"]["total"], 0);
    responses.push(beta_search);

    for denied in [
        mcp.call_tool(
            "get_context",
            json!({ "workspaceRoot": beta_checkout_text }),
        ),
        mcp.call_tool(
            "checkpoint",
            json!({
                "workspaceRoot": beta_checkout_text,
                "summary": "Cross-project checkpoint must fail",
                "updateState": false,
                "idempotencyKey": "acceptance-cross-project-checkpoint"
            }),
        ),
        mcp.call_tool(
            "revise_memory",
            json!({
                "id": beta_record.id,
                "expectedVersion": beta_record.version,
                "expectedContentHash": beta_record.project_source.as_ref().unwrap().sha256,
                "body": "Cross-project revision must fail"
            }),
        ),
    ] {
        assert_eq!(denied["result"]["isError"], true);
        assert_eq!(
            denied["result"]["structuredContent"]["type"],
            "workspace_restricted"
        );
        responses.push(denied);
    }
    assert_eq!(tree_hash(&fixture.project_root()), alpha_before);
    assert_eq!(tree_hash(&beta_root), beta_before);

    let secret_seed = format!(
        "{}:{}:{:?}",
        std::process::id(),
        fixture.workspace.id,
        Instant::now()
    );
    let secret_digest = format!("{:x}", Sha256::digest(secret_seed.as_bytes()));
    let secret = format!("ghp_{}", &secret_digest[..36]);
    let secret_hash = format!("{:x}", Sha256::digest(secret.as_bytes()));
    let rejected_memory = mcp.call_tool(
        "remember",
        json!({
            "workspaceRoot": alpha_root,
            "kind": "fact",
            "title": "Synthetic credential",
            "body": secret,
            "idempotencyKey": "acceptance-secret-memory"
        }),
    );
    assert_eq!(
        rejected_memory["result"]["structuredContent"]["type"],
        "secret_detected"
    );
    responses.push(rejected_memory);
    let rejected_checkpoint = mcp.call_tool(
        "checkpoint",
        json!({
            "workspaceRoot": alpha_root,
            "summary": secret,
            "updateState": false,
            "idempotencyKey": "acceptance-secret-checkpoint"
        }),
    );
    assert_eq!(
        rejected_checkpoint["result"]["structuredContent"]["type"],
        "secret_detected"
    );
    responses.push(rejected_checkpoint);

    let secret_search = mcp.call_tool(
        "search_memories",
        json!({
            "workspaceRoot": alpha_root,
            "query": secret
        }),
    );
    assert_eq!(secret_search["result"]["structuredContent"]["total"], 0);
    assert!(!secret_search.to_string().contains(&secret));
    responses.push(secret_search);
    let context_after_rejection =
        mcp.call_tool("get_context", json!({ "workspaceRoot": alpha_root }));
    assert!(!context_after_rejection.to_string().contains(&secret));
    responses.push(context_after_rejection);
    let stderr = mcp.finish();

    assert_eq!(tree_hash(&fixture.project_root()), alpha_before);
    assert_eq!(tree_hash(&beta_root), beta_before);
    assert!(!portable_journal_path(&fixture.project_root()).exists());
    assert!(!portable_journal_path(&beta_root).exists());
    let _residue_connection = rusqlite::Connection::open(&fixture.db)
        .expect("hold the derived store open while scanning journal surfaces");
    _residue_connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA user_version = 1;")
        .expect("materialize safe SQLite WAL and shared-memory surfaces");
    let wal_path = PathBuf::from(format!("{}-wal", fixture.db.display()));
    let shm_path = PathBuf::from(format!("{}-shm", fixture.db.display()));
    assert!(
        wal_path.is_file(),
        "acceptance must scan the live SQLite WAL"
    );
    assert!(
        shm_path.is_file(),
        "acceptance must scan SQLite shared memory"
    );
    let backup_path = fixture._temp.path().join("derived-store-backup.sqlite3");
    fs::copy(&fixture.db, &backup_path).expect("create derived-store backup surface");
    assert!(backup_path.is_file());

    let evidence = json!({
        "schema": 1,
        "scenario": "secret-residue",
        "secretSha256": secret_hash,
        "matches": 0,
        "releaseProof": {
            "packaged": "not-run",
            "installedOwnerAcceptance": "not-run"
        }
    });
    let evidence_path = fixture._temp.path().join("acceptance-evidence.json");
    fs::write(
        &evidence_path,
        serde_json::to_vec_pretty(&evidence).expect("serialize evidence"),
    )
    .expect("write evidence fixture");
    let mut surfaces = Vec::new();
    collect_file_surfaces("vault", &fixture.vault, &mut surfaces);
    collect_file_surfaces("store", fixture._temp.path(), &mut surfaces);
    for path in portable_project_runtime_files(&fixture.project_root())
        .into_iter()
        .chain(portable_project_runtime_files(&beta_root))
    {
        surfaces.push((
            "runtime".into(),
            fs::read(path).expect("read runtime artifact"),
        ));
    }
    surfaces.push((
        "audit".into(),
        format!(
            "{:?}{:?}",
            fixture.store.audit(&fixture.workspace.id, 100).unwrap(),
            fixture.store.audit(&beta_workspace.id, 100).unwrap()
        )
        .into_bytes(),
    ));
    surfaces.push((
        "errors".into(),
        serde_json::to_vec(&responses).expect("serialize MCP responses"),
    ));
    surfaces.push(("stderr".into(), stderr.into_bytes()));
    surfaces.push((
        "evidence".into(),
        fs::read(evidence_path).expect("read evidence fixture"),
    ));
    for (label, bytes) in surfaces {
        assert!(
            !bytes
                .windows(secret.len())
                .any(|window| window == secret.as_bytes()),
            "synthetic secret survived in {label}"
        );
    }
}

fn state_source_hash(context: &Value) -> String {
    context["result"]["structuredContent"]["projectKnowledge"]["sources"]
        .as_array()
        .expect("mapped context sources")
        .iter()
        .find(|source| source["kind"] == "state")
        .and_then(|source| source["sha256"].as_str())
        .expect("mapped state hash")
        .to_string()
}

fn collect_file_surfaces(label: &str, root: &Path, surfaces: &mut Vec<(String, Vec<u8>)>) {
    for path in walk_files(root) {
        surfaces.push((
            format!(
                "{label}:{}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
            fs::read(path).expect("read residue surface"),
        ));
    }
}

fn portable_project_runtime_files(project_root: &Path) -> Vec<PathBuf> {
    let canonical = fs::canonicalize(project_root).expect("canonicalize runtime project");
    let key = format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    );
    walk_files(&portable_runtime_root())
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&key))
        })
        .collect()
}

#[test]
fn projects_vault_checkpoint_child_process_helper() {
    let Ok(db) = std::env::var("KODADE_ACCEPTANCE_CHILD_DB") else {
        return;
    };
    let workspace_id = std::env::var("KODADE_ACCEPTANCE_CHILD_WORKSPACE").unwrap();
    let summary = std::env::var("KODADE_ACCEPTANCE_CHILD_SUMMARY").unwrap();
    let key = std::env::var("KODADE_ACCEPTANCE_CHILD_KEY").unwrap();
    let start = PathBuf::from(std::env::var("KODADE_ACCEPTANCE_CHILD_START").unwrap());
    let result = PathBuf::from(std::env::var("KODADE_ACCEPTANCE_CHILD_RESULT").unwrap());
    fs::write(start, b"started").expect("signal child started");
    let store = MemoryStore::open(db).expect("child opens store");
    store
        .checkpoint_with_authority(checkpoint_input(&workspace_id, &summary, &key), false, None)
        .expect("child writes checkpoint");
    fs::write(result, summary).expect("record child result");
}

fn checkpoint_input(workspace_id: &str, summary: &str, key: &str) -> NewCheckpoint {
    NewCheckpoint {
        workspace_id: workspace_id.into(),
        summary: summary.into(),
        decisions: Vec::new(),
        next_actions: vec!["Continue concurrent acceptance".into()],
        changed_paths: vec!["src/concurrent.rs".into()],
        source: MemorySource::Agent,
        source_client: "projects-vault-acceptance".into(),
        session_id: Some(key.into()),
        idempotency_key: Some(key.into()),
    }
}

#[allow(clippy::too_many_arguments)]
fn checkpoint_child_command(
    db: &Path,
    workspace_id: &str,
    summary: &str,
    key: &str,
    start: &Path,
    ready: &Path,
    release: &Path,
    result: &Path,
) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("acceptance test executable"));
    command
        .arg("--exact")
        .arg("projects_vault_checkpoint_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_ACCEPTANCE_CHILD_DB", db)
        .env("KODADE_ACCEPTANCE_CHILD_WORKSPACE", workspace_id)
        .env("KODADE_ACCEPTANCE_CHILD_SUMMARY", summary)
        .env("KODADE_ACCEPTANCE_CHILD_KEY", key)
        .env("KODADE_ACCEPTANCE_CHILD_START", start)
        .env("KODADE_ACCEPTANCE_CHILD_RESULT", result)
        .env("KODADE_TEST_PORTABLE_LOCK_READY", ready)
        .env("KODADE_TEST_PORTABLE_LOCK_RELEASE", release)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    command
}

fn wait_for_path(path: &Path, child: &mut Child, label: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return;
        }
        if let Some(status) = child.try_wait().expect("poll child") {
            panic!("{label} child exited early with {status}");
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("timed out waiting for {label}");
}

fn wait_for_child(mut child: Child, label: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("poll child") {
            assert!(status.success(), "{label} exited with {status}");
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("timed out waiting for {label}");
}

fn semantic_snapshot(store: &MemoryStore, workspace: &Workspace) -> SemanticSnapshot {
    let context = store.context(&workspace.id).expect("load mapped context");
    let project_id = context
        .project_knowledge
        .expect("mapped project context")
        .project_id;
    let checkpoint = context.latest_checkpoint.expect("latest checkpoint");
    let decision = search_one(store, workspace, "canonical-decision-beacon");
    let fact = search_one(store, workspace, "canonical-fact-beacon");
    SemanticSnapshot {
        project_id,
        checkpoint_summary: checkpoint.summary,
        checkpoint_decisions: checkpoint.decisions,
        checkpoint_next_actions: checkpoint.next_actions,
        checkpoint_changed_paths: checkpoint.changed_paths,
        decision_title: decision.title,
        decision_body: decision.body,
        decision_kind: decision.kind,
        decision_pinned: decision.pinned,
        decision_links: decision
            .links
            .into_iter()
            .map(|link| link.relation)
            .collect(),
        fact_title: fact.title,
        fact_body: fact.body,
        fact_kind: fact.kind,
    }
}

fn search_one(
    store: &MemoryStore,
    workspace: &Workspace,
    text: &str,
) -> kodade_lib::memory::MemoryRecord {
    let page = store
        .search(MemoryQuery {
            workspace_id: workspace.id.clone(),
            text: text.into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 10,
            offset: 0,
        })
        .expect("search rebuilt projection");
    assert_eq!(page.total, 1, "expected one search hit for {text}");
    store.memory(&page.items[0].id).expect("load search hit")
}

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir(destination).expect("create copied vault root");
    for entry in fs::read_dir(source).expect("read source tree") {
        let entry = entry.expect("read source entry");
        let file_type = entry.file_type().expect("read source file type");
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target);
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).expect("copy source file");
        } else {
            panic!("acceptance source tree contains a non-regular entry");
        }
    }
}

fn read_markdown_tree(root: &Path) -> String {
    walk_files(root)
        .into_iter()
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("md"))
        .map(|path| fs::read_to_string(path).expect("read Markdown"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn tree_hash(root: &Path) -> String {
    let hashes = walk_files(root)
        .into_iter()
        .map(|path| {
            let relative = path.strip_prefix(root).expect("relative tree path");
            (
                relative.to_string_lossy().replace('\\', "/"),
                file_hash(&path),
            )
        })
        .collect::<BTreeMap<_, _>>();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&hashes).expect("serialize tree hashes"))
    )
}

fn portable_runtime_root() -> PathBuf {
    let policy: serde_json::Value = serde_json::from_str(include_str!(
        "../../resources/kodmem/portable-authority.json"
    ))
    .expect("parse portable runtime policy");
    std::env::temp_dir().join(
        policy["lockNamespace"]
            .as_str()
            .expect("portable lock namespace"),
    )
}

fn portable_journal_path(project_root: &Path) -> PathBuf {
    let policy: serde_json::Value = serde_json::from_str(include_str!(
        "../../resources/kodmem/portable-authority.json"
    ))
    .expect("parse portable journal policy");
    let canonical = fs::canonicalize(project_root).expect("canonicalize project root");
    let key = format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    );
    portable_runtime_root().join(format!(
        "{}-{}",
        key,
        policy["journalFile"]
            .as_str()
            .expect("portable journal filename")
    ))
}

fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !root.exists() {
        return files;
    }
    for entry in fs::read_dir(root).expect("read tree") {
        let entry = entry.expect("read tree entry");
        let file_type = entry.file_type().expect("read tree entry type");
        if file_type.is_dir() {
            files.extend(walk_files(&entry.path()));
        } else if file_type.is_file() {
            files.push(entry.path());
        } else {
            panic!("acceptance tree contains a non-regular entry");
        }
    }
    files.sort();
    files
}

fn file_hash(path: &Path) -> String {
    format!(
        "{:x}",
        Sha256::digest(fs::read(path).expect("read hash input"))
    )
}
