use std::fs::{File, FileTimes, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use kodade_lib::memory::{
    ActivityKind, AuditQuery, CheckpointQuery, DeletedMemoryQuery, MemoryError, MemoryKind,
    MemoryLink, MemoryQuery, MemoryRevision, MemorySource, MemoryStore, MutationProvenance,
    NewActivity, NewCheckpoint, NewMemory, ProjectKnowledgeSyncStatus, RetentionSettings,
    WorkingMemoryMode, Workspace,
};
use sha2::{Digest, Sha256};

struct TempProject {
    dir: PathBuf,
}

struct MappedProjectsVault {
    _app_data: TempProject,
    _vault: TempProject,
    vault_root: PathBuf,
    checkout: PathBuf,
    store: MemoryStore,
    workspace: Workspace,
}

impl MappedProjectsVault {
    fn new(name: &str, project_display_name: &str) -> Self {
        let vault = TempProject::new(&format!("{name}-vault"));
        let vault_root = vault.root().to_path_buf();
        Self::with_vault_root(name, project_display_name, vault, vault_root)
    }

    fn with_vault_basename(name: &str, project_display_name: &str, basename: &str) -> Self {
        let vault = TempProject::new(&format!("{name}-vault-parent"));
        let vault_root = vault.root().join(basename);
        std::fs::create_dir(&vault_root).expect("create named vault root");
        Self::with_vault_root(name, project_display_name, vault, vault_root)
    }

    fn with_vault_root(
        name: &str,
        project_display_name: &str,
        vault: TempProject,
        vault_root: PathBuf,
    ) -> Self {
        let app_data = TempProject::new(name);
        std::fs::create_dir(vault_root.join(".obsidian")).expect("create Obsidian config");
        std::fs::create_dir(vault_root.join("10-Projects")).expect("create projects folder");
        let checkout = app_data.root().join("checkout");
        std::fs::create_dir(&checkout).expect("create checkout");
        let store = MemoryStore::open(app_data.db()).expect("open store");
        let registered_vault = store
            .register_projects_vault(&vault_root)
            .expect("register projects vault");
        let vault_root = PathBuf::from(registered_vault.canonical_root);
        let workspace = store
            .register_workspace(&checkout, "Portable project", None)
            .expect("register workspace");
        store
            .map_workspace_to_project(
                &workspace.id,
                None,
                "portable-project",
                project_display_name,
            )
            .expect("map workspace");
        Self {
            _app_data: app_data,
            _vault: vault,
            vault_root,
            checkout,
            store,
            workspace,
        }
    }

    fn project_root(&self) -> PathBuf {
        self.vault_root.join("10-Projects/portable-project")
    }
}

fn portable_journal_path(project_root: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(project_root).expect("canonical project root");
    let key = format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    );
    std::env::temp_dir()
        .join("kodade-kodmem-project-locks")
        .join(format!("{key}-.kodmem-write-journal.json"))
}

fn migration_backup_integrity(backup: &serde_json::Value) -> String {
    let payload = serde_json::json!([
        backup["schema"].clone(),
        backup["projectId"].clone(),
        backup["migrationId"].clone(),
        backup["manifestSha256"].clone(),
        backup["previewFingerprint"].clone(),
        backup["projectNoteSha256"].clone(),
        backup["projectNoteBase64"].clone(),
        backup["phase"].clone(),
        backup["plan"].clone(),
        backup["writes"].clone(),
        backup["sourceSnapshots"].clone(),
        backup["sourceFiles"].clone(),
        backup["exports"].clone(),
        backup["targets"].clone(),
    ]);
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&payload).unwrap())
    )
}

#[test]
fn activating_working_memory_creates_readable_files_and_indexes_them() {
    let project = TempProject::new("working-memory-activation");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Working memory project", None)
        .expect("register workspace");
    store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Use readable project memory".into(),
            body: "Keep working context beside the project instead of hiding it.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: true,
            idempotency_key: Some("working-memory-export".into()),
            links: Vec::new(),
        })
        .expect("seed durable memory");

    let status = store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, true)
        .expect("activate project working memory");

    assert_eq!(
        store
            .workspace_project_mapping(&workspace.id)
            .expect("read optional project mapping"),
        None,
        "unmapped workspaces keep using repo-local working memory during transition"
    );
    assert!(status.enabled);
    assert_eq!(status.mode, WorkingMemoryMode::Commit);
    assert_eq!(status.directory, ".kodade/memory");
    for relative in ["STATE.md", "WORKLOG.md", "decisions.md"] {
        assert!(project
            .root()
            .join(".kodade/memory")
            .join(relative)
            .is_file());
    }
    let imported = std::fs::read_to_string(project.root().join(".kodade/memory/MEMORIES.md"))
        .expect("optional durable-memory export");
    assert!(imported.contains("Use readable project memory"));
    assert!(!project.root().join(".gitignore").exists());

    std::fs::write(
        project.root().join(".kodade/memory/STATE.md"),
        "# Project state\n\nThe satellite migration is ready for review.\n",
    )
    .expect("edit source-of-truth state file");
    store
        .sync_working_memory(&workspace.id)
        .expect("rebuild file index");
    let page = store
        .search(MemoryQuery {
            workspace_id: workspace.id.clone(),
            text: "satellite migration".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("search indexed working-memory files");
    assert_eq!(page.total, 1);
    assert_eq!(
        page.items[0].file_path.as_deref(),
        Some(".kodade/memory/STATE.md")
    );

    let context = store
        .context(&workspace.id)
        .expect("load file-backed context");
    assert_eq!(
        context.project_knowledge, None,
        "unmapped workspaces retain the repo-local working-memory contract"
    );
    let working = context.working_memory.expect("working memory context");
    assert!(working.state.contains("satellite migration"));
    assert_eq!(working.directory, ".kodade/memory");
}

#[test]
fn declining_existing_memory_export_keeps_pre_activation_records_private() {
    let project = TempProject::new("working-memory-private-watermark");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Private projection", None)
        .expect("register workspace");
    store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Private pre-activation fact".into(),
            body: "Do not copy this record into the project files.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("private-before-activation".into()),
            links: Vec::new(),
        })
        .expect("seed private memory");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate without exporting existing memory");
    assert!(!project.root().join(".kodade/memory/MEMORIES.md").exists());
}

#[test]
fn search_rejects_offsets_that_would_require_unbounded_page_walking() {
    let project = TempProject::new("memory-search-offset-limit");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Offset limit", None)
        .expect("register workspace");

    let error = store
        .search(MemoryQuery {
            workspace_id: workspace.id,
            text: "anything".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: u32::MAX,
        })
        .expect_err("reject pathological offset");
    assert!(error.to_string().contains("offset cannot exceed 10000"));
}

#[test]
fn local_working_memory_adds_one_managed_gitignore_rule_without_clobbering_user_text() {
    let project = TempProject::new("local-working-memory");
    std::fs::write(project.root().join(".gitignore"), "target/\n").expect("seed gitignore");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Local working memory", None)
        .expect("register workspace");

    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Local, false)
        .expect("activate local-only working memory");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Local, false)
        .expect("repeated activation is idempotent");

    assert_eq!(
        std::fs::read_to_string(project.root().join(".gitignore")).expect("read gitignore"),
        "target/\n\n# BEGIN KödMem local working memory\n/.kodade/memory/\n# END KödMem local working memory\n",
    );

    std::fs::write(
        project.root().join(".gitignore"),
        "target/\n# BEGIN KödMem local working memory\n",
    )
    .expect("truncate managed block");
    let error = store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Local, false)
        .expect_err("reject malformed managed block");
    assert!(error.to_string().contains("incomplete or modified"));
}

#[cfg(unix)]
#[test]
fn activation_rejects_a_symlinked_kodade_directory_before_writing_outside_the_workspace() {
    let project = TempProject::new("working-memory-symlink");
    let outside = project.root().join("outside");
    std::fs::create_dir(&outside).expect("create outside target");
    std::os::unix::fs::symlink(&outside, project.root().join(".kodade")).expect("symlink .kodade");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Symlink project", None)
        .expect("register workspace");

    let error = store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect_err("reject symlinked working memory");

    assert!(error.to_string().contains("cannot be a symlink"));
    assert!(!outside.join("memory").exists());
}

#[cfg(unix)]
#[test]
fn activation_rejects_symlinked_required_files_and_plans() {
    for target in ["STATE.md", "plans"] {
        let project = TempProject::new(&format!("working-memory-symlink-{target}"));
        let memory = project.root().join(".kodade/memory");
        std::fs::create_dir_all(&memory).expect("create working memory directory");
        let outside = project.root().join(format!("outside-{target}"));
        if target == "plans" {
            std::fs::create_dir(&outside).expect("create outside plans target");
        } else {
            std::fs::write(&outside, "outside state remains unchanged")
                .expect("create outside state target");
        }
        std::os::unix::fs::symlink(&outside, memory.join(target)).expect("create symlink");
        let store = MemoryStore::open(project.db()).expect("open store");
        let workspace = store
            .register_workspace(project.root(), "Symlink project", None)
            .expect("register workspace");

        let error = store
            .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
            .expect_err("reject symlinked working-memory entry");

        assert!(error.to_string().contains("cannot be a symlink"));
        if target == "STATE.md" {
            assert_eq!(
                std::fs::read_to_string(&outside).expect("read outside state"),
                "outside state remains unchanged"
            );
        } else {
            assert!(std::fs::read_dir(&outside)
                .expect("read outside plans")
                .next()
                .is_none());
        }
    }
}

#[cfg(unix)]
#[test]
fn local_activation_rejects_symlinked_or_non_utf8_gitignore_files() {
    let symlink_project = TempProject::new("working-memory-gitignore-symlink");
    let outside = symlink_project.root().join("outside-gitignore");
    std::fs::write(&outside, "outside rule\n").expect("create outside gitignore");
    std::os::unix::fs::symlink(&outside, symlink_project.root().join(".gitignore"))
        .expect("symlink gitignore");
    let store = MemoryStore::open(symlink_project.db()).expect("open store");
    let workspace = store
        .register_workspace(symlink_project.root(), "Symlink gitignore", None)
        .expect("register workspace");
    let error = store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Local, false)
        .expect_err("reject symlinked gitignore");
    assert!(error.to_string().contains(".gitignore cannot be a symlink"));
    assert!(!symlink_project.root().join(".kodade/memory").exists());
    assert_eq!(
        std::fs::read_to_string(outside).expect("read outside gitignore"),
        "outside rule\n"
    );

    let invalid_project = TempProject::new("working-memory-gitignore-invalid-utf8");
    std::fs::write(invalid_project.root().join(".gitignore"), [0xff, 0xfe])
        .expect("seed invalid gitignore");
    let store = MemoryStore::open(invalid_project.db()).expect("open store");
    let workspace = store
        .register_workspace(invalid_project.root(), "Invalid gitignore", None)
        .expect("register workspace");
    let error = store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Local, false)
        .expect_err("surface invalid gitignore");
    assert!(error.to_string().contains("UTF-8"));
    assert!(!invalid_project.root().join(".kodade/memory").exists());
    assert_eq!(
        std::fs::read(invalid_project.root().join(".gitignore")).expect("read invalid gitignore"),
        [0xff, 0xfe]
    );

    let malformed_project = TempProject::new("working-memory-gitignore-malformed-commit");
    std::fs::write(
        malformed_project.root().join(".gitignore"),
        "# BEGIN KödMem local working memory\n/.kodade/memory/\n",
    )
    .expect("seed malformed managed block");
    let store = MemoryStore::open(malformed_project.db()).expect("open store");
    let workspace = store
        .register_workspace(malformed_project.root(), "Malformed commit ignore", None)
        .expect("register workspace");
    let error = store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect_err("reject malformed managed block in commit mode");
    assert!(error.to_string().contains("incomplete or modified"));
    assert!(!malformed_project.root().join(".kodade/memory").exists());
}

#[test]
fn checkpoint_round_trip_rewrites_state_and_appends_worklog_and_decisions_once() {
    let project = TempProject::new("working-memory-checkpoint");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Checkpoint project", None)
        .expect("register workspace");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate working memory");
    let input = NewCheckpoint {
        workspace_id: workspace.id.clone(),
        summary: "Finished the parser and left the renderer in progress.".into(),
        decisions: vec!["Keep the parser streaming because inputs can be large.".into()],
        next_actions: vec!["Finish the renderer integration.".into()],
        changed_paths: vec!["src/parser.rs".into()],
        source: MemorySource::Agent,
        source_client: "codex".into(),
        session_id: Some("session-42".into()),
        idempotency_key: Some("session-42:handoff".into()),
    };

    let checkpoint = store.checkpoint(input.clone()).expect("write checkpoint");
    let retried = store.checkpoint(input).expect("retry checkpoint");
    assert_eq!(retried.id, checkpoint.id);

    let memory = project.root().join(".kodade/memory");
    let state = std::fs::read_to_string(memory.join("STATE.md")).expect("read state");
    assert!(state.contains("Finished the parser"));
    assert!(state.contains("Finish the renderer integration"));
    assert!(state.contains("src/parser.rs"));
    let worklog = std::fs::read_to_string(memory.join("WORKLOG.md")).expect("read worklog");
    assert_eq!(worklog.matches(&checkpoint.id).count(), 1);
    assert!(worklog.contains("codex"));
    assert!(worklog.contains("session-42"));
    let decisions = std::fs::read_to_string(memory.join("decisions.md")).expect("read decisions");
    assert_eq!(decisions.matches(&checkpoint.id).count(), 1);
    assert!(decisions.contains("Keep the parser streaming"));

    let fresh = MemoryStore::open(project.db()).expect("open fresh store");
    let context = fresh.context(&workspace.id).expect("fresh session context");
    let working = context.working_memory.expect("file-backed context");
    assert!(working.state.contains("Finished the parser"));
    assert!(working.recent_worklog.contains("session-42"));
}

#[test]
fn retrying_an_older_checkpoint_never_rewinds_current_state() {
    let project = TempProject::new("working-memory-stale-retry");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Stale retry project", None)
        .expect("register workspace");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate working memory");
    let checkpoint = |summary: &str, key: &str| NewCheckpoint {
        workspace_id: workspace.id.clone(),
        summary: summary.into(),
        decisions: Vec::new(),
        next_actions: Vec::new(),
        changed_paths: Vec::new(),
        source: MemorySource::Agent,
        source_client: "codex".into(),
        session_id: Some("retry-session".into()),
        idempotency_key: Some(key.into()),
    };
    store
        .checkpoint(checkpoint("Checkpoint A", "checkpoint-a"))
        .expect("write A");
    store
        .checkpoint(checkpoint("Checkpoint B", "checkpoint-b"))
        .expect("write B");
    store
        .checkpoint(checkpoint("Checkpoint A", "checkpoint-a"))
        .expect("retry A");

    let state = std::fs::read_to_string(project.root().join(".kodade/memory/STATE.md"))
        .expect("read current state");
    assert!(state.contains("Checkpoint B"));
    assert!(!state.contains("Checkpoint A"));
}

#[test]
fn exported_durable_memory_snapshot_is_not_rewritten_by_lifecycle_changes() {
    let project = TempProject::new("working-memory-remember");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Remember project", None)
        .expect("register workspace");
    let input = NewMemory {
        workspace_id: workspace.id.clone(),
        kind: MemoryKind::Decision,
        title: "Keep the renderer streaming".into(),
        body: "Large files should never require one giant in-memory buffer.".into(),
        source: MemorySource::Agent,
        source_client: "claude-code".into(),
        session_id: Some("session-remember".into()),
        pinned: true,
        idempotency_key: Some("session-remember:renderer-decision".into()),
        links: Vec::new(),
    };

    let remembered = store.remember(input.clone()).expect("remember decision");
    let retried = store.remember(input).expect("retry decision");
    assert_eq!(retried.id, remembered.id);
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, true)
        .expect("activate with durable snapshot");

    let memories_path = project.root().join(".kodade/memory/MEMORIES.md");
    let snapshot = std::fs::read_to_string(&memories_path).expect("read snapshot");
    assert_eq!(snapshot.matches("Keep the renderer streaming").count(), 1);
    assert!(snapshot.contains("one giant in-memory buffer"));

    let revised = store
        .revise(MemoryRevision {
            id: remembered.id.clone(),
            expected_version: remembered.version,
            kind: MemoryKind::Decision,
            title: "Keep rendering incremental".into(),
            body: "Stream chunks so memory usage stays bounded.".into(),
            pinned: true,
            source_client: "claude-code".into(),
            session_id: Some("session-remember".into()),
            links: Vec::new(),
        })
        .expect("revise decision");

    let tombstone = store
        .forget(
            &revised.id,
            revised.version,
            "claude-code",
            Some("session-remember"),
        )
        .expect("forget decision");

    store
        .restore(
            &tombstone.id,
            tombstone.version,
            "claude-code",
            Some("session-remember"),
        )
        .expect("restore decision");
    let unchanged = std::fs::read_to_string(memories_path).expect("read unchanged snapshot");
    assert_eq!(unchanged, snapshot);
}

#[test]
fn concurrent_checkpoints_are_serialized_without_losing_entries() {
    let project = TempProject::new("working-memory-concurrent-checkpoints");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Concurrent checkpoints", None)
        .expect("register workspace");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate working memory");

    let mut writers = Vec::new();
    for index in 0..6 {
        let store = store.clone();
        let workspace_id = workspace.id.clone();
        writers.push(std::thread::spawn(move || {
            store
                .checkpoint(NewCheckpoint {
                    workspace_id,
                    summary: format!("Concurrent checkpoint {index}"),
                    decisions: Vec::new(),
                    next_actions: vec![format!("Continue lane {index}")],
                    changed_paths: vec![format!("src/lane-{index}.ts")],
                    source: MemorySource::Agent,
                    source_client: "concurrency-test".into(),
                    session_id: Some(format!("session-{index}")),
                    idempotency_key: Some(format!("concurrent-checkpoint-{index}")),
                })
                .expect("write concurrent checkpoint")
        }));
    }
    let checkpoint_ids = writers
        .into_iter()
        .map(|writer| writer.join().expect("writer thread").id)
        .collect::<Vec<_>>();

    let worklog = std::fs::read_to_string(project.root().join(".kodade/memory/WORKLOG.md"))
        .expect("read worklog");
    for checkpoint_id in checkpoint_ids {
        assert_eq!(worklog.matches(&checkpoint_id).count(), 1);
    }

    let read_only = MemoryStore::open_read_only(project.db()).expect("open read-only index");
    for index in 0..6 {
        let page = read_only
            .search(MemoryQuery {
                workspace_id: workspace.id.clone(),
                text: format!("Concurrent checkpoint {index}"),
                kinds: Vec::new(),
                sources: Vec::new(),
                updated_after: None,
                limit: 20,
                offset: 0,
            })
            .expect("search serialized checkpoint index");
        assert!(
            page.items.iter().any(|hit| hit
                .file_path
                .as_deref()
                .is_some_and(|path| path.ends_with("WORKLOG.md"))),
            "missing indexed checkpoint {index}"
        );
    }
}

#[test]
fn oversized_worklogs_archive_while_state_stays_bounded() {
    let project = TempProject::new("working-memory-archive");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Archive project", None)
        .expect("register workspace");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate working memory");
    for index in 0..5 {
        store
            .checkpoint(NewCheckpoint {
                workspace_id: workspace.id.clone(),
                summary: format!("archive-entry-{index} {}", "x".repeat(60 * 1024)),
                decisions: Vec::new(),
                next_actions: Vec::new(),
                changed_paths: Vec::new(),
                source: MemorySource::Kodade,
                source_client: "archive-test".into(),
                session_id: None,
                idempotency_key: Some(format!("archive-entry-{index}")),
            })
            .expect("write large checkpoint");
    }

    let memory = project.root().join(".kodade/memory");
    let state = std::fs::read(memory.join("STATE.md")).expect("read bounded state");
    assert!(state.len() <= 32 * 1024);
    let archives = std::fs::read_dir(&memory)
        .expect("list working memory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("WORKLOG-") && name.ends_with(".md"))
        .collect::<Vec<_>>();
    assert_eq!(archives.len(), 1);
    let archive = std::fs::read_to_string(memory.join(&archives[0])).expect("read archive");
    assert!(archive.contains("archive-entry-0"));
    assert!(archive.contains("archive-entry-3"));
    let current = std::fs::read_to_string(memory.join("WORKLOG.md")).expect("read current log");
    assert!(current.contains("archive-entry-4"));
    let archived_search = store
        .search(MemoryQuery {
            workspace_id: workspace.id,
            text: "archive-entry-0".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("search archived worklog");
    assert_eq!(archived_search.total, 1);
    assert!(archived_search.items[0]
        .file_path
        .as_deref()
        .is_some_and(|path| path.contains("WORKLOG-")));
}

#[test]
fn session_exit_fallback_creates_one_kodade_checkpoint_when_working_memory_is_active() {
    let project = TempProject::new("working-memory-session-fallback");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Fallback project", None)
        .expect("register workspace");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate working memory");
    let explicit = NewCheckpoint {
        workspace_id: workspace.id.clone(),
        summary: "Rich explicit handoff remains current.".into(),
        decisions: Vec::new(),
        next_actions: vec!["Continue the renderer integration.".into()],
        changed_paths: Vec::new(),
        source: MemorySource::Agent,
        source_client: "codex".into(),
        session_id: Some("session-fallback".into()),
        idempotency_key: Some("explicit-before-fallback".into()),
    };
    store
        .checkpoint(explicit.clone())
        .expect("write explicit checkpoint");
    for (kind, relative_path, provider, occurred_at) in [
        (ActivityKind::SessionStarted, None, Some("codex"), 0),
        (
            ActivityKind::FileSaved,
            Some("src/renderer.ts"),
            Some("codex"),
            60_000,
        ),
    ] {
        store
            .record_activity(NewActivity {
                workspace_id: workspace.id.clone(),
                kind,
                source: "kodade-ui".into(),
                session_id: Some("session-fallback".into()),
                relative_path: relative_path.map(str::to_string),
                provider: provider.map(str::to_string),
                occurred_at: Some(occurred_at),
            })
            .expect("record session metadata")
            .expect("capture enabled");
    }
    let event = store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::SessionExited,
            source: "kodade-ui".into(),
            session_id: Some("session-fallback".into()),
            relative_path: None,
            provider: Some("codex".into()),
            occurred_at: Some(120_000),
        })
        .expect("record activity")
        .expect("capture enabled");

    let checkpoint = store
        .checkpoint_activity_fallback(&event)
        .expect("create fallback")
        .expect("fallback checkpoint");
    let retried = store
        .checkpoint_activity_fallback(&event)
        .expect("retry fallback")
        .expect("same checkpoint");
    assert_eq!(checkpoint.id, retried.id);
    assert_eq!(checkpoint.source, MemorySource::Kodade);
    assert!(checkpoint.summary.contains("session-fallback"));
    assert!(checkpoint.summary.contains("using codex"));
    assert!(checkpoint.summary.contains("after 2 minutes"));
    assert_eq!(checkpoint.changed_paths, vec!["src/renderer.ts"]);
    let worklog = std::fs::read_to_string(project.root().join(".kodade/memory/WORKLOG.md"))
        .expect("read worklog");
    assert_eq!(worklog.matches(&checkpoint.id).count(), 1);
    std::fs::write(
        project.root().join(".kodade/memory/STATE.md"),
        "# Project state\n\nstale race fixture\n",
    )
    .expect("simulate explicit writer waiting behind fallback");
    store
        .checkpoint(explicit)
        .expect("retry latest stateful checkpoint after fallback");
    let state = std::fs::read_to_string(project.root().join(".kodade/memory/STATE.md"))
        .expect("read state after fallback");
    assert!(state.contains("Rich explicit handoff remains current"));
    assert!(state.contains("Continue the renderer integration"));

    let project_closed = store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::ProjectClosed,
            source: "kodade-ui".into(),
            session_id: None,
            relative_path: None,
            provider: None,
            occurred_at: Some(180_000),
        })
        .expect("record project selection close")
        .expect("capture enabled");
    assert!(store
        .checkpoint_activity_fallback(&project_closed)
        .expect("ignore project-selection close")
        .is_none());
}

#[test]
fn changed_git_head_creates_a_checkpoint_after_the_initial_observation() {
    let project = TempProject::new("working-memory-git-commit");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Git checkpoint project", None)
        .expect("register workspace");
    store
        .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate working memory");
    store
        .checkpoint(NewCheckpoint {
            workspace_id: workspace.id.clone(),
            summary: "Explicit state before Git observation.".into(),
            decisions: Vec::new(),
            next_actions: vec!["Keep this next action visible.".into()],
            changed_paths: Vec::new(),
            source: MemorySource::Agent,
            source_client: "codex".into(),
            session_id: None,
            idempotency_key: Some("explicit-before-git-fallback".into()),
        })
        .expect("write explicit state");
    let initial = "1111111111111111111111111111111111111111";
    let changed = "2222222222222222222222222222222222222222";

    assert!(store
        .observe_working_memory_commit(&workspace.id, initial)
        .expect("observe initial head")
        .is_none());
    let checkpoint = store
        .observe_working_memory_commit(&workspace.id, changed)
        .expect("observe changed head")
        .expect("commit checkpoint");
    assert_eq!(checkpoint.source, MemorySource::Kodade);
    assert!(checkpoint.summary.contains("222222222222"));
    let state = std::fs::read_to_string(project.root().join(".kodade/memory/STATE.md"))
        .expect("read state after Git fallback");
    assert!(state.contains("Explicit state before Git observation"));
    assert!(state.contains("Keep this next action visible"));
    assert!(store
        .observe_working_memory_commit(&workspace.id, changed)
        .expect("repeat changed head")
        .is_none());
    assert_eq!(
        store
            .working_memory_status(&workspace.id)
            .expect("working status")
            .expect("active working memory")
            .last_commit
            .as_deref(),
        Some(changed)
    );
}

#[test]
fn mapped_activity_and_git_fallbacks_append_once_without_clobbering_state() {
    let fixture = MappedProjectsVault::new("mapped-portable-fallbacks", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let state = fixture.project_root().join("STATE.md");
    let initial_hash = file_hash(&state);
    fixture
        .store
        .checkpoint_with_state_hash(
            NewCheckpoint {
                workspace_id: fixture.workspace.id.clone(),
                summary: "Explicit mapped state remains authoritative.".into(),
                decisions: Vec::new(),
                next_actions: vec!["Keep the explicit next action.".into()],
                changed_paths: Vec::new(),
                source: MemorySource::Agent,
                source_client: "codex".into(),
                session_id: Some("portable-fallback".into()),
                idempotency_key: Some("portable-explicit".into()),
            },
            Some(&initial_hash),
        )
        .unwrap();
    let explicit_state = std::fs::read(&state).unwrap();
    fixture
        .store
        .record_activity(NewActivity {
            workspace_id: fixture.workspace.id.clone(),
            kind: ActivityKind::SessionStarted,
            source: "kodade-ui".into(),
            session_id: Some("portable-fallback".into()),
            relative_path: None,
            provider: Some("codex".into()),
            occurred_at: Some(0),
        })
        .unwrap();
    let exited = fixture
        .store
        .record_activity(NewActivity {
            workspace_id: fixture.workspace.id.clone(),
            kind: ActivityKind::SessionExited,
            source: "kodade-ui".into(),
            session_id: Some("portable-fallback".into()),
            relative_path: None,
            provider: Some("codex".into()),
            occurred_at: Some(60_000),
        })
        .unwrap()
        .unwrap();
    let session_checkpoint = fixture
        .store
        .checkpoint_activity_fallback(&exited)
        .unwrap()
        .unwrap();
    let session_retry = fixture
        .store
        .checkpoint_activity_fallback(&exited)
        .unwrap()
        .unwrap();
    assert_eq!(session_checkpoint.id, session_retry.id);

    let first = "1111111111111111111111111111111111111111";
    let second = "2222222222222222222222222222222222222222";
    assert!(fixture
        .store
        .observe_working_memory_commit(&fixture.workspace.id, first)
        .unwrap()
        .is_none());
    let git_checkpoint = fixture
        .store
        .observe_working_memory_commit(&fixture.workspace.id, second)
        .unwrap()
        .unwrap();
    assert!(fixture
        .store
        .observe_working_memory_commit(&fixture.workspace.id, second)
        .unwrap()
        .is_none());
    assert_eq!(std::fs::read(&state).unwrap(), explicit_state);
    let worklog = walk_files(&fixture.project_root().join("Worklog"))
        .into_iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .collect::<String>();
    assert_eq!(worklog.matches("<!-- kodmem-checkpoint {").count(), 3);
    for summary in [&session_checkpoint.summary, &git_checkpoint.summary] {
        let page = fixture
            .store
            .search_checkpoints(CheckpointQuery {
                workspace_id: fixture.workspace.id.clone(),
                text: summary.clone(),
                limit: 20,
                offset: 0,
            })
            .unwrap();
        assert_eq!(page.total, 1);
    }
    assert!(!fixture.checkout.join(".kodade/memory").exists());
}

#[test]
fn committed_working_memory_resumes_from_a_fresh_git_clone() {
    let project = TempProject::new("working-memory-git-round-trip");
    let first_root = project.root().join("machine-a");
    let second_root = project.root().join("machine-b");
    std::fs::create_dir(&first_root).expect("create first checkout");
    let first_store =
        MemoryStore::open(project.root().join("machine-a.sqlite3")).expect("open first store");
    let first_workspace = first_store
        .register_workspace(&first_root, "Machine A", None)
        .expect("register first checkout");
    first_store
        .remember(NewMemory {
            workspace_id: first_workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Portable durable snapshot".into(),
            body: "Preserve this exported record across clones.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("portable-durable-snapshot".into()),
            links: Vec::new(),
        })
        .expect("remember portable durable record");
    first_store
        .activate_working_memory(&first_workspace.id, WorkingMemoryMode::Commit, true)
        .expect("activate committed memory");
    first_store
        .checkpoint(NewCheckpoint {
            workspace_id: first_workspace.id.clone(),
            summary: "Completed the portable renderer handoff.".into(),
            decisions: vec!["Keep project memory committed with the code.".into()],
            next_actions: vec!["Resume on the second machine.".into()],
            changed_paths: vec!["src/renderer.ts".into()],
            source: MemorySource::Agent,
            source_client: "codex".into(),
            session_id: Some("machine-a-session".into()),
            idempotency_key: Some("machine-a-handoff".into()),
        })
        .expect("checkpoint first checkout");

    for args in [
        vec!["init"],
        vec!["config", "user.name", "KödMem Test"],
        vec!["config", "user.email", "kodmem@example.invalid"],
        vec!["add", ".kodade/memory"],
        vec!["commit", "-m", "test: record working memory"],
    ] {
        assert!(Command::new("git")
            .args(args)
            .current_dir(&first_root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run git fixture command")
            .success());
    }
    assert!(Command::new("git")
        .arg("clone")
        .arg(&first_root)
        .arg(&second_root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("clone working-memory fixture")
        .success());

    let second_store =
        MemoryStore::open(project.root().join("machine-b.sqlite3")).expect("open second store");
    let second_workspace = second_store
        .register_workspace(&second_root, "Machine B", None)
        .expect("register cloned checkout");
    second_store
        .activate_working_memory(&second_workspace.id, WorkingMemoryMode::Commit, false)
        .expect("index cloned working memory");
    second_store
        .remember(NewMemory {
            workspace_id: second_workspace.id.clone(),
            kind: MemoryKind::Task,
            title: "Machine B local record".into(),
            body: "This must not overwrite the committed snapshot.".into(),
            source: MemorySource::Agent,
            source_client: "codex".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("machine-b-local-record".into()),
            links: Vec::new(),
        })
        .expect("remember on second machine");
    let context = second_store
        .context(&second_workspace.id)
        .expect("read cloned context")
        .working_memory
        .expect("cloned working memory");

    assert!(context.state.contains("portable renderer handoff"));
    assert!(context.recent_worklog.contains("machine-a-session"));
    let durable_snapshot = std::fs::read_to_string(second_root.join(".kodade/memory/MEMORIES.md"))
        .expect("read cloned durable snapshot");
    assert!(durable_snapshot.contains("Portable durable snapshot"));
    assert!(!durable_snapshot.contains("Machine B local record"));
}

#[test]
fn export_retention_and_workspace_purge_cover_the_full_local_lifecycle() {
    let project = TempProject::new("lifecycle");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Lifecycle project", None)
        .expect("register workspace");
    let memory = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Summary,
            title: "Lifecycle marker".into(),
            body: "Export this Markdown before retention.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("remember export marker");
    store
        .forget(&memory.id, 1, "kodade-ui", None)
        .expect("create tombstone");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64;
    let day = 24 * 60 * 60 * 1000_i64;
    for (session, occurred_at) in [("old", now - 31 * day), ("current", now)] {
        store
            .record_activity(NewActivity {
                workspace_id: workspace.id.clone(),
                kind: ActivityKind::SessionExited,
                source: "kodade-ui".into(),
                session_id: Some(session.into()),
                relative_path: None,
                provider: None,
                occurred_at: Some(occurred_at),
            })
            .expect("record retained activity")
            .expect("capture active");
    }
    let exported = store
        .export_workspace(&workspace.id)
        .expect("export workspace");
    assert!(exported.markdown.contains("# Lifecycle project"));
    assert!(exported.markdown.contains("Lifecycle marker"));
    assert!(exported
        .json
        .contains("Export this Markdown before retention."));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&exported.json).expect("valid export JSON")
            ["schemaVersion"],
        1
    );

    store
        .set_retention(
            &workspace.id,
            RetentionSettings {
                capture_paused: false,
                activity_days: 30,
                audit_days: 30,
                tombstone_days: 30,
            },
            test_provenance(),
        )
        .expect("set retention");
    let first = store
        .run_retention(&workspace.id, now, 100, test_provenance())
        .expect("prune old metadata");
    assert_eq!(first.activity_deleted, 1);
    assert_eq!(first.tombstones_deleted, 0);

    let second = store
        .run_retention(&workspace.id, now + 31 * day, 100, test_provenance())
        .expect("prune expired tombstone");
    assert_eq!(second.activity_deleted, 1);
    assert_eq!(second.tombstones_deleted, 1);
    assert!(matches!(
        store.memory(&memory.id),
        Err(MemoryError::NotFound(_))
    ));

    store
        .purge_workspace(&workspace.id)
        .expect("purge workspace immediately");
    assert!(matches!(
        store.workspace(&workspace.id),
        Err(MemoryError::WorkspaceNotRegistered(_))
    ));
}

#[test]
fn paused_workspace_drain_prunes_expired_activity_audit_and_tombstones() {
    let project = TempProject::new("paused-retention-drain");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Paused retention project", None)
        .expect("register workspace");
    let memory = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Expired tombstone".into(),
            body: "Paused capture must not pause retention.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("remember expiring record");
    store
        .forget(&memory.id, memory.version, "kodade-ui", None)
        .expect("create expiring tombstone");
    store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::Idle,
            source: "kodade-ui".into(),
            session_id: Some("idle-session".into()),
            relative_path: None,
            provider: None,
            occurred_at: Some(0),
        })
        .expect("record expired idle activity")
        .expect("capture is active before pause");
    store
        .set_retention(
            &workspace.id,
            RetentionSettings {
                capture_paused: true,
                activity_days: 0,
                audit_days: 0,
                tombstone_days: 0,
            },
            test_provenance(),
        )
        .expect("pause capture with immediate expiry");
    assert!(store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::Active,
            source: "kodade-ui".into(),
            session_id: Some("paused-session".into()),
            relative_path: None,
            provider: None,
            occurred_at: None,
        })
        .expect("paused capture is a successful no-op")
        .is_none());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64;

    let report = store
        .drain_retention(&workspace.id, now, 2, 10, test_provenance())
        .expect("bounded paused-workspace retention drain");

    assert_eq!(report.activity_deleted, 1);
    assert!(report.audit_deleted >= 2);
    assert_eq!(report.tombstones_deleted, 1);
    assert!(matches!(
        store.memory(&memory.id),
        Err(MemoryError::NotFound(_))
    ));
    let exported = store
        .export_workspace(&workspace.id)
        .expect("inspect retained metadata through export");
    let json: serde_json::Value = serde_json::from_str(&exported.json).expect("valid export JSON");
    assert_eq!(
        json["activity"].as_array().expect("activity array").len(),
        0
    );
}

#[test]
fn repeated_retention_batches_remove_1001_expired_rows_before_export() {
    let project = TempProject::new("retention-over-one-thousand");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Large retention project", None)
        .expect("register workspace");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64;
    let expired_at = now - 31 * 24 * 60 * 60 * 1000_i64;
    let connection = rusqlite::Connection::open(project.db()).expect("seed expired rows");
    connection
        .execute_batch(&format!(
            "WITH RECURSIVE rows(value) AS (
                VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 1001
             )
             INSERT INTO memories(
                id, workspace_id, kind, title, body, source, source_client,
                pinned, version, created_at, updated_at, deleted_at
             )
             SELECT 'expired_mem_' || value, '{workspace_id}', 'fact',
                    'Expired memory ' || value, 'Expired body', 'kodade', 'fixture',
                    0, 2, {expired_at}, {expired_at}, {expired_at}
             FROM rows;
             WITH RECURSIVE rows(value) AS (
                VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 1001
             )
             INSERT INTO activity_events(
                id, workspace_id, kind, source, occurred_at, sequence
             )
             SELECT 'expired_activity_' || value, '{workspace_id}', 'idle',
                    'fixture', {expired_at}, value
             FROM rows;
             WITH RECURSIVE rows(value) AS (
                VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 1001
             )
             INSERT INTO mcp_audit(
                id, workspace_id, client, capability, action, result, occurred_at
             )
             SELECT 'expired_audit_' || value, '{workspace_id}', 'fixture',
                    'memory:write', 'fixture', 'ok', {expired_at}
             FROM rows;",
            workspace_id = workspace.id,
        ))
        .expect("seed 1001 expired rows per retained table");
    drop(connection);
    store
        .set_retention(
            &workspace.id,
            RetentionSettings {
                capture_paused: true,
                activity_days: 7,
                audit_days: 7,
                tombstone_days: 7,
            },
            test_provenance(),
        )
        .expect("set short retention");

    let first = store
        .run_retention(&workspace.id, now, 1000, test_provenance())
        .expect("delete first full batch");
    let second = store
        .run_retention(&workspace.id, now, 1000, test_provenance())
        .expect("delete final partial batch");

    assert_eq!(first.activity_deleted, 1000);
    assert_eq!(first.audit_deleted, 1000);
    assert_eq!(first.tombstones_deleted, 1000);
    assert_eq!(second.activity_deleted, 1);
    assert_eq!(second.audit_deleted, 1);
    assert_eq!(second.tombstones_deleted, 1);
    let export = store
        .export_workspace(&workspace.id)
        .expect("export fully retained workspace");
    let json: serde_json::Value = serde_json::from_str(&export.json).expect("parse export");
    assert_eq!(json["memories"].as_array().map(Vec::len), Some(0));
    assert_eq!(json["activity"].as_array().map(Vec::len), Some(0));
    assert!(json["audit"]
        .as_array()
        .expect("export audit")
        .iter()
        .all(|entry| !entry["id"]
            .as_str()
            .unwrap_or_default()
            .starts_with("expired_audit_")));
}

#[test]
fn export_reads_memories_and_audit_from_one_concurrent_snapshot() {
    let project = TempProject::new("export-snapshot");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Snapshot project", None)
        .expect("register workspace");
    let seed = (0..500)
        .map(|index| NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: format!("seed {index}"),
            body: "Existing export record".into(),
            source: MemorySource::User,
            source_client: "snapshot-seed".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some(format!("seed-{index}")),
            links: Vec::new(),
        })
        .collect();
    store.remember_batch(seed).expect("seed export records");

    let writer_store = store.clone();
    let workspace_id = workspace.id.clone();
    let writer = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(10));
        for index in 0..25 {
            writer_store
                .remember(NewMemory {
                    workspace_id: workspace_id.clone(),
                    kind: MemoryKind::Task,
                    title: format!("concurrent {index}"),
                    body: "Atomic memory and audit pair".into(),
                    source: MemorySource::Agent,
                    source_client: "snapshot-writer".into(),
                    session_id: Some("writer".into()),
                    pinned: false,
                    idempotency_key: Some(format!("concurrent-{index}")),
                    links: Vec::new(),
                })
                .expect("write during export");
        }
    });

    let exported = store
        .export_workspace(&workspace.id)
        .expect("export concurrent snapshot");
    writer.join().expect("writer thread");
    let json: serde_json::Value = serde_json::from_str(&exported.json).expect("parse export");
    let memory_ids = json["memories"]
        .as_array()
        .expect("exported memories")
        .iter()
        .map(|memory| memory["id"].as_str().expect("memory id"))
        .collect::<std::collections::HashSet<_>>();
    let dangling_audit = json["audit"]
        .as_array()
        .expect("exported audit")
        .iter()
        .filter(|entry| entry["action"] == "remember")
        .filter_map(|entry| entry["targetId"].as_str())
        .filter(|target_id| !memory_ids.contains(target_id))
        .collect::<Vec<_>>();

    assert!(
        dangling_audit.is_empty(),
        "export mixed audit from a newer snapshot with older memories: {dangling_audit:?}"
    );
}

#[test]
fn activity_export_uses_persisted_sequence_when_timestamps_tie() {
    let project = TempProject::new("activity-sequence-order");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Activity sequence project", None)
        .expect("register workspace");
    let occurred_at = 1_700_000_000_000;
    let mut event_ids = Vec::new();
    for kind in [
        ActivityKind::SessionStarted,
        ActivityKind::ProviderLaunched,
        ActivityKind::SessionExited,
    ] {
        event_ids.push(
            store
                .record_activity(NewActivity {
                    workspace_id: workspace.id.clone(),
                    kind,
                    source: "kodade-ui".into(),
                    session_id: Some("session-1".into()),
                    relative_path: None,
                    provider: Some("codex".into()),
                    occurred_at: Some(occurred_at),
                })
                .expect("record activity")
                .expect("capture active")
                .id,
        );
    }
    let connection = rusqlite::Connection::open(project.db()).expect("open activity fixture");
    for (id, replacement) in event_ids.iter().zip(["act_z", "act_y", "act_x"]) {
        connection
            .execute(
                "UPDATE activity_events SET id = ?1 WHERE id = ?2",
                rusqlite::params![replacement, id],
            )
            .expect("reverse lexical activity ids without changing insertion order");
    }

    let exported = store
        .export_workspace(&workspace.id)
        .expect("export activity history");
    let export_json =
        serde_json::from_str::<serde_json::Value>(&exported.json).expect("parse export JSON");
    let activity = export_json["activity"]
        .as_array()
        .expect("exported activity array")
        .iter()
        .map(|event| event["kind"].as_str().expect("activity kind"))
        .collect::<Vec<_>>();
    assert_eq!(
        activity,
        vec!["sessionStarted", "providerLaunched", "sessionExited"],
        "equal timestamps must retain the persisted write order rather than random IDs"
    );
}

#[test]
fn paged_tombstones_and_targeted_audit_recover_history_beyond_one_hundred_rows() {
    let project = TempProject::new("paged-tombstone-and-audit-recovery");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Paged recovery project", None)
        .expect("register workspace");
    let mut first_id = String::new();
    for index in 0..101 {
        let memory = store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: format!("Deleted recovery record {index}"),
                body: "Retained tombstone and audit fixture.".into(),
                source: MemorySource::User,
                source_client: "kodade-ui".into(),
                session_id: None,
                pinned: false,
                idempotency_key: Some(format!("deleted-recovery-{index}")),
                links: Vec::new(),
            })
            .expect("create recovery memory");
        if index == 0 {
            first_id = memory.id.clone();
        }
        store
            .forget(&memory.id, memory.version, "kodade-ui", None)
            .expect("create recovery tombstone");
    }
    drop(store);

    let reloaded = MemoryStore::open(project.db()).expect("reopen KödMem");
    let first_page = reloaded
        .deleted_memory_page(DeletedMemoryQuery {
            workspace_id: workspace.id.clone(),
            limit: 100,
            offset: 0,
        })
        .expect("load first bounded tombstone page");
    assert_eq!(first_page.total, 101);
    assert_eq!(first_page.items.len(), 100);
    let second_page = reloaded
        .deleted_memory_page(DeletedMemoryQuery {
            workspace_id: workspace.id.clone(),
            limit: 100,
            offset: 100,
        })
        .expect("load second bounded tombstone page");
    assert_eq!(second_page.items.len(), 1);
    let recovered = second_page.items[0].clone();
    assert_eq!(recovered.id, first_id);

    let global_audit = reloaded
        .audit(&workspace.id, 100)
        .expect("read bounded global audit");
    assert!(
        global_audit
            .iter()
            .all(|entry| entry.target_id.as_deref() != Some(first_id.as_str())),
        "the oldest record's audit should be outside the global first page"
    );
    let record_audit = reloaded
        .audit_page(AuditQuery {
            workspace_id: workspace.id.clone(),
            target_id: Some(first_id.clone()),
            limit: 100,
            offset: 0,
        })
        .expect("load targeted audit history for the recovered record");
    assert_eq!(record_audit.total, 2);
    assert_eq!(
        record_audit
            .items
            .iter()
            .map(|entry| entry.action.as_str())
            .collect::<Vec<_>>(),
        vec!["forget", "remember"]
    );
    reloaded
        .restore(&recovered.id, recovered.version, "kodade-ui", None)
        .expect("restore the 101st retained tombstone after reopen");
    assert_eq!(
        reloaded
            .audit_page(AuditQuery {
                workspace_id: workspace.id.clone(),
                target_id: Some(first_id),
                limit: 100,
                offset: 0,
            })
            .expect("refresh targeted audit after restore")
            .total,
        3
    );
}

#[test]
fn schema_version_6_fixture_backfills_activity_sequence_without_reordering_history() {
    let project = TempProject::new("schema-v6-activity-sequence");
    install_historical_fixture(&project, include_str!("fixtures/memory_v6.sql"));

    let store = MemoryStore::open(project.db()).expect("upgrade v6 fixture");
    let exported = store
        .export_workspace("ws_legacy")
        .expect("export upgraded activity history");
    let export_json =
        serde_json::from_str::<serde_json::Value>(&exported.json).expect("parse upgraded export");
    let activity = export_json["activity"]
        .as_array()
        .expect("activity export from v6 fixture");
    assert_eq!(
        activity
            .iter()
            .map(|event| event["kind"].as_str().expect("activity kind"))
            .collect::<Vec<_>>(),
        vec!["sessionStarted", "sessionExited"],
        "sequence backfill must preserve insertion order despite reverse lexical IDs"
    );
    assert_eq!(
        activity
            .iter()
            .map(|event| event["sequence"].as_u64().expect("persisted sequence"))
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        schema_versions(project.db()),
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    );
}

#[test]
fn concurrent_app_and_mcp_style_writers_share_the_wal_database() {
    let project = TempProject::new("concurrent");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Concurrent project", None)
        .expect("register workspace");
    let mut writers = Vec::new();
    for writer in 0..4 {
        let store = store.clone();
        let workspace_id = workspace.id.clone();
        writers.push(std::thread::spawn(move || {
            for item in 0..50 {
                store
                    .remember(NewMemory {
                        workspace_id: workspace_id.clone(),
                        kind: MemoryKind::Fact,
                        title: format!("writer {writer} item {item}"),
                        body: "Concurrent WAL record".into(),
                        source: if writer == 0 {
                            MemorySource::User
                        } else {
                            MemorySource::Agent
                        },
                        source_client: if writer == 0 {
                            "kodade-ui".into()
                        } else {
                            format!("kodade-mcp-{writer}")
                        },
                        session_id: Some(format!("writer-{writer}")),
                        pinned: false,
                        idempotency_key: Some(format!("{writer}-{item}")),
                        links: Vec::new(),
                    })
                    .expect("concurrent write");
            }
        }));
    }
    for writer in writers {
        writer.join().expect("writer thread");
    }

    let page = store
        .search(MemoryQuery {
            workspace_id: workspace.id,
            text: "Concurrent WAL".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 100,
            offset: 0,
        })
        .expect("search concurrent records");
    assert_eq!(page.total, 200);
    assert_eq!(page.items.len(), 100);
}

#[test]
fn concurrent_first_open_serializes_the_complete_migration_sequence() {
    let project = TempProject::new("concurrent-open");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(12));
    let mut openers = Vec::new();

    for _ in 0..12 {
        let path = project.db();
        let barrier = barrier.clone();
        openers.push(std::thread::spawn(move || {
            barrier.wait();
            MemoryStore::open(path)
        }));
    }

    for opener in openers {
        opener
            .join()
            .expect("open thread panicked")
            .expect("concurrent first open");
    }

    let connection = rusqlite::Connection::open(project.db()).expect("inspect migrated database");
    let versions = connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .expect("prepare migration query")
        .query_map([], |row| row.get::<_, u32>(0))
        .expect("query migrations")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect migrations");
    assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
}

macro_rules! historical_schema_upgrade_test {
    ($name:ident, $version:literal) => {
        #[test]
        fn $name() {
            let project = TempProject::new(concat!("schema-v", stringify!($version)));
            install_historical_fixture(
                &project,
                include_str!(concat!("fixtures/memory_v", stringify!($version), ".sql")),
            );

            let store = MemoryStore::open(project.db()).expect("upgrade historical schema");
            let workspace = store
                .workspace("ws_legacy")
                .expect("read representative legacy workspace");
            assert_eq!(workspace.display_name, "Legacy KödMem");
            let legacy_memory = store
                .memory("mem_legacy_decision")
                .expect("read representative legacy memory");
            assert_eq!(legacy_memory.title, "Legacy WAL decision");
            assert_eq!(legacy_memory.version, 2);
            let legacy_search = store
                .search(MemoryQuery {
                    workspace_id: workspace.id.clone(),
                    text: "legacywal".into(),
                    kinds: Vec::new(),
                    sources: Vec::new(),
                    updated_after: None,
                    limit: 20,
                    offset: 0,
                })
                .expect("search legacy memory after FTS upgrade/backfill");
            assert_eq!(legacy_search.items[0].id, legacy_memory.id);
            if $version >= 3 {
                assert_eq!(legacy_memory.links.len(), 1);
                assert_eq!(legacy_memory.links[0].target_id, "mem_legacy_task");
                assert_eq!(
                    store
                        .memory("mem_legacy_task")
                        .expect("read legacy backlink target")
                        .backlinks[0]
                        .target_id,
                    legacy_memory.id,
                );
            }
            if $version >= 4 {
                let checkpoint = store
                    .checkpoint_by_id("cp_legacy")
                    .expect("read representative legacy checkpoint");
                assert_eq!(checkpoint.summary, "Legacy checkpoint handoff");
                let checkpoint_search = store
                    .search_checkpoints(CheckpointQuery {
                        workspace_id: workspace.id.clone(),
                        text: "handoff".into(),
                        limit: 20,
                        offset: 0,
                    })
                    .expect("search legacy checkpoint after upgrade");
                assert_eq!(checkpoint_search.items[0].id, checkpoint.id);
            }

            if $version >= 5 {
                let export = store
                    .export_workspace(&workspace.id)
                    .expect("export legacy activity after upgrade");
                let export_json = serde_json::from_str::<serde_json::Value>(&export.json)
                    .expect("parse legacy activity export");
                assert_eq!(
                    export_json["activity"]
                        .as_array()
                        .expect("legacy activity export")
                        .iter()
                        .map(|event| event["kind"].as_str().expect("activity kind"))
                        .collect::<Vec<_>>(),
                    vec!["sessionStarted", "fileSaved"],
                    "historical activity must remain readable through the public export interface"
                );
                assert_eq!(
                    export_json["activity"][1]["relativePath"],
                    "src-tauri/src/memory.rs"
                );
                let legacy_audit = store
                    .audit(&workspace.id, 20)
                    .expect("read historical audit after upgrade");
                assert_eq!(legacy_audit.len(), 1);
                assert_eq!(legacy_audit[0].client, "legacy-mcp");
                assert_eq!(legacy_audit[0].action, "remember");
                assert_eq!(
                    legacy_audit[0].target_id.as_deref(),
                    Some("mem_legacy_decision")
                );
                assert_eq!(legacy_audit[0].session_id, None);
            }
            let memory = store
                .remember(NewMemory {
                    workspace_id: workspace.id.clone(),
                    kind: MemoryKind::Fact,
                    title: "Historical schema upgraded".into(),
                    body: "FTS, links, checkpoints, activity, and audit are available.".into(),
                    source: MemorySource::User,
                    source_client: "migration-fixture".into(),
                    session_id: None,
                    pinned: false,
                    idempotency_key: None,
                    links: Vec::new(),
                })
                .expect("remember after upgrade");
            store
                .checkpoint(NewCheckpoint {
                    workspace_id: workspace.id.clone(),
                    summary: "Historical migration completed".into(),
                    decisions: Vec::new(),
                    next_actions: Vec::new(),
                    changed_paths: Vec::new(),
                    source: MemorySource::Kodade,
                    source_client: "migration-fixture".into(),
                    session_id: None,
                    idempotency_key: None,
                })
                .expect("checkpoint after upgrade");
            store
                .record_activity(NewActivity {
                    workspace_id: workspace.id.clone(),
                    kind: ActivityKind::ProjectOpened,
                    source: "migration-fixture".into(),
                    session_id: None,
                    relative_path: None,
                    provider: None,
                    occurred_at: Some(1_700_000_000_000),
                })
                .expect("activity after upgrade")
                .expect("capture active");
            let page = store
                .search(MemoryQuery {
                    workspace_id: workspace.id.clone(),
                    text: "Historical upgraded".into(),
                    kinds: Vec::new(),
                    sources: Vec::new(),
                    updated_after: None,
                    limit: 20,
                    offset: 0,
                })
                .expect("search after upgrade");

            assert_eq!(page.items[0].id, memory.id);
            assert_eq!(
                store
                    .audit(&workspace.id, 20)
                    .expect("audit after upgrade")
                    .len(),
                if $version >= 5 { 3 } else { 2 }
            );
            drop(store);
            assert_eq!(
                schema_versions(project.db()),
                vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
            );
        }
    };
}

historical_schema_upgrade_test!(schema_version_1_upgrades_to_current, 1);
historical_schema_upgrade_test!(schema_version_2_upgrades_to_current, 2);
historical_schema_upgrade_test!(schema_version_3_upgrades_to_current, 3);
historical_schema_upgrade_test!(schema_version_4_upgrades_to_current, 4);
historical_schema_upgrade_test!(schema_version_5_upgrades_to_current, 5);

#[test]
fn schema_version_10_adds_the_rebuildable_project_document_index() {
    let project = TempProject::new("schema-v10-project-index");
    install_historical_fixture(&project, include_str!("fixtures/memory_v10.sql"));

    let store = MemoryStore::open(project.db()).expect("upgrade version 10 schema");
    assert_eq!(
        store
            .workspace("ws_legacy")
            .expect("preserve v10 workspace")
            .display_name,
        "Legacy KödMem"
    );
    drop(store);
    let connection = rusqlite::Connection::open(project.db()).expect("inspect upgraded database");
    let project_documents: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'project_documents'",
            [],
            |row| row.get(0),
        )
        .expect("inspect project document index");
    assert_eq!(project_documents, 1);
    assert_eq!(
        schema_versions(project.db()),
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    );
}

#[test]
fn schema_version_11_fixture_adds_portable_projection_columns_and_kind_backfill() {
    let project = TempProject::new("schema-v11-portable-projection");
    install_historical_fixture(&project, include_str!("fixtures/memory_v10.sql"));
    let connection = rusqlite::Connection::open(project.db()).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE project_documents (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES logical_projects(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('project', 'state', 'worklog', 'decision', 'knowledge')),
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                modified_at INTEGER NOT NULL,
                indexed_at INTEGER NOT NULL,
                UNIQUE(project_id, relative_path)
             );
             CREATE INDEX project_documents_project_modified_idx
                ON project_documents(project_id, modified_at DESC, relative_path);
             CREATE VIRTUAL TABLE project_document_fts USING fts5(
                document_id UNINDEXED, project_id UNINDEXED, title, body, tokenize = 'unicode61'
             );
             CREATE TRIGGER project_documents_fts_insert AFTER INSERT ON project_documents BEGIN
                INSERT INTO project_document_fts(document_id, project_id, title, body)
                VALUES (new.id, new.project_id, new.title, new.body);
             END;
             CREATE TRIGGER project_documents_fts_update AFTER UPDATE ON project_documents BEGIN
                DELETE FROM project_document_fts WHERE document_id = old.id;
                INSERT INTO project_document_fts(document_id, project_id, title, body)
                VALUES (new.id, new.project_id, new.title, new.body);
             END;
             CREATE TRIGGER project_documents_fts_delete AFTER DELETE ON project_documents BEGIN
                DELETE FROM project_document_fts WHERE document_id = old.id;
             END;
             INSERT INTO schema_migrations(version, applied_at) VALUES (11, 11);
             INSERT INTO logical_projects(id, display_name, created_at, updated_at)
                VALUES ('legacy-project', 'Legacy project', 1, 1);
             INSERT INTO project_documents(
                id, project_id, relative_path, kind, title, body, sha256, modified_at, indexed_at
             ) VALUES (
                'project-doc', 'legacy-project', 'Knowledge/legacy.md', 'knowledge',
                'Legacy fact', 'legacy fact body', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 1
             );",
        )
        .unwrap();
    drop(connection);

    let store = MemoryStore::open(project.db()).expect("upgrade version 11 fixture");
    drop(store);
    let connection = rusqlite::Connection::open(project.db()).unwrap();
    let project_metadata: (String, String, bool, u64, Option<i64>, Option<String>) = connection
        .query_row(
            "SELECT memory_kind, memory_source, memory_pinned, memory_version,
                    memory_updated_at, canonical_record_id
             FROM project_documents WHERE id = 'project-doc'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        project_metadata,
        ("fact".into(), "kodade".into(), false, 1, None, None)
    );
    let canonical_columns: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('memories') WHERE name LIKE 'canonical_%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(canonical_columns, 4);
    assert_eq!(
        schema_versions(project.db()),
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    );
}

#[test]
fn failed_migration_rolls_back_its_schema_and_version_marker() {
    let project = TempProject::new("migration-rollback");
    let connection = rusqlite::Connection::open(project.db()).expect("create legacy database");
    connection
        .execute_batch(
            "CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
             );
             INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1);",
        )
        .expect("seed incomplete historical schema");
    drop(connection);

    MemoryStore::open(project.db()).expect_err("migration must fail without v1 tables");

    let connection = rusqlite::Connection::open(project.db()).expect("reopen failed migration");
    let version_two: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 2",
            [],
            |row| row.get(0),
        )
        .expect("count migration marker");
    let fts_table: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'memory_fts'",
            [],
            |row| row.get(0),
        )
        .expect("count rolled back FTS table");
    assert_eq!(version_two, 0);
    assert_eq!(fts_table, 0);
}

#[test]
fn failed_migration_marker_write_rolls_back_the_schema_change() {
    let project = TempProject::new("migration-marker-rollback");
    install_historical_fixture(&project, include_str!("fixtures/memory_v4.sql"));
    let connection = rusqlite::Connection::open(project.db()).expect("open historical database");
    connection
        .execute_batch(
            "ALTER TABLE schema_migrations RENAME TO old_schema_migrations;
             CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL CHECK(applied_at < 0)
             );
             INSERT INTO schema_migrations(version, applied_at)
                SELECT version, -1 FROM old_schema_migrations;
             DROP TABLE old_schema_migrations;",
        )
        .expect("make the next marker write fail");
    drop(connection);

    MemoryStore::open(project.db()).expect_err("migration marker must fail its constraint");

    let connection = rusqlite::Connection::open(project.db()).expect("inspect marker rollback");
    let activity_table: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'activity_events'",
            [],
            |row| row.get(0),
        )
        .expect("count rolled back activity table");
    let version_five: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 5",
            [],
            |row| row.get(0),
        )
        .expect("count rolled back marker");
    assert_eq!(activity_table, 0);
    assert_eq!(version_five, 0);
}

#[test]
fn corrupt_database_is_preserved_and_replaced_with_a_usable_store() {
    let project = TempProject::new("corruption");
    std::fs::write(project.db(), b"not a sqlite database\0private bytes")
        .expect("seed corrupt database");

    let recovered = MemoryStore::open(project.db()).expect("recover corrupt store");
    let backup = recovered
        .recovery_backup()
        .expect("recovery reports preserved database");
    assert!(backup.exists());
    assert_eq!(
        std::fs::read(backup).expect("read preserved corruption"),
        b"not a sqlite database\0private bytes"
    );
    let workspace = recovered
        .register_workspace(project.root(), "Recovered project", None)
        .expect("fresh store is usable");
    assert_eq!(recovered.workspace(&workspace.id).unwrap().id, workspace.id);
}

#[test]
fn runtime_corruption_is_recovered_by_an_already_cached_store_clone() {
    let project = TempProject::new("runtime-corruption");
    let store = MemoryStore::open(project.db()).expect("open store");
    let original = store
        .register_workspace(project.root(), "Original project", None)
        .expect("register original workspace");
    let cached = store.clone();
    std::fs::write(
        project.db(),
        b"not a sqlite database after startup\0private bytes",
    )
    .expect("corrupt the live database");

    let recovered = cached
        .register_workspace(project.root(), "Recovered project", None)
        .expect("cached store recovers runtime corruption");

    assert_ne!(recovered.id, original.id);
    let backup = cached
        .recovery_backup()
        .expect("runtime recovery reports the preserved database");
    assert!(backup.exists());
    assert!(matches!(
        cached.workspace(&original.id),
        Err(MemoryError::WorkspaceNotRegistered(_))
    ));
}

#[test]
fn search_recovers_once_when_an_fts_data_page_is_corrupt_after_startup() {
    let project = TempProject::new("runtime-fts-page-corruption");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "FTS corruption project", None)
        .expect("register workspace");
    store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Deterministic corruption marker".into(),
            body: "The cached store must recover when an indexed page fails to read.".into(),
            source: MemorySource::User,
            source_client: "corruption-fixture".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("seed searchable memory");
    corrupt_table_root_page(&project.db(), "memory_fts_data");

    let recovered = store
        .search(MemoryQuery {
            workspace_id: workspace.id,
            text: "Deterministic corruption marker".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("operation-time corruption recovers and retries once");

    assert_eq!(recovered.total, 0);
    let backup = store
        .recovery_backup()
        .expect("operation recovery reports the preserved database");
    assert!(backup.exists());
    store
        .register_workspace(project.root(), "Usable replacement", None)
        .expect("replacement store is initialized and usable");
}

#[test]
fn memory_read_recovers_once_when_the_primary_table_page_is_corrupt() {
    let project = TempProject::new("runtime-memory-page-corruption");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Memory corruption project", None)
        .expect("register workspace");
    let memory = store
        .remember(NewMemory {
            workspace_id: workspace.id,
            kind: MemoryKind::Fact,
            title: "Primary table corruption marker".into(),
            body: "The public record read must recover once.".into(),
            source: MemorySource::User,
            source_client: "corruption-fixture".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("seed memory");
    corrupt_table_root_page(&project.db(), "memories");

    let error = store
        .memory(&memory.id)
        .expect_err("the recovered replacement no longer contains the damaged row");

    assert!(matches!(error, MemoryError::NotFound(_)));
    assert!(store
        .recovery_backup()
        .expect("primary-table recovery preserves the corrupt database")
        .exists());
    store
        .register_workspace(project.root(), "Usable primary replacement", None)
        .expect("primary-table recovery initializes a usable replacement");
}

#[test]
fn independent_stores_serialize_simultaneous_operation_recovery() {
    let project = TempProject::new("independent-store-recovery");
    let first = MemoryStore::open(project.db()).expect("open first store");
    let workspace = first
        .register_workspace(project.root(), "Independent recovery project", None)
        .expect("register workspace");
    first
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Independent recovery marker".into(),
            body: "Both independently opened stores must converge on one replacement.".into(),
            source: MemorySource::User,
            source_client: "corruption-fixture".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("seed searchable memory");
    let second = MemoryStore::open(project.db()).expect("open independent second store");
    corrupt_table_root_page(&project.db(), "memory_fts_data");

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let query = MemoryQuery {
        workspace_id: workspace.id,
        text: "Independent recovery marker".into(),
        kinds: Vec::new(),
        sources: Vec::new(),
        updated_after: None,
        limit: 20,
        offset: 0,
    };
    let recoveries = [(first, query.clone()), (second, query)]
        .into_iter()
        .map(|(store, query)| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let result = store.search(query);
                (store, result)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();

    let recovered = recoveries
        .into_iter()
        .map(|thread| thread.join().expect("recovery thread did not panic"))
        .collect::<Vec<_>>();
    for (_, result) in &recovered {
        let page = result
            .as_ref()
            .expect("each independent store retries against the replacement");
        assert_eq!(page.total, 0);
    }
    assert_eq!(
        recovered
            .iter()
            .filter(|(store, _)| store.recovery_backup().is_some())
            .count(),
        1,
        "exactly one store preserves the corrupt database",
    );
    let replacement = MemoryStore::open(project.db()).expect("validate replacement store");
    replacement
        .register_workspace(project.root(), "Validated replacement", None)
        .expect("replacement is migrated and usable before recovery returns");
}

#[test]
fn child_processes_converge_on_one_recovery_with_live_wal_sidecars() {
    let project = TempProject::new("child-process-recovery");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Child recovery project", None)
        .expect("register workspace");
    store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Child recovery marker".into(),
            body: "Independent processes must retry against one replacement.".into(),
            source: MemorySource::User,
            source_client: "corruption-fixture".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("seed searchable memory");
    drop(store);
    let (page_size, root_page) = table_page_location(&project.db(), "memory_fts_data");
    let start = project.root().join("recovery-start");
    let ready = [
        project.root().join("recovery-child-0.ready"),
        project.root().join("recovery-child-1.ready"),
    ];
    let results = [
        project.root().join("recovery-child-0.result"),
        project.root().join("recovery-child-1.result"),
    ];
    let mut recovery_children = ready
        .iter()
        .zip(results.iter())
        .map(|(ready, result)| {
            spawn_memory_store_child(
                "recover",
                &project,
                &workspace.id,
                Some(&start),
                Some(ready),
                Some(result),
            )
        })
        .collect::<Vec<_>>();
    wait_for_child_files(&mut recovery_children, &ready, Duration::from_secs(10));

    let sidecar_child =
        spawn_memory_store_child("seed-sidecars", &project, &workspace.id, None, None, None);
    wait_for_child(sidecar_child, "WAL sidecar seeder", Duration::from_secs(10));
    let wal = PathBuf::from(format!("{}-wal", project.db().display()));
    let shm = PathBuf::from(format!("{}-shm", project.db().display()));
    assert!(
        std::fs::metadata(&wal).expect("real WAL sidecar").len() > 0,
        "crashed SQLite writer must leave a non-empty WAL",
    );
    assert!(
        std::fs::metadata(&shm).expect("real SHM sidecar").len() > 0,
        "crashed SQLite writer must leave a non-empty SHM",
    );
    corrupt_page(&project.db(), page_size, root_page);
    std::fs::write(&start, b"recover").expect("release recovery children");

    for (index, child) in recovery_children.into_iter().enumerate() {
        wait_for_child(
            child,
            &format!("recovery child {index}"),
            Duration::from_secs(10),
        );
    }
    let child_results = results
        .iter()
        .map(|path| std::fs::read_to_string(path).expect("read recovery child result"))
        .collect::<Vec<_>>();
    assert_eq!(
        child_results
            .iter()
            .filter(|result| result.lines().any(|line| line == "backup=true"))
            .count(),
        1,
        "exactly one process must preserve the corrupt database",
    );
    let replacement_ids = child_results
        .iter()
        .map(|result| {
            result
                .lines()
                .find_map(|line| line.strip_prefix("workspace="))
                .expect("child reports replacement workspace")
        })
        .collect::<Vec<_>>();
    assert_eq!(replacement_ids[0], replacement_ids[1]);

    let backups = std::fs::read_dir(project.root())
        .expect("list recovery files")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix("memory.sqlite3.corrupt-"))
                .is_some_and(|suffix| suffix.chars().all(|character| character.is_ascii_digit()))
        })
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1, "recovery creates one backup file");
    let backup_wal = PathBuf::from(format!("{}-wal", backups[0].display()));
    let backup_shm = PathBuf::from(format!("{}-shm", backups[0].display()));
    assert_sidecar_preserved_or_cleaned(&wal, &backup_wal, "WAL");
    assert_sidecar_preserved_or_cleaned(&shm, &backup_shm, "SHM");

    let replacement = MemoryStore::open(project.db()).expect("open converged replacement");
    let registered = replacement
        .resolve_workspace(project.root())
        .expect("replacement workspace was registered by both children");
    assert_eq!(registered.id, replacement_ids[0]);
}

#[test]
fn corruption_recovery_child_process_helper() {
    let Ok(mode) = std::env::var("KODADE_MEMORY_TEST_CHILD") else {
        return;
    };
    let database =
        PathBuf::from(std::env::var_os("KODADE_MEMORY_TEST_DB").expect("child database path"));
    let root =
        PathBuf::from(std::env::var_os("KODADE_MEMORY_TEST_ROOT").expect("child workspace root"));
    let workspace_id = std::env::var("KODADE_MEMORY_TEST_WORKSPACE").expect("child workspace id");
    match mode.as_str() {
        "seed-sidecars" => {
            let connection = rusqlite::Connection::open(&database).expect("open WAL writer");
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .expect("enable WAL");
            connection
                .pragma_update(None, "wal_autocheckpoint", 0)
                .expect("disable automatic WAL checkpoint");
            connection
                .execute(
                    "INSERT INTO mcp_audit (
                        id, workspace_id, client, capability, action, result, occurred_at
                     ) VALUES (
                        'audit_live_sidecar', ?1, 'recovery-child', 'memory:write',
                        'live_sidecar', 'ok', 1
                     )",
                    [&workspace_id],
                )
                .expect("commit a real WAL frame");
            assert!(PathBuf::from(format!("{}-wal", database.display())).exists());
            assert!(PathBuf::from(format!("{}-shm", database.display())).exists());
            // Deliberately skip SQLite destructors to model a crashed writer.
            std::process::exit(0);
        }
        "recover" => {
            let store = MemoryStore::open(&database).expect("child opens healthy store");
            let ready = PathBuf::from(
                std::env::var_os("KODADE_MEMORY_TEST_READY").expect("child ready path"),
            );
            let start = PathBuf::from(
                std::env::var_os("KODADE_MEMORY_TEST_START").expect("child start path"),
            );
            let result = PathBuf::from(
                std::env::var_os("KODADE_MEMORY_TEST_RESULT").expect("child result path"),
            );
            std::fs::write(ready, b"ready").expect("signal child ready");
            wait_for_file(&start, Duration::from_secs(10));
            let search = store.search(MemoryQuery {
                workspace_id,
                text: "Child recovery marker".into(),
                kinds: Vec::new(),
                sources: Vec::new(),
                updated_after: None,
                limit: 20,
                offset: 0,
            });
            match search {
                Ok(page) => assert_eq!(page.total, 0),
                Err(MemoryError::WorkspaceNotRegistered(_)) => {
                    // A peer may finish recovery after this process opens the
                    // original store but before its search starts. The fresh
                    // database intentionally has no workspace registration.
                }
                Err(error) => panic!("child operation recovers and retries once: {error}"),
            }
            let backup = store.recovery_backup().is_some();
            let registered = store
                .register_workspace(root, "Converged replacement", None)
                .expect("child can use replacement after retry");
            std::fs::write(
                result,
                format!("backup={backup}\nworkspace={}\n", registered.id),
            )
            .expect("write child recovery result");
        }
        other => panic!("unknown memory test child mode: {other}"),
    }
}

#[test]
fn full_text_search_meets_the_ten_thousand_record_budget() {
    let project = TempProject::new("search-budget");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Search budget project", None)
        .expect("register workspace");
    let records = (0..10_000)
        .map(|index| NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: format!("indexed record {index}"),
            body: format!("search corpus marker{index} local memory"),
            source: MemorySource::Kodade,
            source_client: "performance-fixture".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some(format!("perf-{index}")),
            links: Vec::new(),
        })
        .collect();
    assert_eq!(store.remember_batch(records).expect("seed records"), 10_000);

    let query = MemoryQuery {
        workspace_id: workspace.id,
        text: "marker9999".into(),
        kinds: Vec::new(),
        sources: Vec::new(),
        updated_after: None,
        limit: 20,
        offset: 0,
    };
    let mut elapsed = Vec::new();
    for _ in 0..20 {
        let started = std::time::Instant::now();
        let page = store.search(query.clone()).expect("timed search");
        elapsed.push(started.elapsed());
        assert_eq!(page.total, 1);
    }
    elapsed.sort_unstable();
    let p95 = elapsed[18];
    eprintln!("10k-record FTS p95: {p95:?}");
    assert!(
        p95 < std::time::Duration::from_millis(100),
        "10k-record FTS p95 was {p95:?}"
    );
}

#[test]
fn memory_writes_reject_likely_credentials_instead_of_capturing_them() {
    let project = TempProject::new("secret-reject");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Secret project", None)
        .expect("register workspace");

    let error = store
        .remember(NewMemory {
            workspace_id: workspace.id,
            kind: MemoryKind::Fact,
            title: "Do not store this".into(),
            body: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret bytes".into(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: Some("agent-1".into()),
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect_err("likely credential material must be rejected");

    assert!(matches!(error, MemoryError::InvalidInput(message) if message.contains("credential")));
}

#[test]
fn memory_writes_reject_assignment_and_uri_embedded_credentials() {
    let project = TempProject::new("embedded-memory-secret-reject");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Embedded secret project", None)
        .expect("register workspace");

    for (index, body) in [
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        "remote=https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz1234567890@github.com/repo",
    ]
    .into_iter()
    .enumerate()
    {
        let error = store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: "Do not store embedded credentials".into(),
                body: body.into(),
                source: MemorySource::Agent,
                source_client: "kodade-mcp".into(),
                session_id: Some("agent-1".into()),
                pinned: false,
                idempotency_key: Some(format!("embedded-secret-{index}")),
                links: Vec::new(),
            })
            .expect_err("embedded credential material must be rejected");

        assert!(
            matches!(error, MemoryError::InvalidInput(message) if message.contains("credential"))
        );
    }
}

#[test]
fn checkpoints_reject_assignment_and_uri_embedded_credentials() {
    let project = TempProject::new("embedded-checkpoint-secret-reject");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Checkpoint secret project", None)
        .expect("register workspace");

    for (index, summary) in [
        "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        "remote=https://token:sk-proj-abcdefghijklmnopqrstuvwxyz123456@service.invalid/v1",
    ]
    .into_iter()
    .enumerate()
    {
        let error = store
            .checkpoint(NewCheckpoint {
                workspace_id: workspace.id.clone(),
                summary: summary.into(),
                decisions: Vec::new(),
                next_actions: Vec::new(),
                changed_paths: Vec::new(),
                source: MemorySource::Agent,
                source_client: "kodade-mcp".into(),
                session_id: Some("agent-1".into()),
                idempotency_key: Some(format!("embedded-checkpoint-secret-{index}")),
            })
            .expect_err("embedded checkpoint credential material must be rejected");

        assert!(
            matches!(error, MemoryError::InvalidInput(message) if message.contains("credential"))
        );
    }
}

#[test]
fn rejected_credentials_never_create_memory_checkpoint_activity_or_audit_rows() {
    let project = TempProject::new("credential-no-storage");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Credential boundary project", None)
        .expect("register workspace");

    let memory_error = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Credential boundary".into(),
            body: "This record has ordinary prose.".into(),
            source: MemorySource::Agent,
            source_client: "deployment_token=replace-me-with-real-value".into(),
            session_id: Some("https://build-user:build-password@ci.example.invalid/run".into()),
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect_err("source metadata with a likely credential must be rejected");
    assert!(
        matches!(memory_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let checkpoint_error = store
        .checkpoint(NewCheckpoint {
            workspace_id: workspace.id.clone(),
            summary: "Checkpoint validation".into(),
            decisions: vec!["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.signature".into()],
            next_actions: Vec::new(),
            changed_paths: vec!["src/password=not-a-placeholder".into()],
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: Some("session-safe".into()),
            idempotency_key: None,
        })
        .expect_err("checkpoint content or changed paths with likely credentials must be rejected");
    assert!(
        matches!(checkpoint_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    for (session_id, relative_path, provider) in [
        (
            Some("gho_abcdefghijklmnopqrstuvwxyz1234567890"),
            Some("src/main.rs"),
            Some("codex"),
        ),
        (
            Some("session-safe"),
            Some("src/access_key=actual-value-123"),
            Some("codex"),
        ),
        (
            Some("session-safe"),
            Some("src/main.rs"),
            Some(concat!(
                "xoxb-",
                "123456789012-123456789012-abcdefghijklmnopqrstuvwxyz"
            )),
        ),
    ] {
        let activity_error = store
            .record_activity(NewActivity {
                workspace_id: workspace.id.clone(),
                kind: ActivityKind::ProviderLaunched,
                source: "kodade-ui".into(),
                session_id: session_id.map(str::to_owned),
                relative_path: relative_path.map(str::to_owned),
                provider: provider.map(str::to_owned),
                occurred_at: None,
            })
            .expect_err("activity metadata with a likely credential must be rejected");
        assert!(
            matches!(activity_error, MemoryError::InvalidInput(message) if message.contains("credential"))
        );
    }

    let connection = rusqlite::Connection::open(project.db()).expect("inspect rejected writes");
    for table in ["memories", "checkpoints", "activity_events", "mcp_audit"] {
        let count: u64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rejected rows");
        assert_eq!(count, 0, "rejected material must not create a {table} row");
    }
}

#[test]
fn authorization_credentials_are_rejected_before_any_public_store_write() {
    let project = TempProject::new("authorization-credential-boundary");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Authorization boundary project", None)
        .expect("register workspace");

    let memory_error = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Authorization regression".into(),
            body: "Bearer tokens are documented here; Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.signature".into(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect_err("a later JWT authorization value must not bypass validation");
    assert!(
        matches!(memory_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let checkpoint_error = store
        .checkpoint(NewCheckpoint {
            workspace_id: workspace.id.clone(),
            summary: "Authorization validation".into(),
            decisions: vec!["Authorization: Basic dXNlcjpwYXNzd29yZA==".into()],
            next_actions: Vec::new(),
            changed_paths: Vec::new(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            idempotency_key: None,
        })
        .expect_err("Basic authorization values must not be stored in checkpoints");
    assert!(
        matches!(checkpoint_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let activity_error = store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::ProviderLaunched,
            source: "kodade-ui".into(),
            session_id: Some("Authorization: Bearer opaque-oauth-value-123456".into()),
            relative_path: None,
            provider: Some("codex".into()),
            occurred_at: None,
        })
        .expect_err("opaque Bearer authorization values must not be captured as activity");
    assert!(
        matches!(activity_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let connection = rusqlite::Connection::open(project.db()).expect("inspect rejected writes");
    for table in ["memories", "checkpoints", "activity_events", "mcp_audit"] {
        let count: u64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rejected rows");
        assert_eq!(
            count, 0,
            "rejected authorization material must not create a {table} row"
        );
    }
}

#[test]
fn quoted_authorization_credentials_are_rejected_before_any_public_store_write() {
    let project = TempProject::new("quoted-authorization-credential-boundary");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(
            project.root(),
            "Quoted authorization boundary project",
            None,
        )
        .expect("register workspace");

    let memory_error = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Serialized authorization regression".into(),
            body: r#"{"Authorization":"Bearer opaque-oauth-value-123456"}"#.into(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect_err("a JSON-like Bearer authorization value must not be stored");
    assert!(
        matches!(memory_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let checkpoint_error = store
        .checkpoint(NewCheckpoint {
            workspace_id: workspace.id.clone(),
            summary: "Serialized authorization validation".into(),
            decisions: vec![r#"{"Authorization":"Basic dXNlcjpwYXNzd29yZA=="}"#.into()],
            next_actions: Vec::new(),
            changed_paths: Vec::new(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            idempotency_key: None,
        })
        .expect_err("a JSON-like Basic authorization value must not be stored");
    assert!(
        matches!(checkpoint_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let activity_error = store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::ProviderLaunched,
            source: "kodade-ui".into(),
            session_id: Some(
                r#"Benign prose comes first. {  \"aUtHoRiZaTiOn\" : \"bEaReR opaque-oauth-value-654321\" }"#
                    .into(),
            ),
            relative_path: None,
            provider: Some("codex".into()),
            occurred_at: None,
        })
        .expect_err("quoted, spaced, mixed-case authorization values must not be captured");
    assert!(
        matches!(activity_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let connection = rusqlite::Connection::open(project.db()).expect("inspect rejected writes");
    for table in ["memories", "checkpoints", "activity_events", "mcp_audit"] {
        let count: u64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rejected rows");
        assert_eq!(
            count, 0,
            "rejected quoted authorization material must not create a {table} row"
        );
    }
}

#[test]
fn escaped_json_credentials_are_rejected_before_any_public_store_write() {
    let project = TempProject::new("escaped-json-credential-boundary");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Escaped JSON credential boundary", None)
        .expect("register workspace");

    let memory_error = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Escaped bearer JSON".into(),
            body: r#"{"Authorization":"Bearer\u0020opaque-oauth-value-123456"}"#.into(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect_err("escaped Bearer whitespace must not be stored");
    assert!(
        matches!(memory_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let checkpoint_error = store
        .checkpoint(NewCheckpoint {
            workspace_id: workspace.id.clone(),
            summary: "Escaped scheme validation".into(),
            decisions: vec![r#"{"Authorization":"Be\u0061rer opaque-oauth-value-654321"}"#.into()],
            next_actions: Vec::new(),
            changed_paths: Vec::new(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            idempotency_key: None,
        })
        .expect_err("an escaped Bearer scheme must not be stored");
    assert!(
        matches!(checkpoint_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let activity_error = store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::ProviderLaunched,
            source: "kodade-ui".into(),
            session_id: Some(r#"{"Authorization":"Basic\u0020dXNlcjpwYXNzd29yZA=="}"#.into()),
            relative_path: None,
            provider: Some("codex".into()),
            occurred_at: None,
        })
        .expect_err("escaped Basic whitespace must not be captured");
    assert!(
        matches!(activity_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let assignment_error = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Spaced JSON assignment".into(),
            body: r#"{"API_KEY" : "opaque-production-value-123456"}"#.into(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect_err("normal JSON whitespace around a secret key must not be stored");
    assert!(
        matches!(assignment_error, MemoryError::InvalidInput(message) if message.contains("credential"))
    );

    let connection = rusqlite::Connection::open(project.db()).expect("inspect rejected writes");
    for table in ["memories", "checkpoints", "activity_events", "mcp_audit"] {
        let count: u64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rejected rows");
        assert_eq!(
            count, 0,
            "escaped credentials must not create a {table} row"
        );
    }
}

#[test]
fn authorization_header_prose_is_accepted_but_opaque_credentials_are_rejected() {
    let project = TempProject::new("authorization-prose-boundary");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Authorization prose boundary", None)
        .expect("register workspace");

    for (index, body) in [
        "Authorization: Bearer authentication is described in this guide",
        "Authorization: Basic authentication is described in this guide",
    ]
    .into_iter()
    .enumerate()
    {
        store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: format!("Authorization guide {index}"),
                body: body.into(),
                source: MemorySource::User,
                source_client: "kodade-ui".into(),
                session_id: None,
                pinned: false,
                idempotency_key: Some(format!("authorization-guide-{index}")),
                links: Vec::new(),
            })
            .unwrap_or_else(|error| panic!("explanatory header prose must be accepted: {error}"));
    }

    for (index, body) in [
        "Authorization: Bearer opaque-oauth-value-123456",
        "Authorization: Bearer abcdefghijklmnopqrstuv",
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    ]
    .into_iter()
    .enumerate()
    {
        let error = store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: "Authorization credential".into(),
                body: body.into(),
                source: MemorySource::User,
                source_client: "kodade-ui".into(),
                session_id: None,
                pinned: false,
                idempotency_key: Some(format!("authorization-credential-{index}")),
                links: Vec::new(),
            })
            .expect_err("opaque Authorization credentials must be rejected");
        assert!(
            matches!(error, MemoryError::InvalidInput(message) if message.contains("credential"))
        );
    }

    let connection = rusqlite::Connection::open(project.db()).expect("inspect boundary rows");
    let memory_count: u64 = connection
        .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        .expect("count accepted prose");
    let audit_count: u64 = connection
        .query_row("SELECT COUNT(*) FROM mcp_audit", [], |row| row.get(0))
        .expect("count accepted prose audit");
    assert_eq!(memory_count, 2);
    assert_eq!(audit_count, 2);
}

#[test]
fn credential_key_detection_rejects_secret_shapes_without_rejecting_development_metadata() {
    let project = TempProject::new("credential-key-shapes");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Credential key shapes project", None)
        .expect("register workspace");

    for (index, body) in [
        "token_budget=128000",
        "token_limit=200000",
        "passwordless=true",
        "Bearer tokens are documented here",
        "This guide explains authorization and bearer concepts without a credential value.",
        r#"{"Authorization":"Bearer <oauth-token>"}"#,
        "token=${TOKEN}; database_url=<database-url>",
    ]
    .into_iter()
    .enumerate()
    {
        store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: format!("Ordinary development metadata {index}"),
                body: body.into(),
                source: MemorySource::User,
                source_client: "kodade-ui".into(),
                session_id: None,
                pinned: false,
                idempotency_key: Some(format!("ordinary-metadata-{index}")),
                links: Vec::new(),
            })
            .expect("ordinary development metadata must remain storable");
    }

    for (index, body) in [
        "GITHUB_TOKEN=real-value",
        "OPENAI_API_KEY=real-value",
        "deployment_token=real-value",
        "password=real-value",
        "DATABASE_URL=postgres://user:password@db.example.invalid/kodade",
    ]
    .into_iter()
    .enumerate()
    {
        let error = store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: "Secret-shaped metadata".into(),
                body: body.into(),
                source: MemorySource::User,
                source_client: "kodade-ui".into(),
                session_id: None,
                pinned: false,
                idempotency_key: Some(format!("secret-shaped-{index}")),
                links: Vec::new(),
            })
            .expect_err("secret-shaped metadata must still be rejected");
        assert!(
            matches!(error, MemoryError::InvalidInput(message) if message.contains("credential"))
        );
    }
}

#[test]
fn likely_secret_detection_catches_known_forms_but_allows_explicit_templates() {
    let project = TempProject::new("credential-forms");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Credential forms project", None)
        .expect("register workspace");

    for (index, body) in [
        "GITHUB_OAUTH=gho_abcdefghijklmnopqrstuvwxyz1234567890",
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.signature",
        concat!(
            "SLACK_BOT_TOKEN=xoxb-",
            "123456789012-123456789012-abcdefghijklmnopqrstuvwxyz"
        ),
        "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
        "-----BEGIN PRIVATE KEY-----\\nnot-a-real-key",
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        "database_url=postgres://user:password@db.example.invalid/kodade",
    ]
    .into_iter()
    .enumerate()
    {
        let error = store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: "Known credential form".into(),
                body: body.into(),
                source: MemorySource::Agent,
                source_client: "kodade-mcp".into(),
                session_id: None,
                pinned: false,
                idempotency_key: Some(format!("credential-form-{index}")),
                links: Vec::new(),
            })
            .expect_err("known likely credential forms must be rejected");
        assert!(
            matches!(error, MemoryError::InvalidInput(message) if message.contains("credential"))
        );
    }

    for (index, body) in [
        "GITHUB_TOKEN=${GITHUB_TOKEN}",
        "DATABASE_URL=<database-url>",
    ]
    .into_iter()
    .enumerate()
    {
        let templated = store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: "Template stays safe".into(),
                body: body.into(),
                source: MemorySource::User,
                source_client: "kodade-ui".into(),
                session_id: None,
                pinned: false,
                idempotency_key: Some(format!("template-{index}")),
                links: Vec::new(),
            })
            .unwrap_or_else(|error| panic!("template {body} should be accepted: {error}"));
        assert_eq!(templated.body, body);
    }
}

#[test]
fn credential_rejection_covers_memory_links_and_checkpoint_changed_paths_before_writes() {
    let project = TempProject::new("credential-links-and-paths");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Credential link project", None)
        .expect("register workspace");
    let target = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Safe link target".into(),
            body: "This existing target makes the link otherwise valid.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("seed link target");
    let connection = rusqlite::Connection::open(project.db()).expect("inspect write counts");
    let before_memories: u64 = connection
        .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        .expect("count memories before rejection");
    let before_audit: u64 = connection
        .query_row("SELECT COUNT(*) FROM mcp_audit", [], |row| row.get(0))
        .expect("count audit before rejection");
    drop(connection);

    assert!(matches!(
        store.remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Unsafe link metadata".into(),
            body: "The record itself is safe.".into(),
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: vec![MemoryLink {
                target_id: target.id,
                relation: "private_key=actual-value-123".into(),
            }],
        }),
        Err(MemoryError::InvalidInput(message)) if message.contains("credential")
    ));
    assert!(matches!(
        store.checkpoint(NewCheckpoint {
            workspace_id: workspace.id.clone(),
            summary: "Safe handoff summary".into(),
            decisions: Vec::new(),
            next_actions: Vec::new(),
            changed_paths: vec!["config/password=actual-value-123".into()],
            source: MemorySource::Agent,
            source_client: "kodade-mcp".into(),
            session_id: None,
            idempotency_key: None,
        }),
        Err(MemoryError::InvalidInput(message)) if message.contains("credential")
    ));

    let connection = rusqlite::Connection::open(project.db()).expect("inspect rejected writes");
    let memories: u64 = connection
        .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        .expect("count memories after rejection");
    let audit: u64 = connection
        .query_row("SELECT COUNT(*) FROM mcp_audit", [], |row| row.get(0))
        .expect("count audit after rejection");
    assert_eq!(memories, before_memories);
    assert_eq!(audit, before_audit);
}

#[test]
fn retained_tombstones_are_discoverable_after_reopen_and_can_be_restored() {
    let project = TempProject::new("discoverable-tombstone");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Discoverable tombstone project", None)
        .expect("register workspace");
    let memory = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Restore after reload".into(),
            body: "Recently deleted records remain discoverable during retention.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("create restorable memory");
    let tombstone = store
        .forget(&memory.id, memory.version, "kodade-ui", None)
        .expect("delete restorable memory");
    drop(store);

    let reloaded = MemoryStore::open(project.db()).expect("reload store");
    let deleted = reloaded
        .deleted_memories(&workspace.id, 20)
        .expect("list retained deleted memories after reopening KödMem");
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].id, memory.id);
    assert_eq!(deleted[0].deleted_at, Some(tombstone.deleted_at));

    reloaded
        .restore(&memory.id, tombstone.version, "kodade-ui", None)
        .expect("restore rediscovered tombstone");
    assert!(reloaded
        .deleted_memories(&workspace.id, 20)
        .expect("refresh deleted memories after restore")
        .is_empty());
}

#[test]
fn retention_mutations_audit_caller_provenance_while_purge_removes_that_history() {
    let project = TempProject::new("retention-provenance");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Retention provenance project", None)
        .expect("register workspace");
    let provenance = MutationProvenance {
        source_client: "kodade-ui".into(),
        session_id: Some("settings-session".into()),
    };

    store
        .set_retention(
            &workspace.id,
            RetentionSettings {
                capture_paused: false,
                activity_days: 7,
                audit_days: 30,
                tombstone_days: 7,
            },
            provenance.clone(),
        )
        .expect("set retention with caller provenance");
    store
        .run_retention(
            &workspace.id,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_millis() as i64,
            100,
            provenance.clone(),
        )
        .expect("run retention with caller provenance");

    let audit = store
        .audit(&workspace.id, 20)
        .expect("read retention audit");
    assert_eq!(
        audit
            .iter()
            .map(|entry| entry.action.as_str())
            .collect::<Vec<_>>(),
        vec!["run_retention", "set_retention"]
    );
    assert!(audit
        .iter()
        .all(|entry| entry.client == provenance.source_client));
    assert!(audit
        .iter()
        .all(|entry| entry.session_id.as_deref() == provenance.session_id.as_deref()));
    assert!(audit.iter().all(|entry| entry.occurred_at > 0));

    // Purge is intentionally exceptional: the workspace foreign-key cascade
    // deletes its audit history, so recording a purge audit would be dishonest.
    store
        .purge_workspace(&workspace.id)
        .expect("purge removes KödMem data and its audit history");
    assert!(matches!(
        store.workspace(&workspace.id),
        Err(MemoryError::WorkspaceNotRegistered(_))
    ));
    let connection = rusqlite::Connection::open(project.db()).expect("inspect purge cascade");
    let audit_rows: u64 = connection
        .query_row("SELECT COUNT(*) FROM mcp_audit", [], |row| row.get(0))
        .expect("count purged audit history");
    assert_eq!(audit_rows, 0);
}

#[test]
fn workspace_context_projects_hub_decisions_tasks_and_latest_checkpoint() {
    let project = TempProject::new("context");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Context project", None)
        .expect("register workspace");
    for (kind, title, pinned, key) in [
        (MemoryKind::Decision, "Use SQLite", true, "decision"),
        (MemoryKind::Task, "Wire the UI", false, "task"),
        (MemoryKind::Fact, "Not a hub section", false, "fact"),
    ] {
        store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind,
                title: title.into(),
                body: format!("{title} body"),
                source: MemorySource::User,
                source_client: "kodade-ui".into(),
                session_id: None,
                pinned,
                idempotency_key: Some(key.into()),
                links: Vec::new(),
            })
            .expect("remember context item");
    }
    let checkpoint = store
        .checkpoint(NewCheckpoint {
            workspace_id: workspace.id.clone(),
            summary: "Core storage is ready.".into(),
            decisions: Vec::new(),
            next_actions: vec!["Build the Hub.".into()],
            changed_paths: Vec::new(),
            source: MemorySource::Agent,
            source_client: "codex".into(),
            session_id: Some("m8c".into()),
            idempotency_key: None,
        })
        .expect("checkpoint context");

    let context = store.context(&workspace.id).expect("load hub context");
    assert_eq!(context.workspace.id, workspace.id);
    assert_eq!(context.pinned_decisions[0].title, "Use SQLite");
    assert_eq!(context.open_tasks[0].title, "Wire the UI");
    assert_eq!(context.latest_checkpoint.unwrap().id, checkpoint.id);
    assert_eq!(context.recent_memories.len(), 3);
}

#[test]
fn activity_capture_is_typed_path_confined_and_pauseable() {
    let project = TempProject::new("activity");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Activity project", None)
        .expect("register workspace");
    let recorded = store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::FileSaved,
            source: "kodade-ui".into(),
            session_id: Some("session-1".into()),
            relative_path: Some("src/main.rs".into()),
            provider: None,
            occurred_at: Some(1_700_000_000_000),
        })
        .expect("record low-sensitivity metadata")
        .expect("capture is active");
    assert_eq!(recorded.relative_path.as_deref(), Some("src/main.rs"));

    let escaped = store
        .record_activity(NewActivity {
            workspace_id: workspace.id.clone(),
            kind: ActivityKind::FileOpened,
            source: "kodade-ui".into(),
            session_id: None,
            relative_path: Some("../secrets.env".into()),
            provider: None,
            occurred_at: None,
        })
        .expect_err("activity path cannot escape workspace");
    assert!(matches!(escaped, MemoryError::InvalidInput(_)));

    store
        .set_retention(
            &workspace.id,
            RetentionSettings {
                capture_paused: true,
                activity_days: 30,
                audit_days: 30,
                tombstone_days: 30,
            },
            test_provenance(),
        )
        .expect("pause capture");
    let paused = store
        .record_activity(NewActivity {
            workspace_id: workspace.id,
            kind: ActivityKind::SessionStarted,
            source: "kodade-ui".into(),
            session_id: Some("session-2".into()),
            relative_path: None,
            provider: Some("codex".into()),
            occurred_at: None,
        })
        .expect("paused capture is not an error");
    assert!(paused.is_none());
}

#[test]
fn mutation_audit_records_metadata_without_memory_bodies() {
    let project = TempProject::new("audit");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Audit project", None)
        .expect("register workspace");
    let created = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Preference,
            title: "Private body check".into(),
            body: "DO-NOT-LEAK-THIS-BODY".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: Some("ui-session".into()),
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("remember preference");
    store
        .forget(&created.id, 1, "kodade-ui", Some("ui-session"))
        .expect("forget preference");

    let entries = store.audit(&workspace.id, 20).expect("read audit");
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.action.as_str())
            .collect::<Vec<_>>(),
        vec!["forget", "remember"]
    );
    assert!(entries.iter().all(|entry| entry.client == "kodade-ui"));
    assert!(entries
        .iter()
        .all(|entry| entry.target_id.as_deref() == Some(created.id.as_str())));
    assert!(!serde_json::to_string(&entries)
        .expect("serialize audit")
        .contains("DO-NOT-LEAK-THIS-BODY"));
}

#[test]
fn checkpoint_round_trips_structured_handoff_and_is_full_text_searchable() {
    let project = TempProject::new("checkpoint");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Checkpoint project", None)
        .expect("register workspace");
    let input = NewCheckpoint {
        workspace_id: workspace.id.clone(),
        summary: "The WAL-backed memory core is green.".into(),
        decisions: vec!["Keep one transport-independent Rust module.".into()],
        next_actions: vec!["Wire typed Tauri commands.".into()],
        changed_paths: vec!["src-tauri/src/memory.rs".into()],
        source: MemorySource::Agent,
        source_client: "codex".into(),
        session_id: Some("m8c-worker".into()),
        idempotency_key: Some("checkpoint-1".into()),
    };
    let created = store.checkpoint(input.clone()).expect("write checkpoint");
    let retried = store.checkpoint(input).expect("retry checkpoint");

    assert_eq!(
        created.decisions,
        vec!["Keep one transport-independent Rust module."]
    );
    assert_eq!(created.next_actions, vec!["Wire typed Tauri commands."]);
    assert_eq!(created.changed_paths, vec!["src-tauri/src/memory.rs"]);
    assert_eq!(retried, created);
    assert_eq!(store.audit(&workspace.id, 20).unwrap().len(), 1);
    let page = store
        .search_checkpoints(CheckpointQuery {
            workspace_id: workspace.id,
            text: "WAL memory".into(),
            limit: 20,
            offset: 0,
        })
        .expect("search checkpoints");
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].id, created.id);
    assert!(page.items[0].excerpt.contains("WAL"));
}

#[test]
fn workspace_scope_resolves_only_registered_canonical_roots() {
    let project = TempProject::new("scope");
    let outside = TempProject::new("outside-scope");
    let store = MemoryStore::open(project.db()).expect("open store");
    let registered = store
        .register_workspace(project.root(), "Scoped project", Some("mauve"))
        .expect("register workspace");

    let reopened = MemoryStore::open(project.db()).expect("reopen store");
    let resolved = reopened
        .resolve_workspace(project.root())
        .expect("resolve registered root");
    assert_eq!(resolved.id, registered.id);
    assert_eq!(resolved.color.as_deref(), Some("mauve"));

    let error = reopened
        .resolve_workspace(outside.root())
        .expect_err("outside root must not acquire scope");
    assert!(matches!(error, MemoryError::WorkspaceNotRegistered(_)));
}

#[test]
fn relinking_a_moved_workspace_preserves_its_generated_identity() {
    let project = TempProject::new("relink");
    let old_root = project.root().join("old-location");
    let new_root = project.root().join("new-location");
    std::fs::create_dir(&old_root).expect("create old root");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(&old_root, "Moved project", None)
        .expect("register old root");
    std::fs::rename(&old_root, &new_root).expect("move workspace");

    let listed = store
        .workspaces()
        .expect("list workspaces after old root disappears");
    assert_eq!(listed, vec![workspace.clone()]);

    let relinked = store
        .relink_workspace(
            &workspace.id,
            &workspace.canonical_root,
            &new_root,
            "kodade-ui",
        )
        .expect("relink moved workspace");

    assert_eq!(relinked.id, workspace.id);
    assert_eq!(
        store
            .resolve_workspace(&new_root)
            .expect("resolve new root")
            .id,
        workspace.id
    );
    assert_eq!(
        store.audit(&workspace.id, 20).expect("relink audit")[0].action,
        "relink_workspace"
    );
}

#[test]
fn projects_vault_mapping_persists_stable_identity_across_workspace_locations() {
    let app_data = TempProject::new("projects-vault-mapping");
    let vault = TempProject::new("projects-vault");
    std::fs::create_dir(vault.root().join(".obsidian")).expect("create Obsidian config");
    std::fs::create_dir(vault.root().join("10-Projects")).expect("create projects folder");
    let first_checkout = app_data.root().join("checkout-a");
    let second_checkout = app_data.root().join("checkout-b");
    std::fs::create_dir(&first_checkout).expect("create first checkout");
    std::fs::create_dir(&second_checkout).expect("create second checkout");

    let store = MemoryStore::open(app_data.db()).expect("open store");
    let registered_vault = store
        .register_projects_vault(vault.root())
        .expect("register projects vault");
    let first = store
        .register_workspace(&first_checkout, "First checkout", None)
        .expect("register first checkout");
    let second = store
        .register_workspace(&second_checkout, "Second checkout", None)
        .expect("register second checkout");

    let first_mapping = store
        .map_workspace_to_project(&first.id, None, "portable-project", "Portable project")
        .expect("map first checkout");
    let second_mapping = store
        .map_workspace_to_project(&second.id, None, "portable-project", "Portable project")
        .expect("map second checkout");

    assert_eq!(first_mapping.project_id, "portable-project");
    assert_eq!(second_mapping.project_id, first_mapping.project_id);
    assert_ne!(first_mapping.workspace_id, second_mapping.workspace_id);
    let current_vault = store
        .projects_vault()
        .expect("read registered vault")
        .expect("vault remains configured");
    assert_eq!(current_vault.projects[0].id, "portable-project");
    assert!(current_vault.projects[0].folder_exists);
    assert!(
        std::fs::read_dir(vault.root().join("10-Projects/portable-project"))
            .expect("read portable identity folder")
            .next()
            .is_none(),
        "identity registration must create only an empty portable identity folder"
    );

    drop(store);
    let reopened = MemoryStore::open(app_data.db()).expect("reopen store");
    let persisted_vault = reopened
        .projects_vault()
        .expect("read projects vault")
        .expect("projects vault remains configured");
    assert_eq!(
        persisted_vault.canonical_root,
        registered_vault.canonical_root
    );
    assert_eq!(persisted_vault.projects[0].id, "portable-project");
    assert_eq!(
        reopened
            .workspace_project_mapping(&second.id)
            .expect("read mapping")
            .expect("mapping remains configured")
            .project_id,
        "portable-project"
    );
    assert_eq!(
        reopened
            .project_workspace_mappings("portable-project")
            .expect("list project workspaces")
            .len(),
        2
    );

    let other_machine = TempProject::new("projects-vault-other-machine");
    let other_checkout = other_machine.root().join("checkout");
    std::fs::create_dir(&other_checkout).expect("create checkout on another machine");
    let other_store = MemoryStore::open(other_machine.db()).expect("open fresh machine store");
    let discovered = other_store
        .register_projects_vault(vault.root())
        .expect("register the same projects vault on another machine");
    assert_eq!(
        discovered
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        vec!["portable-project"]
    );
    assert_eq!(
        discovered.projects[0].display_name, "portable-project",
        "fresh stores discover the portable ID without inventing a second naming policy"
    );
    let other_workspace = other_store
        .register_workspace(&other_checkout, "Portable checkout", None)
        .expect("register another machine checkout");
    let other_mapping = other_store
        .map_workspace_to_project(
            &other_workspace.id,
            None,
            "portable-project",
            "Portable project",
        )
        .expect("map the fresh machine by portable identity");
    assert_eq!(other_mapping.project_id, "portable-project");
}

#[test]
fn mapped_project_context_indexes_approved_markdown_and_refreshes_external_edits() {
    let app_data = TempProject::new("mapped-project-context");
    let vault = TempProject::new("mapped-project-context-vault");
    std::fs::create_dir(vault.root().join(".obsidian")).expect("create Obsidian config");
    let project_root = vault.root().join("10-Projects/portable-project");
    std::fs::create_dir_all(project_root.join("Worklog/2026")).expect("create worklog folder");
    std::fs::create_dir(project_root.join("Decisions")).expect("create decisions folder");
    std::fs::create_dir(project_root.join("Knowledge")).expect("create knowledge folder");
    let project_hub = format!(
        "---\ntitle: Portable project\ntype: project\n---\n# Portable project\n\nStable project charter.\n{}",
        "p".repeat(5_000)
    );
    std::fs::write(project_root.join("Project.md"), project_hub).expect("write project hub");
    let initial_state = "---\ntitle: Portable state\ntype: state\n---\n# Current state\n\nObsidian edit alpha is current.\n";
    std::fs::write(project_root.join("STATE.md"), initial_state).expect("write state");
    for day in 1..=4 {
        std::fs::write(
            project_root.join(format!("Worklog/2026/2026-08-0{day}.md")),
            format!(
                "---\ntitle: Day {day}\ntype: worklog\n---\n# Day {day}\n\nDaily result {day}.\n"
            ),
        )
        .expect("write daily worklog");
    }
    std::fs::write(
        project_root.join("Worklog/README.md"),
        "# Worklog guide\n\nThis is not a daily worklog entry.\n",
    )
    .expect("write non-daily worklog documentation");
    std::fs::write(
        project_root.join("Decisions/accepted.md"),
        "---\ntitle: Accepted choice\ntype: decision\nstatus: accepted\n---\n# Accepted choice\n\nUse the bounded vault index.\n",
    )
    .expect("write accepted decision");
    std::fs::write(
        project_root.join("Decisions/proposed.md"),
        "---\ntitle: Proposed choice\ntype: decision\nstatus: proposed\n---\n# Proposed choice\n\nDo not expose this proposal.\n",
    )
    .expect("write proposed decision");
    std::fs::write(
        project_root.join("Knowledge/approved.md"),
        "---\ntitle: Approved knowledge\ntype: knowledge\nstatus: approved\n---\n# Approved knowledge\n\nThe stable knowledge phrase is searchable.\n",
    )
    .expect("write approved knowledge");
    std::fs::write(
        project_root.join("Knowledge/draft.md"),
        "---\ntitle: Draft knowledge\ntype: knowledge\nstatus: draft\n---\n# Draft knowledge\n\nDo not expose this draft.\n",
    )
    .expect("write draft knowledge");
    std::fs::write(
        project_root.join("Knowledge/oversized.md"),
        format!(
            "---\ntitle: {}\ntype: knowledge\nstatus: approved\n---\n# Oversized knowledge\n\n{}",
            "T".repeat(10_000),
            "\u{0001}".repeat(20_000),
        ),
    )
    .expect("write serialization stress knowledge");

    let checkout = app_data.root().join("checkout");
    std::fs::create_dir(&checkout).expect("create checkout");
    let store = MemoryStore::open(app_data.db()).expect("open store");
    store
        .register_projects_vault(vault.root())
        .expect("register projects vault");
    let workspace = store
        .register_workspace(&checkout, "Portable checkout", None)
        .expect("register workspace");
    store
        .map_workspace_to_project(&workspace.id, None, "portable-project", "Portable project")
        .expect("map workspace");

    let context = store.context(&workspace.id).expect("load mapped context");
    let serialized_context = serde_json::to_vec(&context).expect("serialize get_context result");
    assert!(
        serialized_context.len() <= 34 * 1024,
        "the complete structured get_context response must stay within its explicit bound"
    );
    let knowledge = context
        .project_knowledge
        .as_ref()
        .expect("mapped project knowledge context");
    assert_eq!(knowledge.project_id, "portable-project");
    assert_eq!(knowledge.sync.status, ProjectKnowledgeSyncStatus::Current);
    assert!(knowledge.sync.truncated);
    assert_eq!(
        knowledge.origin,
        project_root
            .canonicalize()
            .expect("canonical mapped project root")
            .to_string_lossy()
    );
    assert_eq!(
        knowledge
            .sources
            .iter()
            .map(|source| source.relative_path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "Project.md",
            "STATE.md",
            "Worklog/2026/2026-08-04.md",
            "Worklog/2026/2026-08-03.md",
            "Worklog/2026/2026-08-02.md",
            "Decisions/accepted.md",
            "Knowledge/approved.md",
            "Knowledge/oversized.md",
        ],
        "context includes required notes, three recent days, and only approved durable notes"
    );
    assert!(knowledge
        .sources
        .iter()
        .all(|source| source.sha256.len() == 64));
    let project_source = knowledge
        .sources
        .iter()
        .find(|source| source.relative_path == "Project.md")
        .expect("bounded project source");
    assert!(project_source.truncated);
    assert_eq!(project_source.content.chars().count(), 4_000);
    assert!(
        knowledge
            .sources
            .iter()
            .map(|source| source.content.chars().count())
            .sum::<usize>()
            <= 24_000
    );
    let oversized = knowledge
        .sources
        .iter()
        .find(|source| source.relative_path == "Knowledge/oversized.md")
        .expect("bounded stress source");
    assert!(oversized.title.chars().count() <= 200);
    let state = knowledge
        .sources
        .iter()
        .find(|source| source.relative_path == "STATE.md")
        .expect("state provenance");
    assert_eq!(
        state.sha256,
        format!("{:x}", Sha256::digest(initial_state.as_bytes()))
    );

    let approved = store
        .search(MemoryQuery {
            workspace_id: workspace.id.clone(),
            text: "stable knowledge phrase".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("search approved mapped knowledge");
    assert_eq!(approved.total, 1);
    let provenance = approved.items[0]
        .project_source
        .as_ref()
        .expect("mapped search provenance");
    assert_eq!(provenance.project_id, "portable-project");
    assert_eq!(provenance.relative_path, "Knowledge/approved.md");
    assert_eq!(provenance.sha256.len(), 64);
    assert_eq!(
        store
            .search(MemoryQuery {
                workspace_id: workspace.id.clone(),
                text: "stable knowledge phrase".into(),
                kinds: Vec::new(),
                sources: vec![MemorySource::Kodade],
                updated_after: None,
                limit: 20,
                offset: 0,
            })
            .unwrap()
            .total,
        1,
        "ordinary approved project notes retain Ködade provenance"
    );
    assert_eq!(
        store
            .search(MemoryQuery {
                workspace_id: workspace.id.clone(),
                text: "stable knowledge phrase".into(),
                kinds: Vec::new(),
                sources: vec![MemorySource::Agent],
                updated_after: None,
                limit: 20,
                offset: 0,
            })
            .unwrap()
            .total,
        0,
        "ordinary project notes never masquerade as canonical agent memories"
    );

    let edited_state = initial_state.replace("Obsidian edit alpha", "Obsidian edit beta");
    std::fs::write(project_root.join("STATE.md"), &edited_state).expect("edit state in Obsidian");
    let refreshed = store
        .context(&workspace.id)
        .expect("refresh mapped context");
    let refreshed_state = refreshed
        .project_knowledge
        .expect("refreshed mapped context")
        .sources
        .into_iter()
        .find(|source| source.relative_path == "STATE.md")
        .expect("refreshed state source");
    assert!(refreshed_state.content.contains("Obsidian edit beta"));
    assert_ne!(refreshed_state.sha256, state.sha256);
    assert_eq!(
        store
            .search(MemoryQuery {
                workspace_id: workspace.id,
                text: "Obsidian edit beta".into(),
                kinds: Vec::new(),
                sources: Vec::new(),
                updated_after: None,
                limit: 20,
                offset: 0,
            })
            .expect("search externally edited state")
            .total,
        1
    );
}

#[test]
fn mapped_project_context_is_confined_and_isolated_between_projects() {
    let app_data = TempProject::new("mapped-project-isolation");
    let vault = TempProject::new("mapped-project-isolation-vault");
    std::fs::create_dir(vault.root().join(".obsidian")).expect("create Obsidian config");
    std::fs::create_dir(vault.root().join("10-Projects")).expect("create projects folder");
    for (project_id, marker) in [
        ("alpha-project", "alpha-only-orchid"),
        ("beta-project", "beta-only-lantern"),
    ] {
        let root = vault.root().join("10-Projects").join(project_id);
        std::fs::create_dir(&root).expect("create mapped project");
        std::fs::write(
            root.join("Project.md"),
            format!("---\ntitle: {project_id}\n---\n# {project_id}\n\n{marker}\n"),
        )
        .expect("write project hub");
        std::fs::write(root.join("STATE.md"), "# State\n\nReady.\n").expect("write state");
    }

    let alpha_checkout = app_data.root().join("alpha-checkout");
    let beta_checkout = app_data.root().join("beta-checkout");
    std::fs::create_dir(&alpha_checkout).expect("create alpha checkout");
    std::fs::create_dir(&beta_checkout).expect("create beta checkout");
    let store = MemoryStore::open(app_data.db()).expect("open store");
    store
        .register_projects_vault(vault.root())
        .expect("register vault");
    let alpha = store
        .register_workspace(&alpha_checkout, "Alpha", None)
        .expect("register alpha");
    let beta = store
        .register_workspace(&beta_checkout, "Beta", None)
        .expect("register beta");
    store
        .map_workspace_to_project(&alpha.id, None, "alpha-project", "Alpha")
        .expect("map alpha");
    store
        .map_workspace_to_project(&beta.id, None, "beta-project", "Beta")
        .expect("map beta");

    let alpha_context = store.context(&alpha.id).expect("load alpha context");
    let alpha_knowledge = alpha_context.project_knowledge.expect("alpha knowledge");
    assert!(alpha_knowledge
        .sources
        .iter()
        .any(|source| source.content.contains("alpha-only-orchid")));
    assert!(!alpha_knowledge
        .sources
        .iter()
        .any(|source| source.content.contains("beta-only-lantern")));
    let alpha_search = store
        .search(MemoryQuery {
            workspace_id: alpha.id.clone(),
            text: "beta-only-lantern".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("search alpha");
    assert_eq!(alpha_search.total, 0, "alpha cannot search beta knowledge");

    std::fs::remove_file(vault.root().join("10-Projects/alpha-project/STATE.md"))
        .expect("remove required alpha state");
    let error_context = store
        .context(&alpha.id)
        .expect("load structured sync error");
    let error = error_context.project_knowledge.expect("mapped sync state");
    assert_eq!(error.sync.status, ProjectKnowledgeSyncStatus::Error);
    assert!(error.sync.error.as_deref().is_some_and(|message| {
        message.contains("STATE.md") && message.contains("Repair the mapped project folder")
    }));
    assert!(error.sources.is_empty());
    assert_eq!(
        store
            .search(MemoryQuery {
                workspace_id: alpha.id.clone(),
                text: "alpha-only-orchid".into(),
                kinds: Vec::new(),
                sources: Vec::new(),
                updated_after: None,
                limit: 20,
                offset: 0,
            })
            .expect("search failed mapping")
            .total,
        0,
        "a failed refresh never serves stale indexed project knowledge"
    );
    assert_eq!(
        store
            .search(MemoryQuery {
                workspace_id: beta.id,
                text: "beta-only-lantern".into(),
                kinds: Vec::new(),
                sources: Vec::new(),
                updated_after: None,
                limit: 20,
                offset: 0,
            })
            .expect("search beta after alpha failure")
            .total,
        1
    );

    let alpha_root = vault.root().join("10-Projects/alpha-project");
    std::fs::write(alpha_root.join("STATE.md"), "# State\n\nRestored.\n")
        .expect("restore required state");
    std::fs::create_dir(alpha_root.join("Knowledge")).expect("create knowledge folder");
    let likely_credential = format!("{}{}", "ghp_", "a".repeat(30));
    std::fs::write(
        alpha_root.join("Knowledge/private.md"),
        format!(
            "---\ntitle: Private token\nstatus: approved\n---\n# Private token\n\n{likely_credential}\n"
        ),
    )
    .expect("write unsafe approved knowledge");
    let credential_error = store.context(&alpha.id).expect("reject likely credential");
    let credential_sync = credential_error
        .project_knowledge
        .expect("mapped credential sync state")
        .sync;
    assert_eq!(credential_sync.status, ProjectKnowledgeSyncStatus::Error);
    assert!(credential_sync
        .error
        .as_deref()
        .is_some_and(|message| message.contains("contains likely credentials")));
}

#[test]
fn portable_idempotency_is_scoped_to_each_logical_project() {
    let app_data = TempProject::new("portable-project-idempotency");
    let vault = TempProject::new("portable-project-idempotency-vault");
    std::fs::create_dir(vault.root().join(".obsidian")).unwrap();
    std::fs::create_dir(vault.root().join("10-Projects")).unwrap();
    let store = MemoryStore::open(app_data.db()).unwrap();
    store.register_projects_vault(vault.root()).unwrap();
    let mut records = Vec::new();
    for project_id in ["portable-alpha", "portable-beta"] {
        let checkout = app_data.root().join(format!("{project_id}-checkout"));
        std::fs::create_dir(&checkout).unwrap();
        let workspace = store
            .register_workspace(&checkout, project_id, None)
            .unwrap();
        store
            .map_workspace_to_project(&workspace.id, None, project_id, project_id)
            .unwrap();
        let plan = store.preview_project_scaffold(&workspace.id).unwrap();
        store
            .apply_project_scaffold(&workspace.id, &plan.fingerprint)
            .unwrap();
        records.push(
            store
                .remember(NewMemory {
                    workspace_id: workspace.id,
                    kind: MemoryKind::Fact,
                    title: "Same portable payload".into(),
                    body: "The key is isolated by logical project.".into(),
                    source: MemorySource::Agent,
                    source_client: "memory-store-test".into(),
                    session_id: None,
                    pinned: false,
                    idempotency_key: Some("same-key".into()),
                    links: Vec::new(),
                })
                .unwrap(),
        );
    }
    assert_ne!(records[0].id, records[1].id);
    assert_ne!(
        records[0].project_source.as_ref().unwrap().project_id,
        records[1].project_source.as_ref().unwrap().project_id
    );
    for record in records {
        assert!(vault
            .root()
            .join("10-Projects")
            .join(&record.project_source.as_ref().unwrap().project_id)
            .join(&record.project_source.as_ref().unwrap().relative_path)
            .is_file());
    }
}

#[test]
fn fresh_read_only_store_preserves_canonical_source_and_marker_metadata() {
    let fixture = MappedProjectsVault::new("portable-read-metadata-writer", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let user = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "User-owned portable fact".into(),
            body: "fresh-user-source-token".into(),
            source: MemorySource::User,
            source_client: "memory-store-test".into(),
            session_id: Some("metadata-source".into()),
            pinned: false,
            idempotency_key: Some("metadata-user".into()),
            links: Vec::new(),
        })
        .unwrap();
    let agent = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Agent-owned portable decision".into(),
            body: "fresh-agent-source-token".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: Some("metadata-source".into()),
            pinned: true,
            idempotency_key: Some("metadata-agent".into()),
            links: Vec::new(),
        })
        .unwrap();

    let reader_data = TempProject::new("portable-read-metadata-reader");
    let reader_checkout = reader_data.root().join("checkout");
    std::fs::create_dir(&reader_checkout).unwrap();
    let reader = MemoryStore::open(reader_data.db()).unwrap();
    reader.register_projects_vault(&fixture.vault_root).unwrap();
    let reader_workspace = reader
        .register_workspace(&reader_checkout, "Portable reader", None)
        .unwrap();
    reader
        .map_workspace_to_project(
            &reader_workspace.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    drop(reader);

    let read_only = MemoryStore::open_read_only(reader_data.db()).unwrap();
    let user_hits = read_only
        .search(MemoryQuery {
            workspace_id: reader_workspace.id.clone(),
            text: "fresh-user-source-token".into(),
            kinds: Vec::new(),
            sources: vec![MemorySource::User],
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(user_hits.total, 1);
    assert_eq!(user_hits.items[0].source, MemorySource::User);
    assert_eq!(user_hits.items[0].pinned, user.pinned);
    assert_eq!(user_hits.items[0].version, user.version);
    assert_eq!(user_hits.items[0].updated_at, user.updated_at);

    let agent_hits = read_only
        .search(MemoryQuery {
            workspace_id: reader_workspace.id,
            text: "fresh-agent-source-token".into(),
            kinds: Vec::new(),
            sources: vec![MemorySource::Agent],
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(agent_hits.total, 1);
    let hit = &agent_hits.items[0];
    assert_eq!(hit.source, MemorySource::Agent);
    assert_eq!(hit.pinned, agent.pinned);
    assert_eq!(hit.version, agent.version);
    assert_eq!(hit.updated_at, agent.updated_at);
    assert_ne!(hit.id, agent.id, "projection IDs stay workspace-local");
    assert_eq!(
        hit.project_source
            .as_ref()
            .map(|source| source.sha256.len()),
        Some(64)
    );
}

#[test]
fn same_database_read_only_search_prefers_fresh_canonical_markdown_without_duplicates() {
    let fixture = MappedProjectsVault::new("portable-read-same-db-dedupe", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let created = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Projected canonical title".into(),
            body: "same-db-duplicate-token remains searchable after a human edit.".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: Some("same-db-dedupe".into()),
            pinned: true,
            idempotency_key: Some("same-db-dedupe".into()),
            links: Vec::new(),
        })
        .unwrap();
    let source = created.project_source.as_ref().unwrap();
    let canonical_path = fixture.project_root().join(&source.relative_path);
    let edited = std::fs::read_to_string(&canonical_path).unwrap().replacen(
        "title: \"Projected canonical title\"",
        "title: \"Fresh human title\"",
        1,
    );
    std::fs::write(&canonical_path, edited).unwrap();
    let edited_hash = file_hash(&canonical_path);
    std::fs::write(
        fixture.project_root().join("Knowledge/manual.md"),
        "---\ntitle: Manual project note\ntype: knowledge\nstatus: approved\n---\n# Manual project note\n\nordinary-project-doc-token\n",
    )
    .unwrap();
    let read_only = MemoryStore::open_read_only(fixture._app_data.db()).unwrap();
    let canonical = read_only
        .search(MemoryQuery {
            workspace_id: fixture.workspace.id.clone(),
            text: "same-db-duplicate-token".into(),
            kinds: Vec::new(),
            sources: vec![MemorySource::Agent],
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(canonical.total, 1);
    assert_eq!(canonical.items.len(), 1);
    assert_eq!(canonical.items[0].id, created.id);
    assert_eq!(canonical.items[0].title, "Fresh human title");
    assert_eq!(canonical.items[0].source, MemorySource::Agent);
    assert!(canonical.items[0].pinned);
    assert_eq!(canonical.items[0].version, created.version);
    assert_eq!(
        canonical.items[0]
            .project_source
            .as_ref()
            .map(|source| source.sha256.as_str()),
        Some(edited_hash.as_str())
    );

    let ordinary = read_only
        .search(MemoryQuery {
            workspace_id: fixture.workspace.id.clone(),
            text: "ordinary-project-doc-token".into(),
            kinds: Vec::new(),
            sources: vec![MemorySource::Kodade],
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(ordinary.total, 1);
    assert_eq!(ordinary.items[0].title, "Manual project note");
    assert_eq!(ordinary.items[0].source, MemorySource::Kodade);
}

#[test]
fn read_only_store_refreshes_mapped_markdown_without_writing_the_index() {
    let app_data = TempProject::new("mapped-project-read-only");
    let vault = TempProject::new("mapped-project-read-only-vault");
    std::fs::create_dir(vault.root().join(".obsidian")).expect("create Obsidian config");
    let project_root = vault.root().join("10-Projects/portable-project");
    std::fs::create_dir_all(&project_root).expect("create project folder");
    std::fs::write(
        project_root.join("Project.md"),
        "# Portable\n\nInitial beacon.\n",
    )
    .expect("write project hub");
    std::fs::write(project_root.join("STATE.md"), "# State\n\nInitial state.\n")
        .expect("write state");
    let checkout = app_data.root().join("checkout");
    std::fs::create_dir(&checkout).expect("create checkout");
    let writable = MemoryStore::open(app_data.db()).expect("open writable store");
    writable
        .register_projects_vault(vault.root())
        .expect("register vault");
    let workspace = writable
        .register_workspace(&checkout, "Portable", None)
        .expect("register workspace");
    writable
        .map_workspace_to_project(&workspace.id, None, "portable-project", "Portable")
        .expect("map workspace");
    writable.context(&workspace.id).expect("seed derived index");
    drop(writable);

    std::fs::write(
        project_root.join("STATE.md"),
        "# State\n\nExternal readonly-refresh-comet edit.\n",
    )
    .expect("edit mapped state");
    let read_only = MemoryStore::open_read_only(app_data.db()).expect("open read-only store");
    let context = read_only
        .context(&workspace.id)
        .expect("refresh read-only context");
    assert!(context
        .project_knowledge
        .expect("mapped project knowledge")
        .sources
        .iter()
        .any(|source| source.content.contains("readonly-refresh-comet")));
    let search = read_only
        .search(MemoryQuery {
            workspace_id: workspace.id,
            text: "readonly-refresh-comet".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("search read-only mapped project");
    assert_eq!(search.total, 1);
    assert_eq!(
        search.items[0]
            .project_source
            .as_ref()
            .map(|source| source.relative_path.as_str()),
        Some("STATE.md")
    );
}

#[test]
fn mapped_project_identity_survives_relinking_a_workspace_root() {
    let app_data = TempProject::new("mapped-workspace-relink");
    let vault = TempProject::new("mapped-workspace-relink-vault");
    std::fs::create_dir(vault.root().join(".obsidian")).expect("create Obsidian config");
    std::fs::create_dir(vault.root().join("10-Projects")).expect("create projects folder");
    let old_root = app_data.root().join("old-checkout");
    let new_root = app_data.root().join("new-checkout");
    std::fs::create_dir(&old_root).expect("create old checkout");
    let store = MemoryStore::open(app_data.db()).expect("open store");
    store
        .register_projects_vault(vault.root())
        .expect("register projects vault");
    let workspace = store
        .register_workspace(&old_root, "Portable checkout", None)
        .expect("register checkout");
    store
        .map_workspace_to_project(&workspace.id, None, "portable-project", "Portable project")
        .expect("map checkout");

    std::fs::rename(&old_root, &new_root).expect("move checkout");
    let relinked = store
        .relink_workspace(
            &workspace.id,
            &workspace.canonical_root,
            &new_root,
            "kodade-ui",
        )
        .expect("relink checkout on this machine");
    let mapping = store
        .workspace_project_mapping(&workspace.id)
        .expect("read mapping")
        .expect("mapping remains configured");

    assert_eq!(mapping.project_id, "portable-project");
    assert_eq!(mapping.workspace_root, relinked.canonical_root);
}

#[test]
fn project_scaffold_preview_lists_every_missing_role_without_writing() {
    let fixture = MappedProjectsVault::new("project-scaffold-preview", "Portable project");

    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview scaffold");

    assert_eq!(plan.project_id, "portable-project");
    assert_eq!(plan.fingerprint.len(), 64);
    assert_eq!(
        plan.operations
            .iter()
            .map(|operation| (operation.kind, operation.relative_path.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateDirectory,
                "10-Projects/portable-project/Decisions"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateDirectory,
                "10-Projects/portable-project/Knowledge"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateDirectory,
                "10-Projects/portable-project/Plans"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateDirectory,
                "10-Projects/portable-project/Research"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateDirectory,
                "10-Projects/portable-project/Worklog"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateFile,
                "10-Projects/portable-project/Project.md"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateFile,
                "10-Projects/portable-project/STATE.md"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateFile,
                "10-Projects/portable-project/References.md"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateFile,
                "10-Projects/portable-project/Decisions/Decisions.md"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateFile,
                "10-Projects/portable-project/Knowledge/Knowledge.md"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateFile,
                "10-Projects/portable-project/Plans/Plans.md"
            ),
            (
                kodade_lib::memory::ScaffoldOperationKind::CreateFile,
                "10-Projects/portable-project/Research/Research.md"
            ),
        ]
    );
    let project = plan
        .operations
        .iter()
        .find(|operation| operation.relative_path.ends_with("/Project.md"))
        .and_then(|operation| operation.content.as_deref())
        .expect("preview Project.md bytes");
    assert!(project.contains(
        "<!-- kodmem-project {\"schema\":1,\"projectId\":\"portable-project\",\"authority\":\"projects-vault\"} -->"
    ));
    assert!(
        std::fs::read_dir(fixture.project_root())
            .expect("preview leaves identity folder readable")
            .next()
            .is_none(),
        "preview must not create scaffold artifacts"
    );
}

#[test]
fn legacy_migration_preview_is_complete_and_does_not_write() {
    let fixture = MappedProjectsVault::new("legacy-migration-preview", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate legacy readable memory before portable cutover");
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# Project state\n\nUpdated: 2026-08-10T12:00:00Z\n\nThe legacy compiler migration is in review.\n",
    )
    .expect("write substantive legacy state");
    std::fs::write(
        fixture.checkout.join(".kodade/memory/WORKLOG.md"),
        "# Project worklog\n\n## 2026-08-10\n\n- Preserved the old checkpoint marker.\n",
    )
    .expect("write legacy worklog");

    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview scaffold");
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .expect("create portable scaffold");
    let project_before = std::fs::read(fixture.project_root().join("Project.md")).unwrap();
    let state_before = std::fs::read(fixture.project_root().join("STATE.md")).unwrap();
    let app_data_before = tree_hashes(fixture._app_data.root());
    let vault_before = tree_hashes(&fixture.vault_root);

    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect("preview legacy migration");

    assert_eq!(preview.project_id, "portable-project");
    assert_eq!(
        preview.status,
        kodade_lib::memory::LegacyMigrationStatus::Ready
    );
    assert!(preview.can_apply);
    assert!(preview.source_retained);
    assert_eq!(preview.counts.source_files, 2);
    assert_eq!(preview.sources.len(), 1);
    assert!(preview.operations.iter().any(|operation| {
        operation.source_relative_path.as_deref() == Some(".kodade/memory/STATE.md")
            && operation.target_relative_path == "STATE.md"
    }));
    assert!(preview.operations.iter().any(|operation| {
        operation.source_relative_path.as_deref() == Some(".kodade/memory/WORKLOG.md")
    }));
    assert_eq!(
        std::fs::read(fixture.project_root().join("Project.md")).unwrap(),
        project_before,
        "preview must not add the cutover receipt"
    );
    assert_eq!(
        std::fs::read(fixture.project_root().join("STATE.md")).unwrap(),
        state_before,
        "preview must not replace the scaffold placeholder"
    );
    assert_eq!(tree_hashes(fixture._app_data.root()), app_data_before);
    assert_eq!(tree_hashes(&fixture.vault_root), vault_before);
    assert!(!fixture
        ._app_data
        .root()
        .join("kodade-kodmem-migrations")
        .exists());
}

#[test]
fn legacy_migration_upgrades_a_rich_unmarked_project_and_rollback_restores_it_exactly() {
    let fixture =
        MappedProjectsVault::new("legacy-migration-rich-unmarked-project", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate legacy source");
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# Legacy state\n\nThe portable cutover is ready.\n",
    )
    .expect("write legacy state");
    let rich_project = b"---\ntitle: Portable project\ntype: project\nproject_id: portable-project\n---\n\n# Detailed purpose\n\nKeep this custom project note.\n";
    let project_path = fixture.project_root().join("Project.md");
    std::fs::write(&project_path, rich_project).expect("write rich unmarked Project.md");
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview missing roles");
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .expect("create missing roles");
    assert_eq!(std::fs::read(&project_path).unwrap(), rich_project);

    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect("preview upgrades the existing project identity");
    assert!(preview.can_apply);
    assert_eq!(
        std::fs::read(&project_path).unwrap(),
        rich_project,
        "preview must remain read-only"
    );
    let applied = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .expect("apply migration and authority markers");
    let upgraded = std::fs::read_to_string(&project_path).unwrap();
    assert!(upgraded.contains("Keep this custom project note."));
    assert_eq!(upgraded.matches("<!-- kodmem-project ").count(), 1);
    assert_eq!(upgraded.matches("<!-- kodmem-cutover ").count(), 1);

    fixture
        .store
        .rollback_legacy_migration(
            &fixture.workspace.id,
            &applied.migration_id,
            &applied.manifest_sha256,
        )
        .expect("rollback unchanged migration outputs");
    assert_eq!(
        std::fs::read(&project_path).unwrap(),
        rich_project,
        "rollback must restore the exact unmarked preimage"
    );
}

#[test]
fn legacy_migration_preserves_repo_file_timestamps_in_provenance_and_index_metadata() {
    let fixture = MappedProjectsVault::new("legacy-migration-file-timestamps", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    let generated_checkpoint = fixture
        .store
        .checkpoint(NewCheckpoint {
            workspace_id: fixture.workspace.id.clone(),
            summary: "Timestamp state signal".into(),
            decisions: Vec::new(),
            next_actions: vec!["Preserve the producer timestamp".into()],
            changed_paths: vec!["STATE.md".into()],
            source: MemorySource::Agent,
            source_client: "migration-timestamp-test".into(),
            session_id: None,
            idempotency_key: Some("legacy-producer-timestamp".into()),
        })
        .unwrap();
    let generated_state =
        std::fs::read_to_string(fixture.checkout.join(".kodade/memory/STATE.md")).unwrap();
    let generated_stamp = generated_state
        .lines()
        .find_map(|line| line.strip_prefix("Updated: "))
        .expect("legacy producer writes its timestamp");
    assert_eq!(generated_stamp.len(), 24);
    assert_eq!(&generated_stamp[13..14], "-");
    assert_eq!(&generated_stamp[19..20], "-");
    let sources = [
        (
            "WORKLOG.md",
            "# Worklog\n\nUpdated: 1700000002000\n\nTimestamp worklog signal.\n",
            1_700_000_002_000_i64,
        ),
        (
            "decisions.md",
            "# Decisions\n\nUpdated: 1700000003000\n\nTimestamp decision signal.\n",
            1_700_000_003_000_i64,
        ),
        (
            "plans/timestamp-plan.md",
            "# Plan\n\nUpdated: 1700000004000\n\nTimestamp plan signal.\n",
            1_700_000_004_000_i64,
        ),
    ];
    for (relative, content, modified_at) in sources {
        let path = fixture.checkout.join(".kodade/memory").join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, content).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(UNIX_EPOCH + Duration::from_millis(modified_at as u64)),
            )
            .unwrap();
    }
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();

    let migrated = tree_text(&fixture.project_root());
    for modified_at in [
        generated_checkpoint.created_at,
        1_700_000_002_000,
        1_700_000_003_000,
        1_700_000_004_000,
    ] {
        assert!(migrated.contains(&format!("sourceModifiedAt\":{modified_at}")));
        assert!(migrated.contains(&format!("legacy_source_updated_at: {modified_at}")));
    }
    let state_hit = fixture
        .store
        .search(MemoryQuery {
            workspace_id: fixture.workspace.id.clone(),
            text: "Timestamp state signal".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    let state_note = state_hit
        .items
        .iter()
        .find(|item| {
            item.project_source
                .as_ref()
                .is_some_and(|source| source.relative_path == "STATE.md")
        })
        .expect("migrated STATE is indexed with project provenance");
    assert_eq!(state_note.updated_at, generated_checkpoint.created_at);
}

#[test]
fn legacy_migration_applies_cutover_last_retains_sources_and_rebuilds_projection() {
    let fixture = MappedProjectsVault::new("legacy-migration-apply", "Portable project");
    let legacy_record = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Retain the migration source".into(),
            body: "Legacy data stays available for recovery after cutover.".into(),
            source: MemorySource::User,
            source_client: "migration-test".into(),
            session_id: Some("legacy-session".into()),
            pinned: true,
            idempotency_key: Some("legacy-record".into()),
            links: Vec::new(),
        })
        .expect("seed legacy database row");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .expect("activate legacy readable memory");
    let legacy_state_path = fixture.checkout.join(".kodade/memory/STATE.md");
    let legacy_state =
        "# Project state\n\nUpdated: 2026-08-10T12:00:00Z\n\nThe portable cutover is ready.\n";
    std::fs::write(&legacy_state_path, legacy_state).unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();

    let blocked = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Must not choose an authority lane".into(),
            body: "This write happens while migration is required.".into(),
            source: MemorySource::Agent,
            source_client: "migration-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect_err("legacy and portable writes fail closed before cutover");
    assert!(blocked.to_string().contains("cutover receipt"));

    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    assert_eq!(preview.counts.memories, 1);
    let applied = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .expect("apply migration");

    assert!(std::path::Path::new(&applied.backup_path).is_file());
    assert!(applied.source_retained);
    assert_eq!(
        std::fs::read_to_string(&legacy_state_path).unwrap(),
        legacy_state
    );
    let project = std::fs::read_to_string(fixture.project_root().join("Project.md")).unwrap();
    assert!(project.contains("<!-- kodmem-cutover "));
    assert!(project.contains(&applied.migration_id));
    let context = fixture.store.context(&fixture.workspace.id).unwrap();
    assert_eq!(context.working_memory, None);
    assert!(context
        .project_knowledge
        .unwrap()
        .sources
        .iter()
        .any(|source| source.content.contains("portable cutover is ready")));
    assert!(context
        .recent_memories
        .iter()
        .any(|record| record.title == "Retain the migration source"));
    let export = fixture
        .store
        .export_workspace(&fixture.workspace.id)
        .expect("portable export excludes retained legacy rows");
    assert_eq!(
        export.json.matches("Retain the migration source").count(),
        1
    );
    let export_json: serde_json::Value = serde_json::from_str(&export.json).unwrap();
    assert!(!export_json["memories"]
        .as_array()
        .unwrap()
        .iter()
        .any(|memory| memory["id"] == legacy_record.id));
    let imported_path = walk_files(&fixture.project_root().join("Decisions"))
        .into_iter()
        .find(|path| {
            std::fs::read_to_string(path)
                .is_ok_and(|text| text.contains("Retain the migration source"))
        })
        .unwrap();
    let imported = std::fs::read_to_string(&imported_path).unwrap();
    let imported_marker: serde_json::Value = imported
        .lines()
        .find(|line| line.starts_with("<!-- kodmem-memory "))
        .map(|line| {
            serde_json::from_str(
                line.strip_prefix("<!-- kodmem-memory ")
                    .unwrap()
                    .strip_suffix(" -->")
                    .unwrap(),
            )
            .unwrap()
        })
        .unwrap();
    let old_logical_id = imported_marker["recordId"].as_str().unwrap();
    let forged_logical_id = format!("km_{}", "f".repeat(32));
    let forged = imported.replace(old_logical_id, &forged_logical_id);
    let forged_path = fixture
        .project_root()
        .join("Decisions")
        .join(format!("{forged_logical_id}.md"));
    std::fs::write(&forged_path, forged).unwrap();
    assert!(fixture.store.context(&fixture.workspace.id).is_err());
    std::fs::remove_file(forged_path).unwrap();
    let repeated = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .expect("repeating the same apply is a no-op");
    assert_eq!(repeated.migration_id, applied.migration_id);
    assert_eq!(repeated.written, 0);
    let complete = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    assert_eq!(
        complete.status,
        kodade_lib::memory::LegacyMigrationStatus::Complete
    );
    assert!(complete.operations.is_empty());
}

#[test]
fn legacy_migration_preserves_checkpoint_state_and_idempotent_retry_semantics() {
    let fixture =
        MappedProjectsVault::new("legacy-migration-checkpoint-history", "Portable project");
    let memory_input = NewMemory {
        workspace_id: fixture.workspace.id.clone(),
        kind: MemoryKind::Fact,
        title: "Stable imported fact".into(),
        body: "Retrying this durable fact must resolve to the imported record.".into(),
        source: MemorySource::User,
        source_client: "migration-test".into(),
        session_id: Some("legacy-session".into()),
        pinned: false,
        idempotency_key: Some("legacy-memory-key".into()),
        links: Vec::new(),
    };
    let legacy_memory = fixture.store.remember(memory_input.clone()).unwrap();
    let append_input = NewCheckpoint {
        workspace_id: fixture.workspace.id.clone(),
        summary: "Append-only imported checkpoint".into(),
        decisions: vec!["Keep append-only history".into()],
        next_actions: vec!["Verify its marker".into()],
        changed_paths: vec!["src/history.rs".into()],
        source: MemorySource::Agent,
        source_client: "migration-test".into(),
        session_id: Some("legacy-session".into()),
        idempotency_key: Some("legacy-append-key".into()),
    };
    let state_input = NewCheckpoint {
        workspace_id: fixture.workspace.id.clone(),
        summary: "State-updating imported checkpoint".into(),
        decisions: vec!["Preserve state update intent".into()],
        next_actions: vec!["Verify delayed retry".into()],
        changed_paths: vec!["STATE.md".into()],
        source: MemorySource::Agent,
        source_client: "migration-test".into(),
        session_id: Some("legacy-session".into()),
        idempotency_key: Some("legacy-state-key".into()),
    };
    let append = fixture
        .store
        .checkpoint_with_authority(append_input.clone(), false, None)
        .unwrap();
    let state = fixture
        .store
        .checkpoint_with_authority(state_input.clone(), true, None)
        .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();

    assert!(matches!(
        fixture.store.checkpoint_by_id(&append.id),
        Err(kodade_lib::memory::MemoryError::NotFound(_))
    ));
    assert!(matches!(
        fixture.store.checkpoint_by_id(&state.id),
        Err(kodade_lib::memory::MemoryError::NotFound(_))
    ));
    let export = fixture
        .store
        .export_workspace(&fixture.workspace.id)
        .unwrap();
    assert_eq!(
        export
            .json
            .matches("Append-only imported checkpoint")
            .count(),
        1
    );
    assert_eq!(
        export
            .json
            .matches("State-updating imported checkpoint")
            .count(),
        1
    );
    let export_json: serde_json::Value = serde_json::from_str(&export.json).unwrap();
    let checkpoint_ids = export_json["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|checkpoint| checkpoint["id"].as_str())
        .collect::<Vec<_>>();
    assert!(!checkpoint_ids.contains(&append.id.as_str()));
    assert!(!checkpoint_ids.contains(&state.id.as_str()));
    let fresh_data = TempProject::new("legacy-migration-checkpoint-fresh-read-only");
    let fresh = MemoryStore::open(fresh_data.db()).unwrap();
    fresh.register_projects_vault(&fixture.vault_root).unwrap();
    let fresh_workspace = fresh
        .register_workspace(&fixture.checkout, "Fresh read-only checkout", None)
        .unwrap();
    fresh
        .map_workspace_to_project(
            &fresh_workspace.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    drop(fresh);
    let read_only = MemoryStore::open_read_only(fresh_data.db()).unwrap();
    let fresh_export = read_only.export_workspace(&fresh_workspace.id).unwrap();
    assert_eq!(
        fresh_export
            .json
            .matches("Append-only imported checkpoint")
            .count(),
        1
    );
    let fresh_export_json: serde_json::Value = serde_json::from_str(&fresh_export.json).unwrap();
    let projected_checkpoint_id = fresh_export_json["checkpoints"].as_array().unwrap()[0]["id"]
        .as_str()
        .unwrap();
    assert_eq!(
        read_only
            .checkpoint_by_id(projected_checkpoint_id)
            .unwrap()
            .workspace_id,
        fresh_workspace.id
    );

    let worklogs = walk_files(&fixture.project_root().join("Worklog"))
        .into_iter()
        .map(|path| std::fs::read_to_string(path).unwrap())
        .collect::<String>();
    assert!(worklogs.contains("\"updatesState\":false"));
    assert!(worklogs.contains("\"updatesState\":true"));
    let append_key_hash = format!("{:x}", Sha256::digest(b"legacy-append-key"));
    let state_key_hash = format!("{:x}", Sha256::digest(b"legacy-state-key"));
    assert!(worklogs.contains(&format!("\"idempotencyKeyHash\":\"{append_key_hash}\"")));
    assert!(worklogs.contains(&format!("\"idempotencyKeyHash\":\"{state_key_hash}\"")));

    let imported_memory = fixture
        .store
        .search(MemoryQuery {
            workspace_id: fixture.workspace.id.clone(),
            text: "Stable imported fact".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(imported_memory.total, 1);
    let imported_memory_id = imported_memory.items[0].id.clone();
    let imported_checkpoints = fixture
        .store
        .search_checkpoints(CheckpointQuery {
            workspace_id: fixture.workspace.id.clone(),
            text: "imported checkpoint".into(),
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(imported_checkpoints.total, 2);
    let imported_checkpoint_ids = imported_checkpoints
        .items
        .iter()
        .map(|checkpoint| (checkpoint.summary.clone(), checkpoint.id.clone()))
        .collect::<std::collections::BTreeMap<_, _>>();
    let reopened = MemoryStore::open(fixture._app_data.db()).unwrap();
    let memory_retry = reopened.remember(memory_input.clone()).unwrap();
    assert_ne!(memory_retry.id, legacy_memory.id);
    assert_eq!(memory_retry.id, imported_memory_id);
    assert_eq!(memory_retry.title, "Stable imported fact");
    let append_retry = reopened
        .checkpoint_with_authority(append_input, false, None)
        .unwrap();
    let state_retry = reopened
        .checkpoint_with_authority(state_input, true, None)
        .unwrap();
    assert_ne!(append_retry.id, append.id);
    assert_ne!(state_retry.id, state.id);
    assert_eq!(
        append_retry.id,
        imported_checkpoint_ids["Append-only imported checkpoint"]
    );
    assert_eq!(
        state_retry.id,
        imported_checkpoint_ids["State-updating imported checkpoint"]
    );
    assert_eq!(append_retry.summary, append.summary);
    assert_eq!(state_retry.summary, state.summary);
    let mut conflicting_memory = memory_input;
    conflicting_memory.body = "A different payload must conflict.".into();
    assert!(reopened
        .remember(conflicting_memory)
        .expect_err("same imported key with different memory payload conflicts")
        .to_string()
        .contains("different payload"));
    assert_eq!(
        reopened
            .search_checkpoints(CheckpointQuery {
                workspace_id: fixture.workspace.id.clone(),
                text: "imported checkpoint".into(),
                limit: 20,
                offset: 0,
            })
            .unwrap()
            .total,
        2,
        "idempotent retries must not append duplicate checkpoint markers"
    );
}

#[test]
fn legacy_checkpoint_and_repo_state_pair_migrates_without_competing_state_writes() {
    let fixture = MappedProjectsVault::new("legacy-migration-paired-state", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    let checkpoint = fixture
        .store
        .checkpoint(NewCheckpoint {
            workspace_id: fixture.workspace.id.clone(),
            summary: "Paired state summary".into(),
            decisions: vec!["Keep the readable state snapshot".into()],
            next_actions: vec!["Migrate the paired history".into()],
            changed_paths: vec!["STATE.md".into()],
            source: MemorySource::Agent,
            source_client: "migration-test".into(),
            session_id: None,
            idempotency_key: Some("paired-state-checkpoint".into()),
        })
        .unwrap();
    let source_state =
        std::fs::read_to_string(fixture.checkout.join(".kodade/memory/STATE.md")).unwrap();
    assert!(source_state.contains("Paired state summary"));
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    assert!(preview.can_apply);
    assert_eq!(
        preview
            .operations
            .iter()
            .filter(|operation| operation.target_relative_path == "STATE.md")
            .count(),
        1
    );
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();
    let canonical_state = std::fs::read_to_string(fixture.project_root().join("STATE.md")).unwrap();
    assert!(canonical_state.contains("Paired state summary"));
    assert!(canonical_state.contains("<!-- kodmem-state "));
    assert!(canonical_state.contains("<!-- kodmem-migration "));
    assert_eq!(
        fixture
            .store
            .context(&fixture.workspace.id)
            .unwrap()
            .latest_checkpoint
            .unwrap()
            .summary,
        checkpoint.summary
    );
}

#[test]
fn legacy_migration_rollback_restores_preimages_and_refuses_later_edits() {
    let fixture = MappedProjectsVault::new("legacy-migration-rollback", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    let source_path = fixture.checkout.join(".kodade/memory/STATE.md");
    std::fs::write(&source_path, "# State\n\nLegacy rollback source.\n").unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let state_path = fixture.project_root().join("STATE.md");
    let placeholder = std::fs::read_to_string(&state_path).unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let applied = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();
    let migrated_state = std::fs::read_to_string(&state_path).unwrap();

    std::fs::write(
        &state_path,
        "# Human edit\n\nPreserve this after migration.\n",
    )
    .unwrap();
    let conflict = fixture
        .store
        .rollback_legacy_migration(
            &fixture.workspace.id,
            &applied.migration_id,
            &applied.manifest_sha256,
        )
        .expect_err("rollback must not clobber later edits");
    assert!(conflict.to_string().contains("later edits"));
    assert!(std::fs::read_to_string(&state_path)
        .unwrap()
        .contains("Preserve this"));

    let migrated = std::fs::read_to_string(&source_path).unwrap();
    let state_target = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect_err("removing migrated state provenance must block portable authority");
    assert!(state_target.to_string().contains("artifacts"));
    assert!(migrated.contains("Legacy rollback source"));

    // Restore the recorded postimage to exercise the safe rollback path.
    std::fs::write(&state_path, migrated_state).unwrap();
    let rolled_back = fixture
        .store
        .rollback_legacy_migration(
            &fixture.workspace.id,
            &applied.migration_id,
            &applied.manifest_sha256,
        )
        .expect("rollback unchanged migration outputs");
    assert_eq!(rolled_back.restored, 1);
    assert_eq!(std::fs::read_to_string(&state_path).unwrap(), placeholder);
    assert!(
        !std::fs::read_to_string(fixture.project_root().join("Project.md"))
            .unwrap()
            .contains("kodmem-cutover")
    );
}

#[test]
fn legacy_migration_aggregates_workspaces_and_cutover_is_machine_local_digest_safe() {
    let fixture = MappedProjectsVault::new("legacy-migration-multi-workspace", "Portable project");
    let second_root = fixture._app_data.root().join("second-checkout");
    std::fs::create_dir(&second_root).unwrap();
    let second = fixture
        .store
        .register_workspace(&second_root, "Second checkout", None)
        .unwrap();
    fixture
        .store
        .map_workspace_to_project(&second.id, None, "portable-project", "Portable project")
        .unwrap();
    for workspace in [&fixture.workspace, &second] {
        fixture
            .store
            .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
            .unwrap();
        std::fs::write(
            Path::new(&workspace.canonical_root).join(".kodade/memory/STATE.md"),
            "# State\n\nShared legacy source.\n",
        )
        .unwrap();
        std::fs::write(
            Path::new(&workspace.canonical_root).join(".kodade/memory/WORKLOG.md"),
            "# Worklog\n\n- Shared historical entry.\n",
        )
        .unwrap();
    }
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    assert_eq!(preview.sources.len(), 2);
    assert!(preview.can_apply);
    assert!(preview.operations.iter().any(|operation| {
        operation.target_relative_path == "STATE.md" && operation.item_count == 1
    }));
    assert!(preview.operations.iter().any(|operation| {
        operation
            .target_relative_path
            .starts_with("Worklog/Legacy/")
            && operation.item_count == 1
    }));
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();

    let matching_data = TempProject::new("legacy-migration-machine-b");
    let matching = MemoryStore::open(matching_data.db()).unwrap();
    matching
        .register_projects_vault(&fixture.vault_root)
        .unwrap();
    let matching_workspace = matching
        .register_workspace(&fixture.checkout, "Matching checkout", None)
        .unwrap();
    matching
        .remember(NewMemory {
            workspace_id: matching_workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Machine B durable detail".into(),
            body: "Only this new SQLite receipt needs incremental migration.".into(),
            source: MemorySource::User,
            source_client: "migration-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("machine-b-new-row".into()),
            links: Vec::new(),
        })
        .unwrap();
    matching
        .map_workspace_to_project(
            &matching_workspace.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    let blocked = matching
        .context(&matching_workspace.id)
        .expect_err("the uncovered SQLite receipt still needs incremental cutover");
    assert!(blocked.to_string().contains("cutover receipt"));
    let incremental = matching
        .preview_legacy_migration(&matching_workspace.id)
        .expect("preview only the uncovered machine-B component");
    assert_eq!(incremental.counts.source_files, 0);
    assert_eq!(incremental.counts.memories, 1);
    assert!(incremental
        .operations
        .iter()
        .all(|operation| operation.source_kind == "sqlite-memory"));
    matching
        .apply_legacy_migration(&matching_workspace.id, &incremental.fingerprint)
        .expect("incremental apply merges a second cutover receipt");
    let machine_b_context = matching.context(&matching_workspace.id).unwrap();
    assert!(machine_b_context
        .recent_memories
        .iter()
        .any(|memory| memory.title == "Machine B durable detail"));
    assert!(fixture.store.context(&fixture.workspace.id).is_ok());
    assert!(
        std::fs::read_to_string(fixture.project_root().join("Project.md"))
            .unwrap()
            .matches("\"migrationId\"")
            .count()
            >= 2
    );

    let different_data = TempProject::new("legacy-migration-machine-c");
    let different_checkout = different_data.root().join("different-checkout");
    std::fs::create_dir(&different_checkout).unwrap();
    let different = MemoryStore::open(different_data.db()).unwrap();
    let different_workspace = different
        .register_workspace(&different_checkout, "Different checkout", None)
        .unwrap();
    different
        .activate_working_memory(&different_workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        different_checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nMachine C has distinct legacy history.\n",
    )
    .unwrap();
    different
        .register_projects_vault(&fixture.vault_root)
        .unwrap();
    different
        .map_workspace_to_project(
            &different_workspace.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    let blocked = different
        .context(&different_workspace.id)
        .expect_err("an unknown machine-local digest cannot inherit cutover authority");
    assert!(blocked.to_string().contains("cutover receipt"));
    let incremental = different
        .preview_legacy_migration(&different_workspace.id)
        .unwrap();
    assert_eq!(
        incremental.status,
        kodade_lib::memory::LegacyMigrationStatus::Blocked
    );
}

#[test]
fn interrupted_pre_cutover_migration_is_hidden_from_fresh_machine_and_rolls_back() {
    let fixture =
        MappedProjectsVault::new("legacy-migration-projection-failure", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nPending migration must stay hidden.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();

    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("legacy_migration_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
        .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
        .env("KODADE_MIGRATION_CHILD_FINGERPRINT", &preview.fingerprint)
        .env("KODADE_MIGRATION_CHILD_FAILPOINT", "projection")
        .status()
        .unwrap();
    assert!(status.success());
    let project = std::fs::read_to_string(fixture.project_root().join("Project.md")).unwrap();
    assert!(!project.contains("kodmem-cutover"));
    assert!(
        std::fs::read_to_string(fixture.project_root().join("STATE.md"))
            .unwrap()
            .contains("Pending migration")
    );

    let fresh_data = TempProject::new("legacy-migration-fresh-pre-cutover");
    let fresh_checkout = fresh_data.root().join("checkout");
    std::fs::create_dir(&fresh_checkout).unwrap();
    let fresh = MemoryStore::open(fresh_data.db()).unwrap();
    fresh.register_projects_vault(&fixture.vault_root).unwrap();
    let fresh_workspace = fresh
        .register_workspace(&fresh_checkout, "Fresh machine", None)
        .unwrap();
    fresh
        .map_workspace_to_project(
            &fresh_workspace.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    let hidden = fresh
        .context(&fresh_workspace.id)
        .expect_err("pending migration-owned Markdown must fail closed on a fresh machine");
    assert!(hidden.to_string().contains("migration-owned Markdown"));
    let search_hidden = fresh
        .search(MemoryQuery {
            workspace_id: fresh_workspace.id,
            text: "Pending migration".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect_err("pending migration must not enter fresh-machine search");
    assert!(search_hidden
        .to_string()
        .contains("migration-owned Markdown"));

    let recovery = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap()
        .recovery
        .expect("preview exposes durable recovery metadata");
    assert!(recovery.can_retry);
    assert!(recovery.can_rollback);
    fixture
        .store
        .rollback_legacy_migration(
            &fixture.workspace.id,
            &recovery.migration_id,
            &recovery.manifest_sha256,
        )
        .expect("pre-cutover rollback converges");
    assert!(
        !std::fs::read_to_string(fixture.project_root().join("STATE.md"))
            .unwrap()
            .contains("Pending migration")
    );
}

#[test]
fn deleted_only_partial_migration_is_hidden_from_a_fresh_machine_archive_scan() {
    let fixture = MappedProjectsVault::new("legacy-migration-deleted-partial", "Portable project");
    let record = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Deleted migration sentinel".into(),
            body: "Archive-only migration artifacts remain hidden before cutover.".into(),
            source: MemorySource::User,
            source_client: "migration-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("deleted-only-migration".into()),
            links: Vec::new(),
        })
        .unwrap();
    fixture
        .store
        .forget(&record.id, record.version, "migration-test", None)
        .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("legacy_migration_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
        .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
        .env("KODADE_MIGRATION_CHILD_FINGERPRINT", &preview.fingerprint)
        .env("KODADE_MIGRATION_CHILD_FAILPOINT", "projection")
        .status()
        .unwrap();
    assert!(status.success());
    assert!(walk_files(&fixture.project_root())
        .iter()
        .any(|path| path.to_string_lossy().contains("/Archive/km_")));

    let fresh_data = TempProject::new("legacy-migration-deleted-fresh");
    let fresh_checkout = fresh_data.root().join("checkout");
    std::fs::create_dir(&fresh_checkout).unwrap();
    let fresh = MemoryStore::open(fresh_data.db()).unwrap();
    fresh.register_projects_vault(&fixture.vault_root).unwrap();
    let workspace = fresh
        .register_workspace(&fresh_checkout, "Fresh archive reader", None)
        .unwrap();
    fresh
        .map_workspace_to_project(&workspace.id, None, "portable-project", "Portable project")
        .unwrap();
    assert!(fresh.context(&workspace.id).is_err());
    assert!(fresh
        .search(MemoryQuery {
            workspace_id: workspace.id.clone(),
            text: "Deleted migration sentinel".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .is_err());
    assert!(fresh
        .deleted_memory_page(DeletedMemoryQuery {
            workspace_id: workspace.id,
            limit: 20,
            offset: 0,
        })
        .is_err());
}

#[test]
fn interrupted_pre_cutover_migration_retries_from_immutable_backup_then_rolls_back_exactly() {
    for failpoint in [
        "backup",
        "pending",
        "markdown-1",
        "markdown-2",
        "validation",
        "projection",
    ] {
        let fixture = MappedProjectsVault::new(
            &format!("legacy-migration-retry-{}", failpoint.replace('-', "_")),
            "Portable project",
        );
        fixture
            .store
            .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
            .unwrap();
        let state_source = fixture.checkout.join(".kodade/memory/STATE.md");
        let worklog_source = fixture.checkout.join(".kodade/memory/WORKLOG.md");
        std::fs::write(&state_source, "# State\n\nImmutable recovery source.\n").unwrap();
        std::fs::write(
            &worklog_source,
            "# Worklog\n\n- Recovery must preserve the original preimages.\n",
        )
        .unwrap();
        let scaffold = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
            .unwrap();
        let project_before = tree_hashes(&fixture.project_root());
        let state_source_before = std::fs::read(&state_source).unwrap();
        let worklog_source_before = std::fs::read(&worklog_source).unwrap();
        let preview = fixture
            .store
            .preview_legacy_migration(&fixture.workspace.id)
            .unwrap();
        let manifest = preview.manifest_sha256.clone().unwrap();

        let status = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("legacy_migration_child_process_helper")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
            .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
            .env("KODADE_MIGRATION_CHILD_FINGERPRINT", &preview.fingerprint)
            .env("KODADE_MIGRATION_CHILD_FAILPOINT", failpoint)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(
            !std::fs::read_to_string(fixture.project_root().join("Project.md"))
                .unwrap()
                .contains("kodmem-cutover")
        );

        let recovery = fixture
            .store
            .preview_legacy_migration(&fixture.workspace.id)
            .unwrap();
        assert_eq!(recovery.manifest_sha256.as_deref(), Some(manifest.as_str()));
        assert!(recovery.recovery.as_ref().is_some_and(|state| {
            state.can_retry && state.can_rollback && state.manifest_sha256 == manifest
        }));
        let applied = fixture
            .store
            .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
            .expect("retry resumes the immutable original backup");
        assert_eq!(applied.manifest_sha256, manifest);
        fixture
            .store
            .rollback_legacy_migration(
                &fixture.workspace.id,
                &applied.migration_id,
                &applied.manifest_sha256,
            )
            .expect("completed retry remains byte-exactly rollbackable");
        assert_eq!(tree_hashes(&fixture.project_root()), project_before);
        assert_eq!(std::fs::read(&state_source).unwrap(), state_source_before);
        assert_eq!(
            std::fs::read(&worklog_source).unwrap(),
            worklog_source_before
        );
    }
}

#[test]
fn cutover_receipt_crash_repairs_local_phase_and_remains_exactly_rollbackable() {
    let fixture = MappedProjectsVault::new("legacy-migration-cutover-receipt", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nCutover receipt crash state.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let before = tree_hashes(&fixture.project_root());
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let migration_id = preview.migration_id.clone().unwrap();
    let manifest = preview.manifest_sha256.clone().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("legacy_migration_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
        .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
        .env("KODADE_MIGRATION_CHILD_FINGERPRINT", &preview.fingerprint)
        .env("KODADE_MIGRATION_CHILD_FAILPOINT", "cutover-receipt")
        .status()
        .unwrap();
    assert!(status.success());
    assert!(
        std::fs::read_to_string(fixture.project_root().join("Project.md"))
            .unwrap()
            .contains("kodmem-cutover")
    );

    let recovered_apply = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .expect("apply repairs the local post-receipt phase");
    assert_eq!(recovered_apply.written, 0);
    let repaired = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect("preview sees the repaired completion");
    assert_eq!(
        repaired.status,
        kodade_lib::memory::LegacyMigrationStatus::Complete
    );
    assert!(fixture
        .store
        .context(&fixture.workspace.id)
        .unwrap()
        .project_knowledge
        .unwrap()
        .sources
        .iter()
        .any(|source| source.content.contains("Cutover receipt crash state")));
    fixture
        .store
        .rollback_legacy_migration(&fixture.workspace.id, &migration_id, &manifest)
        .expect("repaired receipt remains rollbackable");
    assert_eq!(tree_hashes(&fixture.project_root()), before);
}

#[test]
fn interrupted_completed_rollback_is_discoverable_after_receipt_removal_and_resumes() {
    for failpoint in [
        "rollback-cutover",
        "rollback-target-1",
        "rollback-finalized",
        "rollback-project-restored",
    ] {
        let fixture = MappedProjectsVault::new(
            &format!(
                "legacy-migration-rollback-restart-{}",
                failpoint.replace('-', "_")
            ),
            "Portable project",
        );
        fixture
            .store
            .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
            .unwrap();
        std::fs::write(
            fixture.checkout.join(".kodade/memory/STATE.md"),
            "# State\n\nRollback restart state.\n",
        )
        .unwrap();
        std::fs::write(
            fixture.checkout.join(".kodade/memory/WORKLOG.md"),
            "# Worklog\n\n- Rollback restart history.\n",
        )
        .unwrap();
        let scaffold = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
            .unwrap();
        let before = tree_hashes(&fixture.project_root());
        let preview = fixture
            .store
            .preview_legacy_migration(&fixture.workspace.id)
            .unwrap();
        let applied = fixture
            .store
            .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
            .unwrap();

        let status = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("legacy_migration_child_process_helper")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
            .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
            .env("KODADE_MIGRATION_CHILD_ROLLBACK_ID", &applied.migration_id)
            .env(
                "KODADE_MIGRATION_CHILD_ROLLBACK_MANIFEST",
                &applied.manifest_sha256,
            )
            .env("KODADE_MIGRATION_CHILD_FAILPOINT", failpoint)
            .status()
            .unwrap();
        assert!(status.success());
        let rolling_project =
            std::fs::read_to_string(fixture.project_root().join("Project.md")).unwrap();
        if failpoint == "rollback-project-restored" {
            assert!(!rolling_project.contains("kodmem-migration-pending"));
            fixture
                .store
                .rollback_legacy_migration(
                    &fixture.workspace.id,
                    &applied.migration_id,
                    &applied.manifest_sha256,
                )
                .expect("terminal rollback is idempotent after its final Project.md write");
            assert_eq!(tree_hashes(&fixture.project_root()), before);
            continue;
        }
        assert!(rolling_project.contains("kodmem-migration-pending"));
        assert!(rolling_project.contains("rollingBack"));
        assert!(rolling_project.contains(&applied.migration_id));
        assert!(!rolling_project.contains("kodmem-cutover"));

        let recovery = MemoryStore::open(fixture._app_data.db())
            .unwrap()
            .preview_legacy_migration(&fixture.workspace.id)
            .unwrap()
            .recovery
            .expect("restart preview discovers RollingBack without a cutover receipt");
        assert!(!recovery.can_retry);
        assert!(recovery.can_rollback);
        fixture
            .store
            .rollback_legacy_migration(
                &fixture.workspace.id,
                &recovery.migration_id,
                &recovery.manifest_sha256,
            )
            .expect("rollback resumes from its durable target CAS journal");
        assert_eq!(tree_hashes(&fixture.project_root()), before);
    }
}

#[test]
fn greenfield_authority_rejects_any_malformed_reserved_cutover_marker() {
    let fixture =
        MappedProjectsVault::new("legacy-migration-malformed-cutover", "Portable project");
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let project_path = fixture.project_root().join("Project.md");
    let project = std::fs::read_to_string(&project_path).unwrap();
    let project = project.replacen(
        " -->\n\n# Portable project",
        " -->\n<!-- kodmem-cutover {\"schema\":1,\"projectId\":\"wrong\"} -->\n\n# Portable project",
        1,
    );
    std::fs::write(&project_path, project).unwrap();

    let error = fixture
        .store
        .context(&fixture.workspace.id)
        .expect_err("reserved cutover markers always parse fail closed");
    assert!(error.to_string().contains("malformed kodmem-cutover"));
}

#[cfg(unix)]
#[test]
fn legacy_migration_rejects_symlinked_source_directories_without_residue() {
    use std::os::unix::fs::symlink;

    let fixture = MappedProjectsVault::new("legacy-migration-source-symlink", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nSafe legacy content.\n",
    )
    .unwrap();
    let external = fixture._app_data.root().join("external-plans");
    std::fs::create_dir(&external).unwrap();
    std::fs::write(external.join("escape.md"), "# Escaped\n\nDo not import.\n").unwrap();
    let plans = fixture.checkout.join(".kodade/memory/plans");
    std::fs::remove_dir(&plans).unwrap();
    symlink(&external, &plans).unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let before = tree_hashes(&fixture.project_root());

    let error = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect_err("symlinked legacy plan roots fail closed");
    assert!(error.to_string().contains("regular directory"));
    assert_eq!(tree_hashes(&fixture.project_root()), before);
    assert!(!fixture
        ._app_data
        .root()
        .join("kodade-kodmem-migrations")
        .exists());
}

#[test]
fn legacy_migration_rejects_oversized_database_fields_and_generated_postimages_before_residue() {
    let database_fixture =
        MappedProjectsVault::new("legacy-migration-oversized-database", "Portable project");
    let connection = rusqlite::Connection::open(database_fixture._app_data.db()).unwrap();
    connection
        .execute(
            "INSERT INTO memories (
                id, workspace_id, kind, title, body, source, source_client,
                pinned, version, created_at, updated_at
             ) VALUES (?1, ?2, 'fact', 'Oversized', ?3, 'user', 'migration-test', 0, 1, 1, 1)",
            rusqlite::params![
                "mem_oversized_direct_sql",
                database_fixture.workspace.id,
                "x".repeat(300_000)
            ],
        )
        .unwrap();
    drop(connection);
    let scaffold = database_fixture
        .store
        .preview_project_scaffold(&database_fixture.workspace.id)
        .unwrap();
    database_fixture
        .store
        .apply_project_scaffold(&database_fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let vault_before = tree_hashes(&database_fixture.vault_root);
    let error = database_fixture
        .store
        .preview_legacy_migration(&database_fixture.workspace.id)
        .expect_err("SQL-side field bounds reject before row materialization/export");
    assert!(error.to_string().contains("per-field migration limit"));
    assert_eq!(tree_hashes(&database_fixture.vault_root), vault_before);
    assert!(!database_fixture
        ._app_data
        .root()
        .join("kodade-kodmem-migrations")
        .exists());

    let wrapped_fixture =
        MappedProjectsVault::new("legacy-migration-oversized-postimage", "Portable project");
    wrapped_fixture
        .store
        .activate_working_memory(
            &wrapped_fixture.workspace.id,
            WorkingMemoryMode::Commit,
            false,
        )
        .unwrap();
    std::fs::write(
        wrapped_fixture.checkout.join(".kodade/memory/WORKLOG.md"),
        format!("# Worklog\n\n{}\n", "h".repeat(261_900)),
    )
    .unwrap();
    let scaffold = wrapped_fixture
        .store
        .preview_project_scaffold(&wrapped_fixture.workspace.id)
        .unwrap();
    wrapped_fixture
        .store
        .apply_project_scaffold(&wrapped_fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let vault_before = tree_hashes(&wrapped_fixture.vault_root);
    let error = wrapped_fixture
        .store
        .preview_legacy_migration(&wrapped_fixture.workspace.id)
        .expect_err("generated wrapper must fit before any backup or target write");
    assert!(error.to_string().contains("generated migration target"));
    assert_eq!(tree_hashes(&wrapped_fixture.vault_root), vault_before);
    assert!(!wrapped_fixture
        ._app_data
        .root()
        .join("kodade-kodmem-migrations")
        .exists());
}

#[test]
fn legacy_migration_includes_heading_only_history_but_omits_exact_empty_scaffolds() {
    let fixture = MappedProjectsVault::new("legacy-migration-heading-history", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/decisions.md"),
        "## Adopt SQLite\n",
    )
    .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/MEMORIES.md"),
        "## Durable heading-only fact\n",
    )
    .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/plans/heading.md"),
        "## Ship heading-only plan\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    assert_eq!(preview.counts.source_files, 3);
    assert!(preview.operations.iter().any(|operation| {
        operation.source_relative_path.as_deref() == Some(".kodade/memory/decisions.md")
    }));
    assert!(preview.operations.iter().any(|operation| {
        operation.source_relative_path.as_deref() == Some(".kodade/memory/MEMORIES.md")
    }));
    assert!(preview.operations.iter().any(|operation| {
        operation.source_relative_path.as_deref() == Some(".kodade/memory/plans/heading.md")
    }));
    assert!(!preview.operations.iter().any(|operation| {
        operation.source_relative_path.as_deref() == Some(".kodade/memory/WORKLOG.md")
    }));
}

#[test]
fn migration_backup_phase_and_anchor_tampering_fail_before_rollback_mutation() {
    let fixture = MappedProjectsVault::new("legacy-migration-backup-tamper", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nTamper-resistant migration recovery.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let applied = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();
    let vault_before = tree_hashes(&fixture.vault_root);
    let backup_path = PathBuf::from(&applied.backup_path);
    let mut backup: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&backup_path).unwrap()).unwrap();
    backup["phase"] = serde_json::Value::String("prepared".into());
    std::fs::write(&backup_path, serde_json::to_string_pretty(&backup).unwrap()).unwrap();
    let phase_error = fixture
        .store
        .rollback_legacy_migration(
            &fixture.workspace.id,
            &applied.migration_id,
            &applied.manifest_sha256,
        )
        .expect_err("phase-only backup tampering invalidates its integrity");
    assert!(phase_error.to_string().contains("integrity"));
    assert_eq!(tree_hashes(&fixture.vault_root), vault_before);

    backup["phase"] = serde_json::Value::String("complete".into());
    std::fs::write(&backup_path, serde_json::to_string_pretty(&backup).unwrap()).unwrap();
    let anchor_path = backup_path.with_file_name(format!(
        "{}.anchor.json",
        backup_path.file_stem().unwrap().to_string_lossy()
    ));
    let mut anchor: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&anchor_path).unwrap()).unwrap();
    anchor["manifestSha256"] = serde_json::Value::String("b".repeat(64));
    std::fs::write(&anchor_path, serde_json::to_string_pretty(&anchor).unwrap()).unwrap();
    let anchor_error = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect_err("independent preview anchor rejects self-consistent backup replacement");
    assert!(anchor_error.to_string().contains("anchor"));
    assert_eq!(tree_hashes(&fixture.vault_root), vault_before);
}

#[test]
fn self_consistent_recovery_envelope_tampering_is_rejected_before_any_project_mutation() {
    let fixture = MappedProjectsVault::new("legacy-migration-envelope-tamper", "Portable project");
    fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Recovery export sentinel".into(),
            body: "The migration backup contains a bounded database export.".into(),
            source: MemorySource::User,
            source_client: "migration-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("recovery-envelope-tamper".into()),
            links: Vec::new(),
        })
        .unwrap();
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    let source_path = fixture.checkout.join(".kodade/memory/STATE.md");
    std::fs::write(&source_path, "# State\n\nRecovery envelope state.\n").unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let applied = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();
    let backup_path = PathBuf::from(&applied.backup_path);
    let original = std::fs::read_to_string(&backup_path).unwrap();
    let secret = "AKIAABCDEFGHIJKLMNOP";

    for case in [
        "project",
        "target",
        "source",
        "export-json",
        "export-markdown",
    ] {
        let mut backup: serde_json::Value = serde_json::from_str(&original).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(secret.as_bytes());
        match case {
            "project" => backup["projectNoteBase64"] = encoded.into(),
            "target" => {
                let target = backup["targets"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|target| !target["beforeBase64"].is_null())
                    .unwrap();
                target["beforeBase64"] = encoded.into();
            }
            "source" => {
                let source = &mut backup["sourceFiles"][0];
                source["bytesBase64"] = encoded.into();
                source["sha256"] = format!("{:x}", Sha256::digest(secret.as_bytes())).into();
            }
            "export-json" => {
                let mut value: serde_json::Value =
                    serde_json::from_str(backup["exports"][0]["json"].as_str().unwrap()).unwrap();
                value["credential"] = secret.into();
                backup["exports"][0]["json"] = serde_json::to_string(&value).unwrap().into();
            }
            "export-markdown" => {
                let markdown = backup["exports"][0]["markdown"].as_str().unwrap();
                backup["exports"][0]["markdown"] = format!("{markdown}\n{secret}\n").into();
            }
            _ => unreachable!(),
        }
        backup["integritySha256"] = migration_backup_integrity(&backup).into();
        std::fs::write(&backup_path, serde_json::to_string_pretty(&backup).unwrap()).unwrap();
        let vault_before = tree_hashes(&fixture.vault_root);
        let app_before = tree_hashes(fixture._app_data.root());
        let database_before = std::fs::read(fixture._app_data.db()).unwrap();
        let source_before = std::fs::read(&source_path).unwrap();
        let error = fixture
            .store
            .rollback_legacy_migration(
                &fixture.workspace.id,
                &applied.migration_id,
                &applied.manifest_sha256,
            )
            .expect_err("tampered recovery envelope must fail closed");
        assert!(!error.to_string().contains(secret));
        assert_eq!(tree_hashes(&fixture.vault_root), vault_before, "{case}");
        assert_eq!(tree_hashes(fixture._app_data.root()), app_before, "{case}");
        assert_eq!(
            std::fs::read(fixture._app_data.db()).unwrap(),
            database_before,
            "{case}"
        );
        assert_eq!(
            std::fs::read(&source_path).unwrap(),
            source_before,
            "{case}"
        );
    }
    std::fs::write(backup_path, original).unwrap();
}

#[test]
fn self_consistent_premature_rolled_back_phase_cannot_hide_unrestored_targets() {
    let fixture =
        MappedProjectsVault::new("legacy-migration-premature-rolled-back", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/WORKLOG.md"),
        "# Worklog\n\n- Target that must be restored before terminal rollback.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let applied = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();
    let target = fixture
        .project_root()
        .join(&preview.operations[0].target_relative_path);
    let target_postimage = std::fs::read(&target).unwrap();
    let backup_path = PathBuf::from(&applied.backup_path);
    let mut backup: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&backup_path).unwrap()).unwrap();
    let integrity_for = |backup: &serde_json::Value| {
        let payload = serde_json::json!([
            backup["schema"].clone(),
            backup["projectId"].clone(),
            backup["migrationId"].clone(),
            backup["manifestSha256"].clone(),
            backup["previewFingerprint"].clone(),
            backup["projectNoteSha256"].clone(),
            backup["projectNoteBase64"].clone(),
            backup["phase"].clone(),
            backup["plan"].clone(),
            backup["writes"].clone(),
            backup["sourceSnapshots"].clone(),
            backup["sourceFiles"].clone(),
            backup["exports"].clone(),
            backup["targets"].clone(),
        ]);
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&payload).unwrap())
        )
    };
    assert_eq!(
        integrity_for(&backup),
        backup["integritySha256"].as_str().unwrap()
    );
    backup["phase"] = "rolledBack".into();
    backup["integritySha256"] = integrity_for(&backup).into();
    std::fs::write(&backup_path, serde_json::to_string_pretty(&backup).unwrap()).unwrap();
    let project_preimage = base64::engine::general_purpose::STANDARD
        .decode(backup["projectNoteBase64"].as_str().unwrap())
        .unwrap();
    std::fs::write(fixture.project_root().join("Project.md"), project_preimage).unwrap();

    let error = fixture
        .store
        .rollback_legacy_migration(
            &fixture.workspace.id,
            &applied.migration_id,
            &applied.manifest_sha256,
        )
        .expect_err("RolledBack phase cannot be trusted while a target remains at its postimage");
    assert!(
        error.to_string().contains("target preimage"),
        "unexpected rollback error: {error}"
    );
    assert_eq!(std::fs::read(target).unwrap(), target_postimage);
}

#[test]
fn read_only_migration_preview_is_pure_and_apply_or_rollback_never_leave_residue() {
    let fixture = MappedProjectsVault::new("legacy-migration-read-only", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nRead-only migration preview.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let read_only = MemoryStore::open_read_only(fixture._app_data.db()).unwrap();
    let vault_before = tree_hashes(&fixture.vault_root);
    let app_before = tree_hashes(fixture._app_data.root());
    let preview = read_only
        .preview_legacy_migration(&fixture.workspace.id)
        .expect("read-only preview remains available");
    assert!(preview.can_apply);
    assert!(read_only
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap_err()
        .to_string()
        .contains("read-only"));
    assert!(read_only
        .rollback_legacy_migration(
            &fixture.workspace.id,
            "kmig_00000000000000000000000000000000",
            &"0".repeat(64),
        )
        .unwrap_err()
        .to_string()
        .contains("read-only"));
    assert_eq!(tree_hashes(&fixture.vault_root), vault_before);
    assert_eq!(tree_hashes(fixture._app_data.root()), app_before);
}

#[cfg(unix)]
#[test]
fn project_note_orphan_temporaries_are_preview_pure_and_reconciled_only_under_lock() {
    use std::os::unix::fs::symlink;

    let fixture = MappedProjectsVault::new("legacy-migration-project-temp", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nOrphan Project.md write recovery.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();

    let strict_temp = fixture.project_root().join(".kodmem-write-42-1.tmp");
    let foreign_temp = fixture.project_root().join(".kodmem-write-not-ours.tmp");
    let outside = fixture.checkout.join("outside-temp-target");
    std::fs::write(&outside, "must not be touched").unwrap();
    symlink(&outside, &strict_temp).unwrap();
    std::fs::write(&foreign_temp, "foreign temp").unwrap();
    let vault_before = tree_hashes(&fixture.vault_root);
    let app_before = tree_hashes(fixture._app_data.root());
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect("preview ignores but never mutates strict orphan temp names");
    assert_eq!(tree_hashes(&fixture.vault_root), vault_before);
    assert_eq!(tree_hashes(fixture._app_data.root()), app_before);

    let error = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .expect_err("a symlinked recognized temp must fail before recovery residue");
    assert!(error.to_string().contains("temporary entry"));
    assert_eq!(tree_hashes(&fixture.vault_root), vault_before);
    assert_eq!(tree_hashes(fixture._app_data.root()), app_before);
    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        "must not be touched"
    );

    std::fs::remove_file(&strict_temp).unwrap();
    std::fs::write(&strict_temp, "published write already won").unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .expect("locked apply durably removes an exact regular orphan temp");
    assert!(!strict_temp.exists());
    assert_eq!(
        std::fs::read_to_string(&foreign_temp).unwrap(),
        "foreign temp"
    );
}

#[cfg(unix)]
#[test]
fn recovery_namespace_temporaries_are_never_mutated_by_unlocked_preview() {
    use std::os::unix::fs::symlink;

    let fixture = MappedProjectsVault::new("legacy-migration-runtime-temp", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nRuntime recovery temporary purity.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("legacy_migration_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
        .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
        .env("KODADE_MIGRATION_CHILD_FINGERPRINT", &preview.fingerprint)
        .env("KODADE_MIGRATION_CHILD_FAILPOINT", "backup")
        .status()
        .unwrap();
    assert!(status.success());

    let backup_path = walk_files(fixture._app_data.root())
        .into_iter()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("kmig_") && name.ends_with(".json"))
        })
        .expect("prepared backup is durable");
    let runtime = backup_path.parent().unwrap();
    let strict_temp = runtime.join(".kodmem-write-777-1.tmp");
    std::fs::write(&strict_temp, "orphaned unpublished backup bytes").unwrap();
    let backup_before = std::fs::read(&backup_path).unwrap();
    let temp_before = std::fs::read(&strict_temp).unwrap();
    let writable_recovery = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect("writable preview discovers recovery without cleanup");
    let read_only = MemoryStore::open_read_only(fixture._app_data.db()).unwrap();
    let read_only_recovery = read_only
        .preview_legacy_migration(&fixture.workspace.id)
        .expect("read-only preview discovers recovery without cleanup");
    assert_eq!(writable_recovery.recovery, read_only_recovery.recovery);
    assert_eq!(std::fs::read(&backup_path).unwrap(), backup_before);
    assert_eq!(std::fs::read(&strict_temp).unwrap(), temp_before);

    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .expect("locked apply reconciles the exact regular temp before resuming");
    assert!(!strict_temp.exists());

    let outside = fixture.checkout.join("runtime-temp-outside");
    std::fs::write(&outside, "outside stays unchanged").unwrap();
    let symlink_temp = runtime.join(".kodmem-anchor-777-2.tmp");
    symlink(&outside, &symlink_temp).unwrap();
    let error = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect_err("preview fails closed on a symlinked recovery temp");
    assert!(error.to_string().contains("non-regular"));
    assert!(symlink_temp
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        "outside stays unchanged"
    );
}

#[test]
fn migration_authority_rejects_an_over_aggregate_canonical_tree_before_projection() {
    let fixture = MappedProjectsVault::new("legacy-migration-authority-budget", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nCanonical budget baseline.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();

    let research = fixture.project_root().join("Research");
    for index in 0..17 {
        std::fs::write(
            research.join(format!("aggregate-{index:02}.md")),
            format!("# Aggregate {index}\n\n{}\n", "x".repeat(250_000)),
        )
        .unwrap();
    }
    let app_before = tree_hashes(fixture._app_data.root());
    for error in [
        fixture.store.context(&fixture.workspace.id).unwrap_err(),
        fixture
            .store
            .search(MemoryQuery {
                workspace_id: fixture.workspace.id.clone(),
                text: "canonical".into(),
                kinds: Vec::new(),
                sources: Vec::new(),
                updated_after: None,
                limit: 20,
                offset: 0,
            })
            .unwrap_err(),
        fixture
            .store
            .preview_legacy_migration(&fixture.workspace.id)
            .unwrap_err(),
    ] {
        assert!(
            error.to_string().contains("byte limit")
                || error.to_string().contains("project scan budget"),
            "unexpected bounded-authority error: {error}"
        );
    }
    assert_eq!(tree_hashes(fixture._app_data.root()), app_before);
}

#[test]
fn durable_recovery_is_shared_across_distinct_database_parents_for_one_project_root() {
    let fixture = MappedProjectsVault::new("legacy-migration-shared-recovery", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nShared durable recovery namespace.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();

    let recovery = TempProject::new("legacy-migration-shared-recovery-root");
    let store_a =
        MemoryStore::open_with_migration_recovery_root(fixture._app_data.db(), recovery.root())
            .unwrap();
    let preview = store_a
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let before = tree_hashes(&fixture.project_root());
    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("legacy_migration_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
        .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
        .env("KODADE_MIGRATION_CHILD_FINGERPRINT", &preview.fingerprint)
        .env("KODADE_MIGRATION_CHILD_FAILPOINT", "markdown-1")
        .env("KODADE_MIGRATION_CHILD_RECOVERY_ROOT", recovery.root())
        .status()
        .unwrap();
    assert!(status.success());

    let machine_b = TempProject::new("legacy-migration-shared-recovery-b");
    let checkout_b = machine_b.root().join("checkout");
    std::fs::create_dir(&checkout_b).unwrap();
    let store_b =
        MemoryStore::open_with_migration_recovery_root(machine_b.db(), recovery.root()).unwrap();
    store_b
        .register_projects_vault(&fixture.vault_root)
        .unwrap();
    let workspace_b = store_b
        .register_workspace(&checkout_b, "Recovery machine B", None)
        .unwrap();
    store_b
        .map_workspace_to_project(
            &workspace_b.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    let discovered = store_b
        .preview_legacy_migration(&workspace_b.id)
        .expect("distinct DB parent discovers canonical-root recovery");
    let recovery_state = discovered.recovery.unwrap();
    assert!(!recovery_state.can_retry);
    assert!(recovery_state.can_rollback);
    store_b
        .rollback_legacy_migration(
            &workspace_b.id,
            &recovery_state.migration_id,
            &recovery_state.manifest_sha256,
        )
        .expect("second store converges shared recovery");
    assert_eq!(tree_hashes(&fixture.project_root()), before);
}

#[cfg(unix)]
#[test]
fn migration_apply_and_rollback_reject_project_root_symlink_swaps_after_lock() {
    use std::os::unix::fs::symlink;

    for rollback in [false, true] {
        let fixture = MappedProjectsVault::new(
            if rollback {
                "legacy-migration-root-swap-rollback"
            } else {
                "legacy-migration-root-swap-apply"
            },
            "Portable project",
        );
        fixture
            .store
            .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
            .unwrap();
        std::fs::write(
            fixture.checkout.join(".kodade/memory/STATE.md"),
            "# State\n\nRoot swaps must fail closed.\n",
        )
        .unwrap();
        let scaffold = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
            .unwrap();
        let preview = fixture
            .store
            .preview_legacy_migration(&fixture.workspace.id)
            .unwrap();
        let applied = rollback.then(|| {
            fixture
                .store
                .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
                .unwrap()
        });

        let ready = fixture._app_data.root().join("root-swap-ready");
        let release = fixture._app_data.root().join("root-swap-release");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("legacy_migration_child_process_helper")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
            .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
            .env("KODADE_TEST_PORTABLE_LOCK_READY", &ready)
            .env("KODADE_TEST_PORTABLE_LOCK_RELEASE", &release);
        if let Some(applied) = applied.as_ref() {
            command
                .env("KODADE_MIGRATION_CHILD_ROLLBACK_ID", &applied.migration_id)
                .env(
                    "KODADE_MIGRATION_CHILD_ROLLBACK_MANIFEST",
                    &applied.manifest_sha256,
                );
        } else {
            command.env("KODADE_MIGRATION_CHILD_FINGERPRINT", &preview.fingerprint);
        }
        let mut child = command.spawn().unwrap();
        wait_for_file(&ready, Duration::from_secs(5));

        let project_root = fixture.project_root();
        let saved = fixture.vault_root.join(if rollback {
            "root-swap-rollback-saved"
        } else {
            "root-swap-apply-saved"
        });
        let outside = fixture._app_data.root().join(if rollback {
            "outside-rollback"
        } else {
            "outside-apply"
        });
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), b"unchanged").unwrap();
        let outside_before = tree_hashes(&outside);
        std::fs::rename(&project_root, &saved).unwrap();
        symlink(&outside, &project_root).unwrap();
        std::fs::write(&release, b"release").unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success(), "root swap must abort migration");
        assert_eq!(tree_hashes(&outside), outside_before);
        std::fs::remove_file(&project_root).unwrap();
        std::fs::rename(&saved, &project_root).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn migration_recovery_root_rejects_symlink_and_non_directory_substitution() {
    use std::os::unix::fs::symlink;

    let fixture = TempProject::new("legacy-migration-recovery-root-guard");
    let target = fixture.root().join("target");
    let link = fixture.root().join("recovery-link");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();
    assert!(MemoryStore::open_with_migration_recovery_root(
        fixture.root().join("symlink.sqlite3"),
        &link,
    )
    .unwrap_err()
    .to_string()
    .contains("regular directory"));

    let file = fixture.root().join("recovery-file");
    std::fs::write(&file, b"not a directory").unwrap();
    assert!(MemoryStore::open_with_migration_recovery_root(
        fixture.root().join("file.sqlite3"),
        &file,
    )
    .unwrap_err()
    .to_string()
    .contains("regular directory"));
}

#[test]
fn migration_waiting_on_project_lock_rejects_a_completed_workspace_remap_without_residue() {
    let fixture = MappedProjectsVault::new("legacy-migration-remap-race", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/STATE.md"),
        "# State\n\nRemapping must serialize with migration.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let original_before = tree_hashes(&fixture.project_root());
    let ready = fixture._app_data.root().join("remap-ready");
    let release = fixture._app_data.root().join("remap-release");

    let mut remap = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("legacy_migration_remap_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
        .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
        .env("KODADE_TEST_PORTABLE_LOCK_READY", &ready)
        .env("KODADE_TEST_PORTABLE_LOCK_RELEASE", &release)
        .spawn()
        .unwrap();
    wait_for_file(&ready, Duration::from_secs(5));
    let mut migration = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("legacy_migration_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_MIGRATION_CHILD_DB", fixture._app_data.db())
        .env("KODADE_MIGRATION_CHILD_WORKSPACE", &fixture.workspace.id)
        .env("KODADE_MIGRATION_CHILD_FINGERPRINT", &preview.fingerprint)
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(migration.try_wait().unwrap().is_none());
    std::fs::write(&release, b"release").unwrap();
    assert!(remap.wait().unwrap().success());
    assert!(!migration.wait().unwrap().success());
    assert_eq!(tree_hashes(&fixture.project_root()), original_before);
    assert!(!fixture
        ._app_data
        .root()
        .join("kodade-kodmem-migrations")
        .exists());
    assert_eq!(
        fixture
            .store
            .workspace_project_mapping(&fixture.workspace.id)
            .unwrap()
            .unwrap()
            .project_id,
        "replacement-project"
    );
}

#[test]
fn clone_identical_repo_registrations_produce_byte_identical_vault_cutover() {
    fn prepare(fixture: &MappedProjectsVault, add_clone: bool) {
        let mut workspaces = vec![fixture.workspace.clone()];
        if add_clone {
            let checkout = fixture._app_data.root().join("clone-checkout");
            std::fs::create_dir(&checkout).unwrap();
            let clone = fixture
                .store
                .register_workspace(&checkout, "Clone checkout", None)
                .unwrap();
            fixture
                .store
                .map_workspace_to_project(&clone.id, None, "portable-project", "Portable project")
                .unwrap();
            workspaces.push(clone);
        }
        for (index, workspace) in workspaces.into_iter().enumerate() {
            let modified = FileTimes::new().set_modified(
                UNIX_EPOCH
                    + Duration::from_secs(if index == 0 {
                        1_700_000_000
                    } else {
                        1_800_000_000
                    }),
            );
            fixture
                .store
                .activate_working_memory(&workspace.id, WorkingMemoryMode::Commit, false)
                .unwrap();
            for (name, contents) in [
                ("STATE.md", "# State\n\nPortable clone state.\n"),
                ("WORKLOG.md", "# Worklog\n\n- Portable clone history.\n"),
            ] {
                let path = Path::new(&workspace.canonical_root)
                    .join(".kodade/memory")
                    .join(name);
                std::fs::write(&path, contents).unwrap();
                File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_times(modified)
                    .unwrap();
            }
        }
        let scaffold = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
            .unwrap();
    }

    let single = MappedProjectsVault::new("legacy-migration-single-clone", "Portable project");
    let doubled = MappedProjectsVault::new("legacy-migration-double-clone", "Portable project");
    prepare(&single, false);
    prepare(&doubled, true);
    let single_plan = single
        .store
        .preview_legacy_migration(&single.workspace.id)
        .unwrap();
    let doubled_plan = doubled
        .store
        .preview_legacy_migration(&doubled.workspace.id)
        .unwrap();
    assert_eq!(single_plan.migration_id, doubled_plan.migration_id);
    assert_eq!(single_plan.manifest_sha256, doubled_plan.manifest_sha256);
    assert_eq!(single_plan.fingerprint, doubled_plan.fingerprint);
    assert_eq!(single_plan.counts, doubled_plan.counts);
    assert_eq!(single_plan.operations, doubled_plan.operations);
    single
        .store
        .apply_legacy_migration(&single.workspace.id, &single_plan.fingerprint)
        .unwrap();
    doubled
        .store
        .apply_legacy_migration(&doubled.workspace.id, &doubled_plan.fingerprint)
        .unwrap();
    assert_eq!(
        tree_hashes(&single.project_root()),
        tree_hashes(&doubled.project_root())
    );
}

#[test]
fn incremental_repo_snapshot_imports_only_new_components_and_preserves_prior_artifacts() {
    let fixture = MappedProjectsVault::new("legacy-migration-incremental-repo", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    let memory_root = fixture.checkout.join(".kodade/memory");
    std::fs::write(
        memory_root.join("STATE.md"),
        "# State\n\nInitial portable state.\n",
    )
    .unwrap();
    std::fs::write(
        memory_root.join("WORKLOG.md"),
        "# Worklog\n\n- Initial portable history.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let first = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &first.fingerprint)
        .unwrap();
    let prior_artifacts = first
        .operations
        .iter()
        .filter(|operation| operation.conflict.is_none())
        .map(|operation| {
            (
                operation.target_relative_path.clone(),
                std::fs::read(fixture.project_root().join(&operation.target_relative_path))
                    .unwrap(),
            )
        })
        .collect::<Vec<_>>();

    std::fs::create_dir_all(memory_root.join("plans")).unwrap();
    std::fs::write(
        memory_root.join("plans/incremental.md"),
        "# Incremental plan\n\nShip only this newly discovered component.\n",
    )
    .unwrap();
    let second = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    assert!(second.can_apply);
    assert_eq!(second.counts.source_files, 1);
    assert_eq!(second.operations.len(), 1);
    assert_eq!(
        second.operations[0].source_relative_path.as_deref(),
        Some(".kodade/memory/plans/incremental.md")
    );
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &second.fingerprint)
        .unwrap();
    for (relative, before) in prior_artifacts {
        assert_eq!(
            std::fs::read(fixture.project_root().join(relative)).unwrap(),
            before,
            "incremental migration must not rewrite already imported components"
        );
    }

    let fresh_data = TempProject::new("legacy-migration-incremental-repo-fresh");
    let fresh = MemoryStore::open(fresh_data.db()).unwrap();
    fresh.register_projects_vault(&fixture.vault_root).unwrap();
    let workspace = fresh
        .register_workspace(&fixture.checkout, "Fresh checkout", None)
        .unwrap();
    fresh
        .map_workspace_to_project(&workspace.id, None, "portable-project", "Portable project")
        .unwrap();
    fresh
        .context(&workspace.id)
        .expect("both repo snapshot receipts authorize on a fresh database");
    assert_eq!(
        fresh
            .preview_legacy_migration(&workspace.id)
            .unwrap()
            .status,
        kodade_lib::memory::LegacyMigrationStatus::Complete
    );
}

#[test]
fn incremental_preview_fails_closed_when_a_prior_repo_artifact_is_missing() {
    let fixture = MappedProjectsVault::new("legacy-migration-missing-prior", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    let memory_root = fixture.checkout.join(".kodade/memory");
    std::fs::write(
        memory_root.join("WORKLOG.md"),
        "# Worklog\n\n- History that must not disappear.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let first = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &first.fingerprint)
        .unwrap();
    let worklog_target = first
        .operations
        .iter()
        .find(|operation| operation.source_kind == "worklog")
        .unwrap();
    std::fs::remove_file(
        fixture
            .project_root()
            .join(&worklog_target.target_relative_path),
    )
    .unwrap();
    std::fs::create_dir_all(memory_root.join("plans")).unwrap();
    std::fs::write(
        memory_root.join("plans/new.md"),
        "# New plan\n\nThis cannot hide missing prior history.\n",
    )
    .unwrap();
    let error = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect_err("missing prior cutover target must block before component coverage");
    assert!(error.to_string().contains("artifacts"));
}

#[test]
fn wrapper_authority_rejects_self_consistent_cross_lane_cutover_forgery() {
    let fixture =
        MappedProjectsVault::new("legacy-migration-wrapper-route-forge", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    std::fs::write(
        fixture.checkout.join(".kodade/memory/WORKLOG.md"),
        "# Worklog\n\n- Route-bound provenance.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();
    let original = preview
        .operations
        .iter()
        .find(|operation| operation.source_kind == "worklog")
        .unwrap()
        .target_relative_path
        .clone();
    let original_bytes = std::fs::read(fixture.project_root().join(&original)).unwrap();
    let copied = fixture
        .project_root()
        .join("Knowledge/Legacy/copied-authorized-wrapper.md");
    std::fs::create_dir_all(copied.parent().unwrap()).unwrap();
    std::fs::write(&copied, &original_bytes).unwrap();
    assert!(fixture.store.context(&fixture.workspace.id).is_err());
    std::fs::remove_file(copied).unwrap();
    let forged = format!(
        "Plans/Legacy/{}",
        Path::new(&original).file_name().unwrap().to_string_lossy()
    );
    std::fs::create_dir_all(fixture.project_root().join("Plans/Legacy")).unwrap();
    std::fs::rename(
        fixture.project_root().join(&original),
        fixture.project_root().join(&forged),
    )
    .unwrap();
    let project_path = fixture.project_root().join("Project.md");
    let project = std::fs::read_to_string(&project_path).unwrap();
    let rewritten = project
        .lines()
        .map(|line| {
            if !line.starts_with("<!-- kodmem-cutover ") {
                return line.to_string();
            }
            let json = line
                .strip_prefix("<!-- kodmem-cutover ")
                .unwrap()
                .strip_suffix(" -->")
                .unwrap();
            let mut value: serde_json::Value = serde_json::from_str(json).unwrap();
            for migration in value["migrations"].as_array_mut().unwrap() {
                for target in migration["targets"].as_array_mut().unwrap() {
                    if target["relativePath"].as_str() == Some(original.as_str()) {
                        target["relativePath"] = forged.clone().into();
                        target["sourceKind"] = "plan".into();
                    }
                }
            }
            format!(
                "<!-- kodmem-cutover {} -->",
                serde_json::to_string(&value).unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(project_path, rewritten).unwrap();
    let error = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect_err("portable source identity cannot be retagged into another lane");
    assert!(error.to_string().contains("artifacts"));
}

#[test]
fn completed_preview_selects_latest_rollback_leaf_not_reverse_lexical_migration_id() {
    let fixture =
        MappedProjectsVault::new("legacy-migration-rollback-leaf-order", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    let memory_root = fixture.checkout.join(".kodade/memory");
    std::fs::write(
        memory_root.join("WORKLOG.md"),
        "# Worklog\n\n- First applied migration.\n",
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let first = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let first_applied = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &first.fingerprint)
        .unwrap();

    std::fs::create_dir_all(memory_root.join("plans")).unwrap();
    let first_id = first_applied.migration_id.clone();
    let second = (0..256)
        .find_map(|nonce| {
            std::fs::write(
                memory_root.join("plans/leaf-order.md"),
                format!("# Leaf order\n\nCandidate {nonce}.\n"),
            )
            .unwrap();
            let candidate = fixture
                .store
                .preview_legacy_migration(&fixture.workspace.id)
                .unwrap();
            candidate
                .migration_id
                .as_ref()
                .is_some_and(|id| id < &first_id)
                .then_some(candidate)
        })
        .expect("find a later content-derived ID that sorts before the first migration");
    let second_applied = fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &second.fingerprint)
        .unwrap();
    assert!(second_applied.migration_id < first_applied.migration_id);

    let complete = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    let recovery = complete.recovery.expect("latest leaf is rollbackable");
    assert_eq!(recovery.migration_id, second_applied.migration_id);
    fixture
        .store
        .rollback_legacy_migration(
            &fixture.workspace.id,
            &recovery.migration_id,
            &recovery.manifest_sha256,
        )
        .unwrap();
    std::fs::remove_file(memory_root.join("plans/leaf-order.md")).unwrap();
    let prior = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    assert_eq!(
        prior.recovery.unwrap().migration_id,
        first_applied.migration_id
    );
}

#[test]
fn incremental_checkpoint_snapshot_batches_provenance_merges_and_new_daily_entry() {
    let fixture =
        MappedProjectsVault::new("legacy-migration-checkpoint-batch-a", "Portable project");
    let inputs = [
        NewCheckpoint {
            workspace_id: fixture.workspace.id.clone(),
            summary: "First cloned checkpoint".into(),
            decisions: vec!["Keep the first history item".into()],
            next_actions: vec!["Clone it once".into()],
            changed_paths: vec!["src/first.rs".into()],
            source: MemorySource::Agent,
            source_client: "migration-batch-test".into(),
            session_id: Some("migration-batch".into()),
            idempotency_key: Some("migration-batch-first".into()),
        },
        NewCheckpoint {
            workspace_id: fixture.workspace.id.clone(),
            summary: "Second cloned checkpoint".into(),
            decisions: vec!["Keep the second history item".into()],
            next_actions: vec!["Clone it once".into()],
            changed_paths: vec!["src/second.rs".into()],
            source: MemorySource::Agent,
            source_client: "migration-batch-test".into(),
            session_id: Some("migration-batch".into()),
            idempotency_key: Some("migration-batch-second".into()),
        },
    ];
    for input in &inputs {
        fixture
            .store
            .checkpoint_with_authority(input.clone(), false, None)
            .unwrap();
    }
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let first = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &first.fingerprint)
        .unwrap();

    let machine_b = TempProject::new("legacy-migration-checkpoint-batch-b");
    let checkout_b = machine_b.root().join("checkout");
    std::fs::create_dir(&checkout_b).unwrap();
    let store_b = MemoryStore::open(machine_b.db()).unwrap();
    store_b
        .register_projects_vault(&fixture.vault_root)
        .unwrap();
    let workspace_b = store_b
        .register_workspace(&checkout_b, "Portable project B", None)
        .unwrap();
    let connection = rusqlite::Connection::open(machine_b.db()).unwrap();
    let source_db = fixture._app_data.db().to_string_lossy().into_owned();
    connection
        .execute("ATTACH DATABASE ?1 AS source_db", [&source_db])
        .unwrap();
    connection
        .execute(
            "INSERT INTO checkpoints (
                id, workspace_id, summary, decisions_json, next_actions_json,
                changed_paths_json, source, source_client, session_id,
                idempotency_key, created_at, updates_state, canonical_project_id,
                canonical_checkpoint_id, canonical_relative_path
             )
             SELECT id, ?1, summary, decisions_json, next_actions_json,
                changed_paths_json, source, source_client, session_id,
                idempotency_key, created_at, updates_state, NULL, NULL, NULL
             FROM source_db.checkpoints
             WHERE workspace_id = ?2 AND canonical_project_id IS NULL",
            rusqlite::params![workspace_b.id, fixture.workspace.id],
        )
        .unwrap();
    connection.execute("DETACH DATABASE source_db", []).unwrap();
    drop(connection);
    store_b
        .checkpoint_with_authority(
            NewCheckpoint {
                workspace_id: workspace_b.id.clone(),
                summary: "New incremental checkpoint".into(),
                decisions: vec!["Append exactly one new history item".into()],
                next_actions: vec!["Verify the batched Worklog CAS".into()],
                changed_paths: vec!["src/new.rs".into()],
                source: MemorySource::Agent,
                source_client: "migration-batch-test".into(),
                session_id: Some("migration-batch".into()),
                idempotency_key: Some("migration-batch-new".into()),
            },
            false,
            None,
        )
        .unwrap();
    store_b
        .map_workspace_to_project(
            &workspace_b.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    let second = store_b.preview_legacy_migration(&workspace_b.id).unwrap();
    assert!(second.can_apply, "operations: {:?}", second.operations);
    assert_eq!(
        second
            .operations
            .iter()
            .filter(|operation| operation.source_kind == "sqlite-checkpoint"
                && operation.conflict.is_none()
                && operation.action != kodade_lib::memory::LegacyMigrationAction::SkipDuplicate)
            .count(),
        1,
        "all daily checkpoint changes must share one Worklog CAS postimage"
    );
    store_b
        .apply_legacy_migration(&workspace_b.id, &second.fingerprint)
        .unwrap();
    let worklog = walk_files(&fixture.project_root().join("Worklog"))
        .into_iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .collect::<String>();
    assert_eq!(worklog.matches("<!-- kodmem-checkpoint {").count(), 3);
    assert_eq!(worklog.matches("First cloned checkpoint").count(), 2);
    assert_eq!(worklog.matches("Second cloned checkpoint").count(), 2);
    assert_eq!(worklog.matches("New incremental checkpoint").count(), 2);
    store_b
        .context(&workspace_b.id)
        .expect("merged checkpoint provenance remains authoritative");
    assert_eq!(
        store_b
            .preview_legacy_migration(&workspace_b.id)
            .unwrap()
            .status,
        kodade_lib::memory::LegacyMigrationStatus::Complete
    );
}

#[test]
fn migrated_links_and_backlinks_rebuild_on_a_fresh_database() {
    let fixture = MappedProjectsVault::new("legacy-migration-links", "Portable project");
    let target = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Legacy linked target".into(),
            body: "This target must keep its backlink after migration.".into(),
            source: MemorySource::User,
            source_client: "migration-link-test".into(),
            session_id: Some("migration-links".into()),
            pinned: false,
            idempotency_key: Some("migration-link-target".into()),
            links: Vec::new(),
        })
        .unwrap();
    fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Legacy linked source".into(),
            body: "This decision must point to the migrated target.".into(),
            source: MemorySource::Agent,
            source_client: "migration-link-test".into(),
            session_id: Some("migration-links".into()),
            pinned: true,
            idempotency_key: Some("migration-link-source".into()),
            links: vec![MemoryLink {
                target_id: target.id,
                relation: "supports".into(),
            }],
        })
        .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .unwrap();

    let fresh_data = TempProject::new("legacy-migration-links-fresh");
    let fresh = MemoryStore::open(fresh_data.db()).unwrap();
    fresh.register_projects_vault(&fixture.vault_root).unwrap();
    let workspace = fresh
        .register_workspace(&fixture.checkout, "Fresh link checkout", None)
        .unwrap();
    fresh
        .map_workspace_to_project(&workspace.id, None, "portable-project", "Portable project")
        .unwrap();
    let source_hit = fresh
        .search(MemoryQuery {
            workspace_id: workspace.id.clone(),
            text: "decision must point".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 10,
            offset: 0,
        })
        .unwrap();
    let target_hit = fresh
        .search(MemoryQuery {
            workspace_id: workspace.id.clone(),
            text: "backlink after migration".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 10,
            offset: 0,
        })
        .unwrap();
    assert_eq!(source_hit.total, 1, "source hits: {:?}", source_hit.items);
    assert_eq!(target_hit.total, 1, "target hits: {:?}", target_hit.items);
    let source = fresh.memory(&source_hit.items[0].id).unwrap();
    let target = fresh.memory(&target_hit.items[0].id).unwrap();
    assert_eq!(source.links.len(), 1);
    assert_eq!(source.links[0].target_id, target.id);
    assert_eq!(target.backlinks.len(), 1);
    assert_eq!(target.backlinks[0].target_id, source.id);
}

#[test]
fn migrated_wrapper_preserves_inert_marker_examples_in_legacy_body() {
    let fixture = MappedProjectsVault::new("legacy-migration-marker-body", "Portable project");
    fixture
        .store
        .activate_working_memory(&fixture.workspace.id, WorkingMemoryMode::Commit, false)
        .unwrap();
    let example = format!(
        "<!-- kodmem-migration {{\"schema\":1,\"migrationId\":\"kmig_{}\",\"sourceSha256\":\"{}\",\"sourceSnapshotSha256\":\"{}\",\"sourceOrigins\":[{{\"sourceKind\":\"repo-readable-v1\",\"sourceSnapshotSha256\":\"{}\",\"legacyIdentity\":\".kodade/memory/EXAMPLE.md\",\"sourceSha256\":\"{}\",\"sourceModifiedAt\":1}}],\"sourceModifiedAt\":1}} -->",
        "a".repeat(32),
        "b".repeat(64),
        "c".repeat(64),
        "c".repeat(64),
        "b".repeat(64),
    );
    let checkpoint_example = format!(
        "<!-- kodmem-checkpoint {} -->",
        serde_json::json!({
            "schema": 1,
            "checkpointId": "km_checkpoint_example",
            "projectId": "portable-project",
            "source": "agent",
            "sourceClient": "documentation",
            "sessionId": null,
            "idempotencyKeyHash": null,
            "payloadHash": "d".repeat(64),
            "createdAt": 1,
            "updatesState": false,
            "summary": "Historical example",
            "decisions": [],
            "nextActions": [],
            "changedPaths": [],
            "migration": {
                "migrationId": format!("kmig_{}", "e".repeat(32)),
                "legacyId": "legacy-checkpoint-example",
                "sourceSha256": "f".repeat(64),
                "origins": [{
                    "sourceKind": "sqlite-legacy-v1",
                    "legacyId": "legacy-checkpoint-example",
                    "sourceSha256": "f".repeat(64),
                }],
            },
        })
    );
    std::fs::write(
        fixture.checkout.join(".kodade/memory/WORKLOG.md"),
        format!(
            "# Worklog\n\nHistorical documentation preserves this standalone example:\n\n{example}\n\n{checkpoint_example}\n## Historical checkpoint example\n\n- Real historical entry.\n"
        ),
    )
    .unwrap();
    let scaffold = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &scaffold.fingerprint)
        .unwrap();
    let preview = fixture
        .store
        .preview_legacy_migration(&fixture.workspace.id)
        .expect("body marker example is inert during preview");
    fixture
        .store
        .apply_legacy_migration(&fixture.workspace.id, &preview.fingerprint)
        .expect("body marker example is inert during apply");
    let target = fixture
        .project_root()
        .join(&preview.operations[0].target_relative_path);
    let migrated = std::fs::read_to_string(target).unwrap();
    assert!(migrated.contains(&example));
    assert!(migrated.contains(&checkpoint_example));
    fixture
        .store
        .context(&fixture.workspace.id)
        .expect("body marker example never participates in authority");
}

#[test]
fn mapped_authority_checkpoint_writes_markdown_first_and_retries_once() {
    let fixture = MappedProjectsVault::new("mapped-checkpoint-authority", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview scaffold");
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .expect("activate portable authority");
    let state_path = fixture.project_root().join("STATE.md");
    let expected_state = format!("{:x}", Sha256::digest(std::fs::read(&state_path).unwrap()));
    let input = NewCheckpoint {
        workspace_id: fixture.workspace.id.clone(),
        summary: "Canonical checkpoint result".into(),
        decisions: vec!["Keep Markdown authoritative".into()],
        next_actions: vec!["Exercise recovery".into()],
        changed_paths: vec!["src/main.rs".into()],
        source: MemorySource::Agent,
        source_client: "memory-store-test".into(),
        session_id: Some("portable-session".into()),
        idempotency_key: Some("portable-checkpoint-1".into()),
    };

    let created = fixture
        .store
        .checkpoint_with_state_hash(input.clone(), Some(&expected_state))
        .expect("write canonical checkpoint");
    let reopened = MemoryStore::open(fixture._app_data.db()).expect("reopen store");
    let retried = reopened
        .checkpoint_with_state_hash(input.clone(), Some(&expected_state))
        .expect("retry canonical checkpoint");

    assert_eq!(retried.id, created.id);
    let worklogs = walk_files(&fixture.project_root().join("Worklog"))
        .into_iter()
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("md"))
        .collect::<Vec<_>>();
    assert_eq!(worklogs.len(), 1, "worklog files: {worklogs:?}");
    let worklog = std::fs::read_to_string(&worklogs[0]).expect("read daily worklog");
    assert_eq!(worklog.matches("<!-- kodmem-checkpoint {").count(), 1);
    assert!(worklog.contains("Canonical checkpoint result"));
    assert!(std::fs::read_to_string(state_path)
        .expect("read state")
        .contains("Canonical checkpoint result"));
    assert!(fixture
        .project_root()
        .join("Decisions")
        .read_dir()
        .unwrap()
        .any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("checkpoint-")
        }));
    assert!(!fixture.checkout.join(".kodade/memory").exists());

    let mut changed = input;
    changed.summary = "Different payload".into();
    let conflict = reopened
        .checkpoint_with_state_hash(changed, None)
        .expect_err("same project key with different payload must conflict");
    assert!(
        matches!(conflict, MemoryError::InvalidInput(message) if message.contains("different payload"))
    );
}

#[test]
fn mapped_checkpoint_rejects_stale_state_hash_without_any_residue() {
    let fixture = MappedProjectsVault::new("mapped-checkpoint-stale-state", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let state_path = fixture.project_root().join("STATE.md");
    let state_before = std::fs::read(&state_path).unwrap();
    let vault_before = tree_hashes(&fixture.project_root());
    let audit_before = fixture.store.audit(&fixture.workspace.id, 100).unwrap();
    let connection = rusqlite::Connection::open(fixture._app_data.db()).unwrap();
    let projection_before: (u64, u64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM checkpoints),
                    (SELECT COUNT(*) FROM project_documents)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    drop(connection);

    let stale = "0".repeat(64);
    let rejected = fixture.store.checkpoint_with_state_hash(
        NewCheckpoint {
            workspace_id: fixture.workspace.id.clone(),
            summary: "Must leave no checkpoint residue".into(),
            decisions: vec!["Must leave no decision residue".into()],
            next_actions: vec!["Refresh STATE before retry".into()],
            changed_paths: vec!["STATE.md".into()],
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: Some("stale-state".into()),
            idempotency_key: Some("stale-state-rejected".into()),
        },
        Some(&stale),
    );
    let actual = file_hash(&state_path);
    assert!(matches!(
        rejected,
        Err(MemoryError::ContentConflict { expected, actual: conflict_actual })
            if expected == stale && conflict_actual == actual
    ));
    assert_eq!(std::fs::read(&state_path).unwrap(), state_before);
    assert_eq!(tree_hashes(&fixture.project_root()), vault_before);
    assert!(!portable_journal_path(&fixture.project_root()).exists());
    assert_eq!(
        fixture.store.audit(&fixture.workspace.id, 100).unwrap(),
        audit_before
    );
    let connection = rusqlite::Connection::open(fixture._app_data.db()).unwrap();
    let projection_after: (u64, u64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM checkpoints),
                    (SELECT COUNT(*) FROM project_documents)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(projection_after, projection_before);
}

#[test]
fn mapped_memory_lifecycle_uses_hash_conflicts_archive_and_markdown_rebuild() {
    let fixture = MappedProjectsVault::new("mapped-record-lifecycle", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let input = NewMemory {
        workspace_id: fixture.workspace.id.clone(),
        kind: MemoryKind::Fact,
        title: "Portable fact".into(),
        body: "Markdown owns this fact.".into(),
        source: MemorySource::Agent,
        source_client: "memory-store-test".into(),
        session_id: Some("record-session".into()),
        pinned: true,
        idempotency_key: Some("portable-record-1".into()),
        links: Vec::new(),
    };
    let created = fixture
        .store
        .remember(input.clone())
        .expect("remember canonical note");
    assert_eq!(
        fixture.store.remember(input.clone()).unwrap().id,
        created.id
    );
    let source = created
        .project_source
        .clone()
        .expect("canonical provenance");
    let note_path = fixture.project_root().join(&source.relative_path);
    let mut human_edit = std::fs::read_to_string(&note_path).unwrap();
    human_edit.push_str("\nHuman edit that must not be overwritten.\n");
    std::fs::write(&note_path, &human_edit).unwrap();
    let human_hash = format!("{:x}", Sha256::digest(human_edit.as_bytes()));
    let revision = MemoryRevision {
        id: created.id.clone(),
        expected_version: created.version,
        kind: MemoryKind::Decision,
        title: "Portable decision".into(),
        body: "Use the canonical project note.".into(),
        pinned: true,
        source_client: "memory-store-test".into(),
        session_id: Some("record-session".into()),
        links: Vec::new(),
    };
    assert!(matches!(
        fixture
            .store
            .revise_with_content_hash(revision.clone(), Some(&source.sha256)),
        Err(MemoryError::ContentConflict { .. })
    ));
    let revised = fixture
        .store
        .revise_with_content_hash(revision, Some(&human_hash))
        .expect("revise with current human-edit hash");
    assert_eq!(revised.version, 2);
    assert!(revised
        .project_source
        .as_ref()
        .unwrap()
        .relative_path
        .starts_with("Decisions/"));

    let revised_source = revised.project_source.clone().unwrap();
    let tombstone = fixture
        .store
        .forget_in_workspace_with_content_hash(
            &revised.id,
            revised.version,
            &fixture.workspace.id,
            Some(&revised_source.sha256),
            "memory-store-test",
            Some("record-session"),
        )
        .expect("archive record");
    let deleted_page = fixture
        .store
        .deleted_memory_page(DeletedMemoryQuery {
            workspace_id: fixture.workspace.id.clone(),
            limit: 20,
            offset: 0,
        })
        .unwrap();
    let archived = deleted_page
        .items
        .into_iter()
        .next()
        .expect("mapped tombstone page");
    assert!(archived.deleted_at.is_some());
    assert!(archived
        .project_source
        .as_ref()
        .unwrap()
        .relative_path
        .contains("/Archive/"));
    let restored = fixture
        .store
        .restore_with_content_hash(
            &revised.id,
            tombstone.version,
            Some(&archived.project_source.as_ref().unwrap().sha256),
            "memory-store-test",
            Some("record-session"),
        )
        .expect("restore archived record");
    assert_eq!(restored.version, 4);
    assert_eq!(restored.deleted_at, None);
    let reopened = MemoryStore::open(fixture._app_data.db()).unwrap();
    let delayed_retry = reopened
        .remember(input)
        .expect("original remember retry remains idempotent after lifecycle");
    assert_eq!(delayed_retry.id, restored.id);
    assert_eq!(delayed_retry.version, restored.version);

    let connection = rusqlite::Connection::open(fixture._app_data.db()).unwrap();
    connection
        .execute(
            "DELETE FROM memories WHERE canonical_project_id = 'portable-project'",
            [],
        )
        .unwrap();
    drop(connection);
    fixture
        .store
        .rebuild_project_from_markdown(&fixture.workspace.id)
        .expect("rebuild SQLite from canonical Markdown");
    let rebuilt = fixture.store.memory(&restored.id).expect("rebuilt memory");
    assert_eq!(rebuilt.title, "Portable decision");
    assert_eq!(rebuilt.body, "Use the canonical project note.");
}

#[test]
fn portable_templates_preserve_literal_user_tokens_across_round_trips() {
    let fixture = MappedProjectsVault::new("mapped-literal-template-content", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();

    let declared_tokens = "{{title_json}} {{type}} {{status}} {{project_id}} {{marker}} {{title}} {{body}} {{record_id}} {{year}} {{date}} {{checkpoint_id}} {{index}} {{timestamp}} {{summary}} {{project_name}} {{decision}}";
    let created = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "{{body}}".into(),
            body: format!(
                "Literal memory tokens: {declared_tokens}\nTemplater: <% tp.file.title %>"
            ),
            source: MemorySource::User,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("literal-template-memory".into()),
            links: Vec::new(),
        })
        .expect("remember literal template syntax");
    assert_eq!(created.title, "{{body}}");
    assert!(created.body.contains(declared_tokens));

    let revised_title = declared_tokens.to_string();
    let revised_body = format!(
        "Revised literal tokens: {declared_tokens}\nObsidian: {{{{project}}}}\nTemplater: <%* tR += '{{{{summary}}}}' %>"
    );
    let revised = fixture
        .store
        .revise_with_content_hash(
            MemoryRevision {
                id: created.id.clone(),
                expected_version: created.version,
                kind: MemoryKind::Fact,
                title: revised_title.clone(),
                body: revised_body.clone(),
                pinned: true,
                source_client: "memory-store-test".into(),
                session_id: None,
                links: Vec::new(),
            },
            Some(&created.project_source.as_ref().unwrap().sha256),
        )
        .expect("revise literal template syntax");
    assert_eq!(revised.title, revised_title);
    assert_eq!(revised.body, revised_body);

    let summary = declared_tokens;
    let decision = declared_tokens;
    let state_path = fixture.project_root().join("STATE.md");
    let state_hash = file_hash(&state_path);
    let checkpoint = fixture
        .store
        .checkpoint_with_state_hash(
            NewCheckpoint {
                workspace_id: fixture.workspace.id.clone(),
                summary: summary.into(),
                decisions: vec![decision.into()],
                next_actions: vec!["Keep {{project}} and <% tp.date.now() %> literal".into()],
                changed_paths: vec!["templates/{{body}}.md".into()],
                source: MemorySource::Agent,
                source_client: "memory-store-test".into(),
                session_id: None,
                idempotency_key: Some("literal-template-checkpoint".into()),
            },
            Some(&state_hash),
        )
        .expect("checkpoint literal template syntax");
    assert_eq!(checkpoint.summary, summary);
    assert_eq!(checkpoint.decisions, vec![decision]);

    fixture
        .store
        .rebuild_project_from_markdown(&fixture.workspace.id)
        .unwrap();
    let rebuilt = fixture.store.memory(&revised.id).unwrap();
    assert_eq!(rebuilt.title, revised_title);
    assert_eq!(rebuilt.body, revised_body);
    let rebuilt_checkpoint = fixture.store.checkpoint_by_id(&checkpoint.id).unwrap();
    assert_eq!(rebuilt_checkpoint.summary, summary);
    assert_eq!(rebuilt_checkpoint.decisions, vec![decision]);
}

#[test]
fn mapped_checkpoint_recovers_every_persisted_phase_in_a_child_process() {
    let fixture = MappedProjectsVault::new("mapped-checkpoint-recovery", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let journal = portable_journal_path(&fixture.project_root());
    let phases = [
        "journal",
        "markdown-1",
        "markdown-2",
        "markdown-3",
        "index",
        "projection",
    ];
    for (index, phase) in phases.into_iter().enumerate() {
        let state_hash = file_hash(&fixture.project_root().join("STATE.md"));
        let key = format!("recover-phase-{index}");
        let summary = format!("Recovered after {phase}");
        run_portable_checkpoint_child(
            fixture._app_data.db(),
            &fixture.workspace.id,
            &state_hash,
            &key,
            &summary,
            Some(phase),
        );
        assert!(journal.exists(), "{phase} must retain a recovery journal");
        let worklog_before_recovery = walk_files(&fixture.project_root().join("Worklog"))
            .into_iter()
            .filter_map(|path| std::fs::read_to_string(path).ok())
            .collect::<String>();
        if phase == "journal" {
            assert!(!worklog_before_recovery.contains(&summary));
        }
        if phase == "markdown-1" {
            assert!(worklog_before_recovery.contains(&summary));
            let connection = rusqlite::Connection::open(fixture._app_data.db()).unwrap();
            let projected: u32 = connection
                .query_row(
                    "SELECT COUNT(*) FROM checkpoints WHERE canonical_project_id = 'portable-project' AND summary = ?1",
                    [&summary],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(projected, 0, "Markdown must precede SQLite projection");
        }
        run_portable_checkpoint_child(
            fixture._app_data.db(),
            &fixture.workspace.id,
            &state_hash,
            &key,
            &summary,
            None,
        );
        assert!(
            !journal.exists(),
            "successful recovery clears {phase} journal"
        );
        let worklog = walk_files(&fixture.project_root().join("Worklog"))
            .into_iter()
            .filter_map(|path| std::fs::read_to_string(path).ok())
            .collect::<String>();
        assert_eq!(
            worklog.matches("<!-- kodmem-checkpoint {").count(),
            index + 1,
            "retry after {phase} must not append a duplicate entry",
        );
    }
}

#[test]
fn fresh_machine_fails_closed_on_partial_checkpoint_and_rebuilds_complete_markdown() {
    for (phase, should_rebuild) in [("markdown-1", false), ("index", true)] {
        let fixture = MappedProjectsVault::new(
            &format!("mapped-cross-machine-recovery-{phase}"),
            "Portable project",
        );
        let plan = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
            .unwrap();
        let state_hash = file_hash(&fixture.project_root().join("STATE.md"));
        run_portable_checkpoint_child(
            fixture._app_data.db(),
            &fixture.workspace.id,
            &state_hash,
            &format!("cross-machine-{phase}"),
            "Cross-machine canonical checkpoint",
            Some(phase),
        );
        std::fs::remove_file(portable_journal_path(&fixture.project_root())).unwrap();

        let other = TempProject::new(&format!("cross-machine-db-{phase}"));
        let checkout = other.root().join("checkout");
        std::fs::create_dir(&checkout).unwrap();
        let store = MemoryStore::open(other.db()).unwrap();
        store.register_projects_vault(&fixture.vault_root).unwrap();
        let workspace = store
            .register_workspace(&checkout, "Fresh machine", None)
            .unwrap();
        store
            .map_workspace_to_project(&workspace.id, None, "portable-project", "Portable project")
            .unwrap();
        let context = store.context(&workspace.id);
        if should_rebuild {
            assert_eq!(
                context.unwrap().latest_checkpoint.unwrap().summary,
                "Cross-machine canonical checkpoint"
            );
        } else {
            assert!(context.is_err(), "partial checkpoint must fail closed");
        }
    }
}

#[test]
fn mapped_lane_revision_recovers_after_durable_destination_before_source_delete() {
    let fixture = MappedProjectsVault::new("mapped-revise-durable-delete", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let created = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Move lanes durably".into(),
            body: "The destination must be durable before source deletion.".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("durable-lane-source".into()),
            links: Vec::new(),
        })
        .unwrap();
    let source = fixture
        .project_root()
        .join(&created.project_source.as_ref().unwrap().relative_path);
    let logical_id = source.file_stem().unwrap().to_string_lossy();
    let destination = fixture
        .project_root()
        .join("Decisions")
        .join(format!("{logical_id}.md"));

    let status = portable_revise_command(
        fixture._app_data.db(),
        &created.id,
        created.version,
        &created.project_source.as_ref().unwrap().sha256,
        "markdown-1",
    )
    .status()
    .expect("run portable revise child");
    assert!(status.success());
    assert!(
        destination.is_file(),
        "the replacement lane must be durable at the first phase boundary"
    );
    assert!(
        source.is_file(),
        "the old lane must remain until the destination is durable"
    );
    assert!(portable_journal_path(&fixture.project_root()).exists());

    fixture
        .store
        .context(&fixture.workspace.id)
        .expect("recover interrupted lane revision");
    assert!(!source.exists());
    assert!(destination.is_file());
    assert!(!portable_journal_path(&fixture.project_root()).exists());
    let recovered = fixture.store.memory(&created.id).unwrap();
    assert_eq!(recovered.kind, MemoryKind::Decision);
    assert_eq!(recovered.version, 2);
}

#[test]
fn portable_revise_child_process_helper() {
    let Ok(db) = std::env::var("KODADE_PORTABLE_REVISE_DB") else {
        return;
    };
    std::env::set_var(
        "KODADE_TEST_PORTABLE_FAIL_AFTER",
        std::env::var("KODADE_PORTABLE_REVISE_FAILPOINT").unwrap(),
    );
    let store = MemoryStore::open(db).unwrap();
    let result = store.revise_with_content_hash(
        MemoryRevision {
            id: std::env::var("KODADE_PORTABLE_REVISE_ID").unwrap(),
            expected_version: std::env::var("KODADE_PORTABLE_REVISE_VERSION")
                .unwrap()
                .parse()
                .unwrap(),
            kind: MemoryKind::Decision,
            title: "Moved lane durably".into(),
            body: "The destination is written and synced first.".into(),
            pinned: true,
            source_client: "portable-revise-child".into(),
            session_id: None,
            links: Vec::new(),
        },
        Some(&std::env::var("KODADE_PORTABLE_REVISE_HASH").unwrap()),
    );
    assert!(
        result.is_err(),
        "failpoint must interrupt the lane revision"
    );
}

#[test]
fn portable_checkpoint_child_process_helper() {
    let Ok(db) = std::env::var("KODADE_PORTABLE_CHILD_DB") else {
        return;
    };
    let workspace_id = std::env::var("KODADE_PORTABLE_CHILD_WORKSPACE").unwrap();
    let state_hash = std::env::var("KODADE_PORTABLE_CHILD_STATE_HASH").unwrap();
    let key = std::env::var("KODADE_PORTABLE_CHILD_KEY").unwrap();
    let summary = std::env::var("KODADE_PORTABLE_CHILD_SUMMARY").unwrap();
    let failpoint = std::env::var("KODADE_PORTABLE_CHILD_FAILPOINT").ok();
    if let Some(phase) = failpoint.as_deref() {
        std::env::set_var("KODADE_TEST_PORTABLE_FAIL_AFTER", phase);
    }
    let store = MemoryStore::open(db).expect("child opens store");
    let result = store.checkpoint_with_state_hash(
        NewCheckpoint {
            workspace_id,
            summary,
            decisions: vec!["Durable recovery decision".into()],
            next_actions: vec!["Resume safely".into()],
            changed_paths: vec!["src/recovery.rs".into()],
            source: MemorySource::Agent,
            source_client: "portable-child".into(),
            session_id: Some("recovery-session".into()),
            idempotency_key: Some(key),
        },
        Some(&state_hash),
    );
    if failpoint.is_some() {
        assert!(
            result.is_err(),
            "configured child failpoint must interrupt the write"
        );
    } else {
        result.expect("child recovers portable checkpoint");
    }
}

#[test]
fn legacy_migration_child_process_helper() {
    let Ok(db) = std::env::var("KODADE_MIGRATION_CHILD_DB") else {
        return;
    };
    let workspace_id = std::env::var("KODADE_MIGRATION_CHILD_WORKSPACE").unwrap();
    let failpoint = std::env::var("KODADE_MIGRATION_CHILD_FAILPOINT").ok();
    if let Some(failpoint) = failpoint.as_deref() {
        unsafe { std::env::set_var("KODADE_KODMEM_MIGRATION_FAILPOINT", failpoint) };
    }
    let store = if let Ok(recovery_root) = std::env::var("KODADE_MIGRATION_CHILD_RECOVERY_ROOT") {
        MemoryStore::open_with_migration_recovery_root(db, recovery_root).unwrap()
    } else {
        MemoryStore::open(db).unwrap()
    };
    let result = if let Ok(migration_id) = std::env::var("KODADE_MIGRATION_CHILD_ROLLBACK_ID") {
        let manifest = std::env::var("KODADE_MIGRATION_CHILD_ROLLBACK_MANIFEST").unwrap();
        store
            .rollback_legacy_migration(&workspace_id, &migration_id, &manifest)
            .map(|_| ())
    } else {
        let fingerprint = std::env::var("KODADE_MIGRATION_CHILD_FINGERPRINT").unwrap();
        store
            .apply_legacy_migration(&workspace_id, &fingerprint)
            .map(|_| ())
    };
    if failpoint.is_some() {
        assert!(
            result.is_err(),
            "configured migration failpoint must interrupt apply"
        );
    } else {
        result.expect("migration child applies");
    }
}

#[test]
fn legacy_migration_remap_child_process_helper() {
    let Ok(db) = std::env::var("KODADE_MIGRATION_CHILD_DB") else {
        return;
    };
    let workspace_id = std::env::var("KODADE_MIGRATION_CHILD_WORKSPACE").unwrap();
    let store = MemoryStore::open(db).unwrap();
    store
        .map_workspace_to_project(
            &workspace_id,
            Some("portable-project"),
            "replacement-project",
            "Replacement project",
        )
        .expect("remap child commits after holding the old project lock");
}

#[cfg(unix)]
#[test]
fn mapped_writes_reject_secrets_read_only_access_and_project_root_swaps_without_residue() {
    let fixture = MappedProjectsVault::new("mapped-write-boundaries", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let before = tree_hashes(&fixture.project_root());
    let secret = fixture.store.remember(NewMemory {
        workspace_id: fixture.workspace.id.clone(),
        kind: MemoryKind::Fact,
        title: "Credential".into(),
        body: "ghp_abcdefghijklmnopqrstuvwxyz1234567890".into(),
        source: MemorySource::Agent,
        source_client: "memory-store-test".into(),
        session_id: None,
        pinned: false,
        idempotency_key: Some("secret-rejected".into()),
        links: Vec::new(),
    });
    assert!(matches!(secret, Err(MemoryError::InvalidInput(_))));
    assert_eq!(tree_hashes(&fixture.project_root()), before);

    let read_only = MemoryStore::open_read_only(fixture._app_data.db()).unwrap();
    let rejected = read_only.remember(NewMemory {
        workspace_id: fixture.workspace.id.clone(),
        kind: MemoryKind::Fact,
        title: "Read only".into(),
        body: "Must not create a canonical note.".into(),
        source: MemorySource::Agent,
        source_client: "memory-store-test".into(),
        session_id: None,
        pinned: false,
        idempotency_key: Some("read-only-rejected".into()),
        links: Vec::new(),
    });
    assert!(
        matches!(rejected, Err(MemoryError::InvalidInput(message)) if message.contains("read-only"))
    );
    assert_eq!(tree_hashes(&fixture.project_root()), before);

    let real_project = fixture.project_root().with_extension("real");
    std::fs::rename(fixture.project_root(), &real_project).unwrap();
    let outside = fixture._app_data.root().join("outside-project");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, fixture.project_root()).unwrap();
    let swapped = fixture.store.remember(NewMemory {
        workspace_id: fixture.workspace.id.clone(),
        kind: MemoryKind::Fact,
        title: "Escaped".into(),
        body: "Must remain confined.".into(),
        source: MemorySource::Agent,
        source_client: "memory-store-test".into(),
        session_id: None,
        pinned: false,
        idempotency_key: Some("root-swap".into()),
        links: Vec::new(),
    });
    assert!(matches!(swapped, Err(MemoryError::InvalidInput(_))));
    assert!(walk_files(&outside).is_empty());
}

#[cfg(unix)]
#[test]
fn portable_authority_rejects_oversized_and_symlinked_project_notes_before_writing() {
    for case in ["oversized", "symlink"] {
        let fixture = MappedProjectsVault::new(
            &format!("mapped-project-note-boundary-{case}"),
            "Portable project",
        );
        let plan = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
            .unwrap();
        let project_note = fixture.project_root().join("Project.md");
        match case {
            "oversized" => {
                let file = OpenOptions::new().write(true).open(&project_note).unwrap();
                file.set_len(256 * 1024 + 1).unwrap();
            }
            "symlink" => {
                let real = fixture.project_root().join("Project-real.md");
                std::fs::rename(&project_note, &real).unwrap();
                std::os::unix::fs::symlink(&real, &project_note).unwrap();
            }
            _ => unreachable!(),
        }
        let before = tree_hashes(&fixture.project_root());
        let rejected = fixture.store.remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Must not be written".into(),
            body: "Authority identity must be bounded and regular first.".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some(format!("project-note-boundary-{case}")),
            links: Vec::new(),
        });
        assert!(
            matches!(rejected, Err(MemoryError::InvalidInput(ref message)) if message.contains("regular file") || message.contains("file limit")),
            "{case}: {rejected:?}"
        );
        assert_eq!(tree_hashes(&fixture.project_root()), before);
        assert!(!portable_journal_path(&fixture.project_root()).exists());
    }
}

#[cfg(unix)]
#[test]
fn portable_recovery_rejects_oversized_and_symlinked_runtime_journals_before_deserializing() {
    for case in ["oversized", "symlink"] {
        let fixture = MappedProjectsVault::new(
            &format!("mapped-runtime-journal-boundary-{case}"),
            "Portable project",
        );
        let plan = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
            .unwrap();
        let journal = portable_journal_path(&fixture.project_root());
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        match case {
            "oversized" => {
                let file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&journal)
                    .unwrap();
                file.set_len(64 * 1024 * 1024 + 1).unwrap();
            }
            "symlink" => {
                let outside = fixture._app_data.root().join("forged-journal.json");
                std::fs::write(&outside, b"{}").unwrap();
                std::os::unix::fs::symlink(outside, &journal).unwrap();
            }
            _ => unreachable!(),
        }
        let before = tree_hashes(&fixture.project_root());
        let rejected = fixture.store.remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Runtime journal boundary".into(),
            body: "The forged envelope must be rejected before serde.".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some(format!("runtime-journal-boundary-{case}")),
            links: Vec::new(),
        });
        assert!(
            matches!(rejected, Err(MemoryError::InvalidInput(ref message)) if message.contains("journal") && (message.contains("regular file") || message.contains("envelope limit"))),
            "{case}: {rejected:?}"
        );
        assert_eq!(tree_hashes(&fixture.project_root()), before);
        std::fs::remove_file(journal).unwrap();
    }
}

#[test]
fn mapped_links_are_portable_and_projected_ids_remain_workspace_scoped() {
    let fixture = MappedProjectsVault::new("mapped-portable-links", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let target = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Portable link target".into(),
            body: "Target body".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("portable-target".into()),
            links: Vec::new(),
        })
        .unwrap();
    let linked = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Portable linked decision".into(),
            body: "Link survives a machine-local projection change.".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: true,
            idempotency_key: Some("portable-linked".into()),
            links: vec![MemoryLink {
                target_id: target.id.clone(),
                relation: "supports".into(),
            }],
        })
        .unwrap();

    let checkout_b = fixture._app_data.root().join("checkout-b");
    std::fs::create_dir(&checkout_b).unwrap();
    let workspace_b = fixture
        .store
        .register_workspace(&checkout_b, "Portable B", None)
        .unwrap();
    fixture
        .store
        .map_workspace_to_project(
            &workspace_b.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    fixture
        .store
        .rebuild_project_from_markdown(&workspace_b.id)
        .unwrap();
    let workspace_b_hit = fixture
        .store
        .search(MemoryQuery {
            workspace_id: workspace_b.id.clone(),
            text: "Portable linked decision".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(workspace_b_hit.total, 1);
    assert_ne!(workspace_b_hit.items[0].id, linked.id);
    assert_eq!(
        workspace_b_hit.items[0]
            .project_source
            .as_ref()
            .unwrap()
            .relative_path,
        linked.project_source.as_ref().unwrap().relative_path
    );
    let denied = fixture.store.forget_in_workspace_with_content_hash(
        &linked.id,
        linked.version,
        &workspace_b.id,
        Some(&linked.project_source.as_ref().unwrap().sha256),
        "memory-store-test",
        None,
    );
    assert!(matches!(denied, Err(MemoryError::NotFound(_))));

    let other = TempProject::new("portable-links-other-db");
    let other_checkout = other.root().join("checkout");
    std::fs::create_dir(&other_checkout).unwrap();
    let other_store = MemoryStore::open(other.db()).unwrap();
    other_store
        .register_projects_vault(&fixture.vault_root)
        .unwrap();
    let other_workspace = other_store
        .register_workspace(&other_checkout, "Other machine", None)
        .unwrap();
    other_store
        .map_workspace_to_project(
            &other_workspace.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    let fresh_context = other_store.context(&other_workspace.id).unwrap();
    assert_eq!(fresh_context.pinned_decisions.len(), 1);
    assert_eq!(fresh_context.pinned_decisions[0].links.len(), 1);
    assert!(fresh_context.pinned_decisions[0].project_source.is_some());
    let target_hit = other_store
        .search(MemoryQuery {
            workspace_id: other_workspace.id.clone(),
            text: "Portable link target".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    let linked_hit = other_store
        .search(MemoryQuery {
            workspace_id: other_workspace.id,
            text: "Portable linked decision".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(target_hit.total, 1);
    assert_eq!(linked_hit.total, 1);
    let rebuilt_linked = other_store.memory(&linked_hit.items[0].id).unwrap();
    assert_eq!(rebuilt_linked.links.len(), 1);
    assert_eq!(rebuilt_linked.links[0].target_id, target_hit.items[0].id);
}

#[test]
fn independent_databases_serialize_same_project_without_vault_lock_residue() {
    let fixture = MappedProjectsVault::new("mapped-cross-db-lock", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let other = TempProject::new("mapped-cross-db-lock-other");
    let checkout = other.root().join("checkout");
    std::fs::create_dir(&checkout).unwrap();
    let other_store = MemoryStore::open(other.db()).unwrap();
    other_store
        .register_projects_vault(&fixture.vault_root)
        .unwrap();
    let other_workspace = other_store
        .register_workspace(&checkout, "Other checkout", None)
        .unwrap();
    other_store
        .map_workspace_to_project(
            &other_workspace.id,
            None,
            "portable-project",
            "Portable project",
        )
        .unwrap();
    drop(other_store);
    let state_hash = file_hash(&fixture.project_root().join("STATE.md"));
    let ready_first = fixture._app_data.root().join("first-lock-ready");
    let release_first = fixture._app_data.root().join("release-first-lock");
    let ready_second = fixture._app_data.root().join("second-lock-ready");
    let release_second = fixture._app_data.root().join("release-second-lock");
    std::fs::write(&release_second, "release").unwrap();
    let mut first_command = portable_checkpoint_command(
        fixture._app_data.db(),
        &fixture.workspace.id,
        &state_hash,
        "cross-db-shared-key",
        "One cross-database entry",
        None,
    );
    first_command
        .env("KODADE_TEST_PORTABLE_LOCK_READY", &ready_first)
        .env("KODADE_TEST_PORTABLE_LOCK_RELEASE", &release_first);
    let first = first_command.spawn().unwrap();
    assert!(poll_until(Duration::from_secs(5), || ready_first.exists()));

    let independent = MappedProjectsVault::new("mapped-independent-lock-root", "Independent");
    let plan = independent
        .store
        .preview_project_scaffold(&independent.workspace.id)
        .unwrap();
    independent
        .store
        .apply_project_scaffold(&independent.workspace.id, &plan.fingerprint)
        .unwrap();
    let independent_ready = independent._app_data.root().join("independent-ready");
    let independent_release = independent._app_data.root().join("independent-release");
    std::fs::write(&independent_release, "release").unwrap();
    let mut independent_command = portable_checkpoint_command(
        independent._app_data.db(),
        &independent.workspace.id,
        &file_hash(&independent.project_root().join("STATE.md")),
        "independent-key",
        "Independent project does not contend",
        None,
    );
    independent_command
        .env("KODADE_TEST_PORTABLE_LOCK_READY", &independent_ready)
        .env("KODADE_TEST_PORTABLE_LOCK_RELEASE", &independent_release);
    wait_for_child(
        independent_command.spawn().unwrap(),
        "independent portable project",
        Duration::from_secs(5),
    );
    assert!(independent_ready.exists());

    let mut second_command = portable_checkpoint_command(
        other.db(),
        &other_workspace.id,
        &state_hash,
        "cross-db-shared-key",
        "One cross-database entry",
        None,
    );
    second_command
        .env("KODADE_TEST_PORTABLE_LOCK_READY", &ready_second)
        .env("KODADE_TEST_PORTABLE_LOCK_RELEASE", &release_second);
    let second = second_command.spawn().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        !ready_second.exists(),
        "same canonical project must block before the post-lock barrier"
    );
    std::fs::write(&release_first, "release").unwrap();
    wait_for_child(first, "first shared project writer", Duration::from_secs(5));
    wait_for_child(
        second,
        "second shared project writer",
        Duration::from_secs(5),
    );
    assert!(ready_second.exists());
    let worklog = walk_files(&fixture.project_root().join("Worklog"))
        .into_iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .collect::<String>();
    assert_eq!(worklog.matches("<!-- kodmem-checkpoint {").count(), 1);
    assert!(walk_files(&fixture.project_root()).iter().all(|path| {
        !path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with(".kodmem")
    }));
}

#[test]
fn recovery_rejects_a_tampered_state_delete_journal_before_applying_it() {
    let fixture = MappedProjectsVault::new("mapped-tampered-journal", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let state = fixture.project_root().join("STATE.md");
    let state_hash = file_hash(&state);
    run_portable_checkpoint_child(
        fixture._app_data.db(),
        &fixture.workspace.id,
        &state_hash,
        "tampered-journal",
        "Must never delete STATE",
        Some("journal"),
    );
    let journal_path = portable_journal_path(&fixture.project_root());
    let mut journal: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&journal_path).unwrap()).unwrap();
    let state_operation = journal["operations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|operation| operation["relativePath"] == "STATE.md")
        .unwrap();
    state_operation["contents"] = serde_json::Value::Null;
    std::fs::write(&journal_path, serde_json::to_vec_pretty(&journal).unwrap()).unwrap();

    let rejected = fixture.store.checkpoint_with_state_hash(
        NewCheckpoint {
            workspace_id: fixture.workspace.id.clone(),
            summary: "Must never delete STATE".into(),
            decisions: vec!["Durable recovery decision".into()],
            next_actions: vec!["Resume safely".into()],
            changed_paths: vec!["src/recovery.rs".into()],
            source: MemorySource::Agent,
            source_client: "portable-child".into(),
            session_id: Some("recovery-session".into()),
            idempotency_key: Some("tampered-journal".into()),
        },
        Some(&state_hash),
    );
    assert!(
        matches!(rejected, Err(MemoryError::InvalidInput(message)) if message.contains("STATE"))
    );
    assert_eq!(file_hash(&state), state_hash);
    assert!(
        journal_path.exists(),
        "rejected evidence remains recoverable for inspection"
    );
}

#[test]
fn recovery_rejects_safe_prose_and_unknown_field_journal_tampering() {
    for case in ["state", "decision", "worklog", "unknown-field"] {
        let fixture = MappedProjectsVault::new(
            &format!("mapped-journal-byte-binding-{case}"),
            "Portable project",
        );
        let plan = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
            .unwrap();
        let state = fixture.project_root().join("STATE.md");
        let state_hash = file_hash(&state);
        let key = format!("journal-byte-binding-{case}");
        run_portable_checkpoint_child(
            fixture._app_data.db(),
            &fixture.workspace.id,
            &state_hash,
            &key,
            "Original structured checkpoint",
            Some("journal"),
        );
        let journal_path = portable_journal_path(&fixture.project_root());
        let mut journal: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&journal_path).unwrap()).unwrap();
        match case {
            "state" => {
                let operation = journal["operations"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|operation| operation["relativePath"] == "STATE.md")
                    .unwrap();
                let contents = operation["contents"].as_str().unwrap();
                operation["contents"] = format!("{contents}\nSafe forged STATE prose.\n").into();
            }
            "decision" => {
                let operation = journal["operations"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|operation| {
                        operation["relativePath"]
                            .as_str()
                            .is_some_and(|path| path.starts_with("Decisions/checkpoint-"))
                    })
                    .unwrap();
                let contents = operation["contents"].as_str().unwrap();
                operation["contents"] = format!("{contents}\nSafe forged decision prose.\n").into();
            }
            "worklog" => {
                let operation = journal["operations"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|operation| {
                        operation["relativePath"]
                            .as_str()
                            .is_some_and(|path| path.starts_with("Worklog/"))
                    })
                    .unwrap();
                let contents = operation["contents"].as_str().unwrap();
                operation["contents"] =
                    format!("Attempted prior Worklog rewrite.\n{contents}").into();
            }
            "unknown-field" => journal["forged"] = serde_json::json!(true),
            _ => unreachable!(),
        }
        std::fs::write(&journal_path, serde_json::to_vec_pretty(&journal).unwrap()).unwrap();
        let rejected = fixture.store.checkpoint_with_state_hash(
            NewCheckpoint {
                workspace_id: fixture.workspace.id.clone(),
                summary: "Original structured checkpoint".into(),
                decisions: vec!["Durable recovery decision".into()],
                next_actions: vec!["Resume safely".into()],
                changed_paths: vec!["src/recovery.rs".into()],
                source: MemorySource::Agent,
                source_client: "portable-child".into(),
                session_id: Some("recovery-session".into()),
                idempotency_key: Some(key),
            },
            Some(&state_hash),
        );
        assert!(rejected.is_err(), "{case} tamper must fail closed");
        assert_eq!(file_hash(&state), state_hash);
        std::fs::remove_file(journal_path).unwrap();
    }
}

#[test]
fn external_secret_edit_cannot_enter_projection_audit_or_generated_residue() {
    let fixture = MappedProjectsVault::new("mapped-external-secret", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let record = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Safe projected fact".into(),
            body: "Safe body remains projected.".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("external-secret-record".into()),
            links: Vec::new(),
        })
        .unwrap();
    let audit_before = fixture
        .store
        .audit(&fixture.workspace.id, 100)
        .unwrap()
        .len();
    let note = fixture
        .project_root()
        .join(&record.project_source.as_ref().unwrap().relative_path);
    let sentinel = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    let mut text = std::fs::read_to_string(&note).unwrap();
    let marker_line = text
        .lines()
        .find(|line| line.starts_with("<!-- kodmem-memory "))
        .unwrap()
        .to_string();
    let mut marker: serde_json::Value = serde_json::from_str(
        marker_line
            .strip_prefix("<!-- kodmem-memory ")
            .unwrap()
            .strip_suffix(" -->")
            .unwrap(),
    )
    .unwrap();
    marker["payloadHash"] = serde_json::json!(format!("{:x}", Sha256::digest(sentinel.as_bytes())));
    text = text.replace(
        &marker_line,
        &format!(
            "<!-- kodmem-memory {} -->",
            serde_json::to_string(&marker).unwrap()
        ),
    );
    text.push_str(&format!("\n{sentinel}\n"));
    std::fs::write(&note, text).unwrap();

    let rejected = fixture
        .store
        .rebuild_project_from_markdown(&fixture.workspace.id);
    assert!(
        matches!(rejected, Err(MemoryError::InvalidInput(message)) if message.contains("credentials"))
    );
    assert_eq!(
        fixture.store.memory(&record.id).unwrap().body,
        "Safe body remains projected."
    );
    assert_eq!(
        fixture
            .store
            .audit(&fixture.workspace.id, 100)
            .unwrap()
            .len(),
        audit_before
    );
    for path in [
        fixture._app_data.db(),
        PathBuf::from(format!("{}-wal", fixture._app_data.db().display())),
        PathBuf::from(format!("{}-shm", fixture._app_data.db().display())),
    ] {
        if path.exists() {
            assert!(!String::from_utf8_lossy(&std::fs::read(path).unwrap()).contains(sentinel));
        }
    }
    assert!(walk_files(&fixture.project_root()).iter().all(|path| {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        !name.contains("journal") && !name.ends_with(".tmp")
    }));
}

#[test]
fn canonical_rebuild_rejects_oversized_records_worklogs_and_deep_trees() {
    for case in ["record", "worklog", "deep-tree"] {
        let fixture = MappedProjectsVault::new(
            &format!("mapped-bounded-canonical-{case}"),
            "Portable project",
        );
        let plan = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .unwrap();
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
            .unwrap();
        match case {
            "record" => {
                let record = fixture
                    .store
                    .remember(NewMemory {
                        workspace_id: fixture.workspace.id.clone(),
                        kind: MemoryKind::Fact,
                        title: "Bounded record".into(),
                        body: "Safe body".into(),
                        source: MemorySource::Agent,
                        source_client: "memory-store-test".into(),
                        session_id: None,
                        pinned: false,
                        idempotency_key: Some("bounded-record".into()),
                        links: Vec::new(),
                    })
                    .unwrap();
                let path = fixture.project_root().join(
                    &record
                        .project_source
                        .as_ref()
                        .expect("canonical record provenance")
                        .relative_path,
                );
                std::fs::write(path, vec![b'x'; 256 * 1024 + 1]).unwrap();
            }
            "worklog" => {
                let year = fixture.project_root().join("Worklog/2026");
                std::fs::create_dir_all(&year).unwrap();
                std::fs::write(year.join("2026-08-10.md"), vec![b'x'; 256 * 1024 + 1]).unwrap();
            }
            "deep-tree" => {
                let nested = fixture.project_root().join("Worklog/2026/nested");
                std::fs::create_dir_all(&nested).unwrap();
                std::fs::write(nested.join("2026-08-10.md"), "# too deep\n").unwrap();
            }
            _ => unreachable!(),
        }
        let rejected = fixture
            .store
            .rebuild_project_from_markdown(&fixture.workspace.id);
        assert!(
            rejected.is_err(),
            "{case} must exceed canonical read bounds"
        );
    }
}

#[test]
fn canonical_marker_slot_is_strict_without_hiding_prose_or_fenced_examples() {
    let fixture = MappedProjectsVault::new("mapped-canonical-marker-slot", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let example_id = "km_11111111111111111111111111111111";
    std::fs::write(
        fixture
            .project_root()
            .join(format!("Knowledge/{example_id}.md")),
        format!(
            "---\ntitle: Marker example\ntype: knowledge\nstatus: approved\nproject_id: portable-project\n---\n\nOrdinary marker-example-prose text.\n\n```markdown\n<!-- kodmem-memory {{\"schema\":1,\"recordId\":\"{example_id}\",\"projectId\":\"portable-project\",\"kind\":\"fact\",\"source\":\"agent\",\"sourceClient\":\"docs\",\"sessionId\":null,\"pinned\":false,\"version\":1,\"idempotencyKeyHash\":null,\"payloadHash\":\"{}\",\"createdAt\":1,\"updatedAt\":1,\"deletedAt\":null,\"links\":[]}} -->\n```\n",
            "a".repeat(64)
        ),
    )
    .unwrap();
    let page = fixture
        .store
        .search(MemoryQuery {
            workspace_id: fixture.workspace.id.clone(),
            text: "marker-example-prose".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(page.total, 1);
    assert!(page.items[0].id.starts_with("project:"));

    std::fs::write(
        fixture.project_root().join("Knowledge/malformed.md"),
        "---\ntitle: Malformed\ntype: knowledge\nstatus: approved\nproject_id: portable-project\n---\n<!-- kodmem-memory malformed -->\n\n# Malformed\n",
    )
    .unwrap();
    assert!(fixture.store.context(&fixture.workspace.id).is_err());
}

#[test]
fn canonical_record_marker_rejects_unknown_fields_during_rebuild() {
    let fixture = MappedProjectsVault::new("mapped-marker-unknown-field", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let record = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Strict marker".into(),
            body: "Strict marker body".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("strict-marker".into()),
            links: Vec::new(),
        })
        .unwrap();
    let path = fixture
        .project_root()
        .join(&record.project_source.as_ref().unwrap().relative_path);
    let text = std::fs::read_to_string(&path).unwrap();
    let marker = text
        .lines()
        .find(|line| line.starts_with("<!-- kodmem-memory "))
        .unwrap();
    let forged = marker.replacen(" -->", ",\"unknown\":true} -->", 1);
    let forged = forged.replacen("},\"unknown\"", ",\"unknown\"", 1);
    std::fs::write(path, text.replacen(marker, &forged, 1)).unwrap();
    assert!(fixture
        .store
        .rebuild_project_from_markdown(&fixture.workspace.id)
        .is_err());
}

#[test]
fn worklog_prose_and_fenced_marker_examples_are_not_canonical_checkpoints() {
    let fixture = MappedProjectsVault::new("mapped-worklog-marker-example", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    let year = fixture.project_root().join("Worklog/2026");
    std::fs::create_dir_all(&year).unwrap();
    std::fs::write(
        year.join("2026-08-10.md"),
        format!(
            "---\ntitle: Marker documentation\ntype: worklog\ndate: 2026-08-10\n---\n\n# Marker documentation\n\nOrdinary worklog-marker-example prose mentions <!-- kodmem-checkpoint here.\n\n```markdown\n<!-- kodmem-checkpoint {{\"schema\":1,\"checkpointId\":\"km_11111111111111111111111111111111\",\"projectId\":\"portable-project\",\"source\":\"agent\",\"sourceClient\":\"docs\",\"sessionId\":null,\"idempotencyKeyHash\":null,\"payloadHash\":\"{}\",\"createdAt\":1,\"updatesState\":false,\"summary\":\"example\",\"decisions\":[],\"nextActions\":[],\"changedPaths\":[]}} -->\n## Example only\n\nexample\n<!-- /kodmem-checkpoint km_11111111111111111111111111111111 -->\n```\n",
            "a".repeat(64)
        ),
    )
    .unwrap();
    fixture
        .store
        .rebuild_project_from_markdown(&fixture.workspace.id)
        .unwrap();
    assert!(fixture
        .store
        .context(&fixture.workspace.id)
        .unwrap()
        .latest_checkpoint
        .is_none());
    let page = fixture
        .store
        .search(MemoryQuery {
            workspace_id: fixture.workspace.id.clone(),
            text: "worklog-marker-example".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .unwrap();
    assert_eq!(page.total, 1);
}

#[test]
fn expired_portable_archive_cannot_restore_or_reappear_in_rebuild() {
    let fixture = MappedProjectsVault::new("mapped-expired-archive", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .unwrap();
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .unwrap();
    fixture
        .store
        .set_retention(
            &fixture.workspace.id,
            RetentionSettings {
                capture_paused: false,
                activity_days: 30,
                audit_days: 30,
                tombstone_days: 1,
            },
            test_provenance(),
        )
        .unwrap();
    let created = fixture
        .store
        .remember(NewMemory {
            workspace_id: fixture.workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Expiring portable fact".into(),
            body: "Archive retention applies.".into(),
            source: MemorySource::Agent,
            source_client: "memory-store-test".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("expiring-portable".into()),
            links: Vec::new(),
        })
        .unwrap();
    fixture
        .store
        .forget_in_workspace_with_content_hash(
            &created.id,
            1,
            &fixture.workspace.id,
            Some(&created.project_source.as_ref().unwrap().sha256),
            "memory-store-test",
            None,
        )
        .unwrap();
    let archived = fixture.store.memory(&created.id).unwrap();
    let archive_path = fixture
        .project_root()
        .join(&archived.project_source.as_ref().unwrap().relative_path);
    let text = std::fs::read_to_string(&archive_path).unwrap();
    let text = text.replace(
        &format!("\"deletedAt\":{}", archived.deleted_at.unwrap()),
        "\"deletedAt\":0",
    );
    std::fs::write(&archive_path, &text).unwrap();
    let current_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let restore = fixture.store.restore_with_content_hash(
        &created.id,
        archived.version,
        Some(&current_hash),
        "memory-store-test",
        None,
    );
    assert!(
        matches!(restore, Err(MemoryError::InvalidInput(message)) if message.contains("within 1 days"))
    );
    fixture
        .store
        .rebuild_project_from_markdown(&fixture.workspace.id)
        .unwrap();
    assert!(matches!(
        fixture.store.memory(&created.id),
        Err(MemoryError::NotFound(_))
    ));
}

#[test]
fn project_scaffold_apply_is_idempotent_and_preserves_generated_bytes() {
    let fixture = MappedProjectsVault::new("project-scaffold-apply", "Portable project");
    std::fs::write(
        fixture.checkout.join("repository-only.txt"),
        b"repository bytes must never enter the projects vault",
    )
    .expect("write repository-only fixture");

    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview scaffold");

    let applied = fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .expect("apply scaffold");

    assert_eq!(applied.project_id, "portable-project");
    assert_eq!(applied.created, plan.operations);
    let project_path = fixture.project_root().join("Project.md");
    let original_project = std::fs::read(&project_path).expect("read generated Project.md");
    assert!(String::from_utf8_lossy(&original_project).contains(
        "<!-- kodmem-project {\"schema\":1,\"projectId\":\"portable-project\",\"authority\":\"projects-vault\"} -->"
    ));
    assert!(
        !fixture.project_root().join("repository-only.txt").exists(),
        "scaffolding must not copy repository files into the vault"
    );

    let ready = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview completed scaffold");
    assert!(ready.operations.is_empty());
    let repeated = fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &ready.fingerprint)
        .expect("repeat completed scaffold");
    assert!(repeated.created.is_empty());
    assert_eq!(
        std::fs::read(project_path).expect("read Project.md after retry"),
        original_project
    );
}

#[test]
fn project_scaffold_builds_an_obsidian_deep_link_only_after_the_hub_exists() {
    let fixture = MappedProjectsVault::new("project-scaffold-obsidian-link", "Portable project");

    let error = fixture
        .store
        .project_obsidian_uri(&fixture.workspace.id)
        .expect_err("hub must exist before opening it");
    assert!(error
        .to_string()
        .contains("create or repair project knowledge before opening it"));
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview scaffold");
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .expect("apply scaffold");

    let uri = fixture
        .store
        .project_obsidian_uri(&fixture.workspace.id)
        .expect("build Obsidian URI");
    let parsed = url::Url::parse(&uri).expect("parse generated URI");
    let query = parsed
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(parsed.scheme(), "obsidian");
    assert_eq!(parsed.host_str(), Some("open"));
    assert_eq!(
        parsed.query().and_then(|query| query.split('=').next()),
        Some("path")
    );
    assert!(
        !parsed.query().unwrap_or_default().contains('/'),
        "the absolute path must be percent-encoded in the URI"
    );
    assert_eq!(
        query.get("path").map(|value| value.as_ref()),
        fixture.project_root().join("Project.md").to_str()
    );
    assert!(!query.contains_key("vault"));
    assert!(!query.contains_key("file"));
}

#[test]
fn project_scaffold_obsidian_links_distinguish_vault_roots_with_the_same_basename() {
    let first = MappedProjectsVault::with_vault_basename(
        "project-scaffold-same-vault-name-a",
        "Portable project",
        "shared-vault",
    );
    let second = MappedProjectsVault::with_vault_basename(
        "project-scaffold-same-vault-name-b",
        "Portable project",
        "shared-vault",
    );
    for fixture in [&first, &second] {
        let plan = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .expect("preview scaffold");
        fixture
            .store
            .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
            .expect("apply scaffold");
    }

    let first_uri = first
        .store
        .project_obsidian_uri(&first.workspace.id)
        .expect("build first Obsidian URI");
    let second_uri = second
        .store
        .project_obsidian_uri(&second.workspace.id)
        .expect("build second Obsidian URI");

    assert_eq!(
        first.vault_root.file_name(),
        second.vault_root.file_name(),
        "fixture must exercise the ambiguous basename case"
    );
    assert_ne!(first_uri, second_uri);
    for (uri, fixture) in [(&first_uri, &first), (&second_uri, &second)] {
        let parsed = url::Url::parse(uri).expect("parse generated URI");
        assert!(
            !parsed.query().unwrap_or_default().contains('/'),
            "the absolute path must be percent-encoded in the URI"
        );
        let path = parsed
            .query_pairs()
            .find_map(|(key, value)| (key == "path").then_some(value.into_owned()));
        assert_eq!(
            path.as_deref(),
            fixture.project_root().join("Project.md").to_str()
        );
    }
}

#[test]
fn project_scaffold_rejects_an_existing_project_with_the_wrong_identity() {
    let fixture = MappedProjectsVault::new("project-scaffold-wrong-identity", "Portable project");
    let project_path = fixture.project_root().join("Project.md");
    let conflicting =
        b"---\ntitle: Other project\ntype: project\nproject_id: other-project\n---\n\n# Keep me\n";
    std::fs::write(&project_path, conflicting).expect("write conflicting project hub");

    let error = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect_err("reject mismatched portable identity");

    assert!(error.to_string().contains(
        "Project.md project_id is other-project, but this workspace maps to portable-project"
    ));
    assert_eq!(
        std::fs::read(&project_path).expect("read preserved project hub"),
        conflicting
    );
    assert_eq!(
        std::fs::read_dir(fixture.project_root())
            .expect("read project folder")
            .count(),
        1,
        "identity validation must fail before repair writes"
    );
}

#[test]
fn project_scaffold_rejects_malformed_project_identity_contracts() {
    let fixture =
        MappedProjectsVault::new("project-scaffold-malformed-identity", "Portable project");
    let project_path = fixture.project_root().join("Project.md");
    let cases = [
        (
            "# Missing frontmatter\n",
            "must start with YAML frontmatter containing project_id",
        ),
        (
            "---\nproject_id: portable-project\nproject_id: portable-project\n---\n",
            "must contain exactly one project_id",
        ),
        (
            "---\nproject_id: portable-project\n---\n<!-- kodmem-project not-json -->\n",
            "malformed kodmem-project authority marker",
        ),
    ];

    for (contents, expected_error) in cases {
        std::fs::write(&project_path, contents).expect("write malformed project hub");
        let error = fixture
            .store
            .preview_project_scaffold(&fixture.workspace.id)
            .expect_err("reject malformed project identity");
        assert!(
            error.to_string().contains(expected_error),
            "unexpected error: {error}"
        );
    }
}

#[test]
fn project_scaffold_rejects_a_display_name_that_cannot_be_safely_rendered() {
    let fixture = MappedProjectsVault::new("project-scaffold-unsafe-name", "Portable\nproject");

    let error = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect_err("reject a multi-line project display name");

    assert!(error
        .to_string()
        .contains("project display name must be one line"));
}

#[test]
fn project_scaffold_repairs_missing_roles_without_changing_rich_existing_notes() {
    let fixture = MappedProjectsVault::new("project-scaffold-rich-existing", "Portable project");
    let project_root = fixture.project_root();
    let project = b"---\ntitle: Portable project\ntype: project\nproject_id: portable-project\n---\n\n# Detailed purpose\n\nKeep every custom paragraph.\n";
    let state = b"---\ntitle: Portable state\ntype: state\nproject_id: portable-project\n---\n\n# Current state\n\nA carefully maintained handoff.\n";
    std::fs::write(project_root.join("Project.md"), project).expect("write rich Project.md");
    std::fs::write(project_root.join("STATE.md"), state).expect("write rich STATE.md");
    std::fs::create_dir(project_root.join("Worklog")).expect("create existing Worklog");
    std::fs::write(
        project_root.join("Worklog/2026-08-10.md"),
        b"# Existing daily history\n\nDo not rewrite this.\n",
    )
    .expect("write existing daily history");

    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview repair");

    assert!(plan.operations.iter().all(|operation| !matches!(
        operation.relative_path.as_str(),
        "10-Projects/portable-project/Project.md"
            | "10-Projects/portable-project/STATE.md"
            | "10-Projects/portable-project/Worklog"
    )));
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .expect("repair missing roles");
    assert_eq!(
        std::fs::read(project_root.join("Project.md")).expect("read preserved Project.md"),
        project
    );
    assert_eq!(
        std::fs::read(project_root.join("STATE.md")).expect("read preserved STATE.md"),
        state
    );
    assert_eq!(
        std::fs::read(project_root.join("Worklog/2026-08-10.md")).expect("read preserved worklog"),
        b"# Existing daily history\n\nDo not rewrite this.\n"
    );
    assert!(!String::from_utf8_lossy(project).contains("kodmem-project"));
}

#[test]
fn project_scaffold_apply_rejects_a_stale_preview_before_writing() {
    let fixture = MappedProjectsVault::new("project-scaffold-stale", "Portable project");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect("preview scaffold");
    let project_root = fixture.project_root();
    std::fs::create_dir(project_root.join("Decisions")).expect("concurrent Obsidian change");

    let error = fixture
        .store
        .apply_project_scaffold(&fixture.workspace.id, &plan.fingerprint)
        .expect_err("reject stale plan");

    assert!(error
        .to_string()
        .contains("project knowledge changed after preview"));
    assert_eq!(
        std::fs::read_dir(&project_root)
            .expect("read unchanged project folder")
            .count(),
        1,
        "stale-plan rejection must happen before scaffold writes"
    );
}

#[test]
fn project_scaffold_rejects_file_and_folder_role_collisions() {
    let fixture = MappedProjectsVault::new("project-scaffold-collision", "Portable project");
    std::fs::write(fixture.project_root().join("Plans"), b"not a folder")
        .expect("create role collision");

    let error = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect_err("reject file where a role folder belongs");

    assert!(error
        .to_string()
        .contains("project knowledge folder collides with a file"));
}

#[cfg(unix)]
#[test]
fn project_scaffold_rejects_symlinked_role_paths_without_touching_the_target() {
    use std::os::unix::fs::symlink;

    let fixture = MappedProjectsVault::new("project-scaffold-role-symlink", "Portable project");
    let outside = TempProject::new("project-scaffold-outside");
    symlink(outside.root(), fixture.project_root().join("Decisions"))
        .expect("create escaping role symlink");

    let error = fixture
        .store
        .preview_project_scaffold(&fixture.workspace.id)
        .expect_err("reject role symlink");

    assert!(error.to_string().contains("cannot be a symlink"));
    assert!(
        std::fs::read_dir(outside.root())
            .expect("read untouched target")
            .next()
            .is_none(),
        "preview must never traverse or write through role symlinks"
    );
}

#[test]
fn projects_vault_registration_and_mapping_reject_unsafe_or_conflicting_inputs() {
    let app_data = TempProject::new("projects-vault-validation");
    let invalid_vault = TempProject::new("not-an-obsidian-vault");
    let vault = TempProject::new("validated-projects-vault");
    std::fs::create_dir(vault.root().join(".obsidian")).expect("create Obsidian config");
    std::fs::create_dir(vault.root().join("10-Projects")).expect("create projects folder");
    let checkout = app_data.root().join("checkout");
    std::fs::create_dir(&checkout).expect("create checkout");
    let store = MemoryStore::open(app_data.db()).expect("open store");

    let inaccessible = store
        .register_projects_vault(app_data.root().join("missing-vault"))
        .expect_err("reject an inaccessible vault root");
    assert!(inaccessible
        .to_string()
        .contains("projects vault is inaccessible"));

    let invalid = store
        .register_projects_vault(invalid_vault.root())
        .expect_err("reject a directory that is not an Obsidian projects vault");
    assert!(invalid.to_string().contains(".obsidian"));

    store
        .register_projects_vault(vault.root())
        .expect("register projects vault");
    let workspace = store
        .register_workspace(&checkout, "Checkout", None)
        .expect("register checkout");
    store
        .map_workspace_to_project(&workspace.id, None, "first-project", "First project")
        .expect("create initial mapping");
    let other_checkout = app_data.root().join("other-checkout");
    std::fs::create_dir(&other_checkout).expect("create another checkout");
    let other_workspace = store
        .register_workspace(&other_checkout, "Other checkout", None)
        .expect("register another checkout");
    let project_conflict = store
        .map_workspace_to_project(
            &other_workspace.id,
            None,
            "first-project",
            "Conflicting project name",
        )
        .expect_err("reject conflicting definitions for one shared project ID");
    assert!(project_conflict
        .to_string()
        .contains("already exists as First project"));
    let conflict = store
        .map_workspace_to_project(&workspace.id, None, "other-project", "Other project")
        .expect_err("reject a stale mapping edit");
    assert!(conflict
        .to_string()
        .contains("already mapped to first-project"));

    let updated = store
        .map_workspace_to_project(
            &workspace.id,
            Some("first-project"),
            "other-project",
            "Other project",
        )
        .expect("edit the mapping with its current project identity");
    assert_eq!(updated.project_id, "other-project");

    let invalid_id = store
        .map_workspace_to_project(
            &workspace.id,
            Some("other-project"),
            "Machine Project",
            "Machine project",
        )
        .expect_err("reject a path-like or unstable project identity");
    assert!(invalid_id.to_string().contains("lowercase letters"));
}

#[cfg(unix)]
#[test]
fn projects_vault_mapping_rejects_symlinked_project_folders() {
    let app_data = TempProject::new("projects-vault-symlink");
    let vault = TempProject::new("projects-vault-symlink-root");
    std::fs::create_dir(vault.root().join(".obsidian")).expect("create Obsidian config");
    std::fs::create_dir(vault.root().join("10-Projects")).expect("create projects folder");
    let outside = vault.root().join("outside-project");
    std::fs::create_dir(&outside).expect("create outside project");
    std::os::unix::fs::symlink(
        &outside,
        vault.root().join("10-Projects").join("unsafe-project"),
    )
    .expect("create project symlink");
    let checkout = app_data.root().join("checkout");
    std::fs::create_dir(&checkout).expect("create checkout");
    let store = MemoryStore::open(app_data.db()).expect("open store");
    store
        .register_projects_vault(vault.root())
        .expect("register projects vault");
    let workspace = store
        .register_workspace(&checkout, "Checkout", None)
        .expect("register checkout");

    let error = store
        .map_workspace_to_project(&workspace.id, None, "unsafe-project", "Unsafe project")
        .expect_err("reject symlinked project folder");

    assert!(error
        .to_string()
        .contains("project folder cannot be a symlink"));
}

#[test]
fn revisions_reject_stale_versions_without_losing_the_newer_write() {
    let project = TempProject::new("conflict");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Conflict project", None)
        .expect("register workspace");
    let created = store
        .remember(NewMemory {
            workspace_id: workspace.id,
            kind: MemoryKind::Task,
            title: "Ship KödMem".into(),
            body: "Build the core.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("remember task");
    let revised = store
        .revise(MemoryRevision {
            id: created.id.clone(),
            expected_version: 1,
            kind: MemoryKind::Task,
            title: "Ship KödMem core".into(),
            body: "Build and verify the shared Rust module.".into(),
            pinned: true,
            source_client: "kodade-ui".into(),
            session_id: None,
            links: Vec::new(),
        })
        .expect("revise current version");
    assert_eq!(revised.version, 2);

    let conflict = store
        .revise(MemoryRevision {
            id: created.id.clone(),
            expected_version: 1,
            kind: MemoryKind::Task,
            title: "Stale title".into(),
            body: "Stale body".into(),
            pinned: false,
            source_client: "kodade-mcp".into(),
            session_id: Some("agent-1".into()),
            links: Vec::new(),
        })
        .expect_err("stale revision must conflict");

    assert!(matches!(
        conflict,
        MemoryError::VersionConflict {
            expected: 1,
            actual: 2
        }
    ));
    let current = store.memory(&created.id).expect("read current version");
    assert_eq!(current.title, "Ship KödMem core");
    assert_eq!(current.version, 2);
    assert!(current.pinned);
}

#[test]
fn forgetting_soft_deletes_a_versioned_memory_and_removes_it_from_search() {
    let project = TempProject::new("forget");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Forget project", None)
        .expect("register workspace");
    let created = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Temporary fact".into(),
            body: "This should disappear from normal reads.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("remember fact");

    let tombstone = store
        .forget(&created.id, 1, "kodade-ui", None)
        .expect("soft delete current version");
    assert_eq!(tombstone.id, created.id);
    assert_eq!(tombstone.version, 2);
    assert!(tombstone.deleted_at > 0);

    let page = store
        .search(MemoryQuery {
            workspace_id: workspace.id,
            text: "Temporary fact".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("search after delete");
    assert_eq!(page.total, 0);
    assert!(page.items.is_empty());

    let deleted = store
        .memory(&created.id)
        .expect("inspect tombstoned record");
    assert_eq!(deleted.deleted_at, Some(tombstone.deleted_at));
    assert_eq!(deleted.version, 2);
}

#[test]
fn restoring_a_tombstone_within_thirty_days_reindexes_and_versions_the_memory() {
    let project = TempProject::new("restore");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Restore project", None)
        .expect("register workspace");
    let created = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Recoverable decision".into(),
            body: "Restore this within the undo window.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: true,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("remember decision");
    let tombstone = store
        .forget(&created.id, created.version, "kodade-ui", None)
        .expect("delete decision");

    let restored = store
        .restore(
            &created.id,
            tombstone.version,
            "kodade-ui",
            Some("undo-session"),
        )
        .expect("restore current tombstone");

    assert_eq!(restored.version, 3);
    assert_eq!(restored.deleted_at, None);
    assert_eq!(restored.session_id.as_deref(), Some("undo-session"));
    let page = store
        .search(MemoryQuery {
            workspace_id: workspace.id.clone(),
            text: "Recoverable decision".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("search restored memory");
    assert_eq!(page.items[0].id, created.id);
    assert_eq!(
        store
            .audit(&workspace.id, 20)
            .expect("inspect restore audit")
            .iter()
            .map(|entry| entry.action.as_str())
            .collect::<Vec<_>>(),
        vec!["restore", "forget", "remember"]
    );
}

#[test]
fn restoring_a_tombstone_after_configured_retention_is_rejected_without_a_new_version() {
    let project = TempProject::new("restore-expired");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Expired restore project", None)
        .expect("register workspace");
    store
        .set_retention(
            &workspace.id,
            RetentionSettings {
                capture_paused: false,
                activity_days: 30,
                audit_days: 30,
                tombstone_days: 7,
            },
            test_provenance(),
        )
        .expect("configure seven-day tombstone retention");
    let created = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Expired tombstone".into(),
            body: "This undo window has elapsed.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: None,
            links: Vec::new(),
        })
        .expect("remember fact");
    let tombstone = store
        .forget(&created.id, created.version, "kodade-ui", None)
        .expect("delete fact");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64;
    let expired_at = now - 8 * 24 * 60 * 60 * 1000_i64;
    let connection = rusqlite::Connection::open(project.db()).expect("age tombstone fixture");
    connection
        .execute(
            "UPDATE memories SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![expired_at, created.id],
        )
        .expect("age tombstone");
    drop(connection);

    let error = store
        .restore(&created.id, tombstone.version, "kodade-ui", None)
        .expect_err("expired tombstone cannot be restored");

    assert!(matches!(
        error,
        MemoryError::InvalidInput(message) if message.contains("within 7 days")
    ));
    let deleted = store
        .memory(&created.id)
        .expect("inspect expired tombstone");
    assert_eq!(deleted.version, tombstone.version);
    assert_eq!(deleted.deleted_at, Some(expired_at));
    assert_eq!(
        store
            .audit(&workspace.id, 20)
            .expect("audit failed restore")
            .len(),
        3
    );
}

#[test]
fn linked_memories_are_visible_from_both_directions() {
    let project = TempProject::new("links");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Link project", None)
        .expect("register workspace");
    let target = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Storage boundary".into(),
            body: "KödMem is local SQLite.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("target".into()),
            links: Vec::new(),
        })
        .expect("remember target");
    let source = store
        .remember(NewMemory {
            workspace_id: workspace.id,
            kind: MemoryKind::Decision,
            title: "Share one module".into(),
            body: "The app and MCP executable use the same store.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: true,
            idempotency_key: Some("source".into()),
            links: vec![MemoryLink {
                target_id: target.id.clone(),
                relation: "supports".into(),
            }],
        })
        .expect("remember linked source");

    let source_view = store.memory(&source.id).expect("read source");
    let target_view = store.memory(&target.id).expect("read target");

    assert_eq!(
        source_view.links,
        vec![MemoryLink {
            target_id: target.id,
            relation: "supports".into(),
        }]
    );
    assert_eq!(
        target_view.backlinks,
        vec![MemoryLink {
            target_id: source.id,
            relation: "supports".into(),
        }]
    );
}

#[test]
fn idempotent_linked_memory_retry_returns_the_original_record() {
    let project = TempProject::new("idempotent-links");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Idempotent link project", None)
        .expect("register workspace");
    let target = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Fact,
            title: "Target".into(),
            body: "Stable target.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: false,
            idempotency_key: Some("target".into()),
            links: Vec::new(),
        })
        .expect("remember target");
    let input = NewMemory {
        workspace_id: workspace.id.clone(),
        kind: MemoryKind::Decision,
        title: "Linked decision".into(),
        body: "Retry this exact write.".into(),
        source: MemorySource::Agent,
        source_client: "kodade-mcp".into(),
        session_id: Some("agent-1".into()),
        pinned: true,
        idempotency_key: Some("linked-retry".into()),
        links: vec![MemoryLink {
            target_id: target.id,
            relation: "supports".into(),
        }],
    };

    let created = store.remember(input.clone()).expect("first write");
    let retried = store.remember(input).expect("idempotent retry");

    assert_eq!(retried, created);
    assert_eq!(retried.links.len(), 1);
    assert_eq!(store.audit(&workspace.id, 20).unwrap().len(), 2);
}

impl TempProject {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kodade-memory-{name}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temporary project");
        Self { dir }
    }

    fn db(&self) -> PathBuf {
        self.dir.join("memory.sqlite3")
    }

    fn root(&self) -> &Path {
        &self.dir
    }
}

fn test_provenance() -> MutationProvenance {
    MutationProvenance {
        source_client: "kodade-ui".into(),
        session_id: None,
    }
}

fn spawn_memory_store_child(
    mode: &str,
    project: &TempProject,
    workspace_id: &str,
    start: Option<&Path>,
    ready: Option<&Path>,
    result: Option<&Path>,
) -> Child {
    let mut command = Command::new(std::env::current_exe().expect("memory_store test executable"));
    command
        .arg("--exact")
        .arg("corruption_recovery_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_MEMORY_TEST_CHILD", mode)
        .env("KODADE_MEMORY_TEST_DB", project.db())
        .env("KODADE_MEMORY_TEST_ROOT", project.root())
        .env("KODADE_MEMORY_TEST_WORKSPACE", workspace_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(path) = start {
        command.env("KODADE_MEMORY_TEST_START", path);
    }
    if let Some(path) = ready {
        command.env("KODADE_MEMORY_TEST_READY", path);
    }
    if let Some(path) = result {
        command.env("KODADE_MEMORY_TEST_RESULT", path);
    }
    command.spawn().expect("spawn memory_store test child")
}

fn run_portable_checkpoint_child(
    db: PathBuf,
    workspace_id: &str,
    state_hash: &str,
    key: &str,
    summary: &str,
    failpoint: Option<&str>,
) {
    let status = portable_checkpoint_command(db, workspace_id, state_hash, key, summary, failpoint)
        .status()
        .expect("run portable checkpoint child");
    assert!(
        status.success(),
        "portable checkpoint child exited with {status}"
    );
}

fn portable_checkpoint_command(
    db: PathBuf,
    workspace_id: &str,
    state_hash: &str,
    key: &str,
    summary: &str,
    failpoint: Option<&str>,
) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("memory_store test executable"));
    command
        .arg("--exact")
        .arg("portable_checkpoint_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_PORTABLE_CHILD_DB", db)
        .env("KODADE_PORTABLE_CHILD_WORKSPACE", workspace_id)
        .env("KODADE_PORTABLE_CHILD_STATE_HASH", state_hash)
        .env("KODADE_PORTABLE_CHILD_KEY", key)
        .env("KODADE_PORTABLE_CHILD_SUMMARY", summary)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(failpoint) = failpoint {
        command.env("KODADE_PORTABLE_CHILD_FAILPOINT", failpoint);
    }
    command
}

fn portable_revise_command(
    db: PathBuf,
    id: &str,
    version: u64,
    content_hash: &str,
    failpoint: &str,
) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("memory_store test executable"));
    command
        .arg("--exact")
        .arg("portable_revise_child_process_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("KODADE_PORTABLE_REVISE_DB", db)
        .env("KODADE_PORTABLE_REVISE_ID", id)
        .env("KODADE_PORTABLE_REVISE_VERSION", version.to_string())
        .env("KODADE_PORTABLE_REVISE_HASH", content_hash)
        .env("KODADE_PORTABLE_REVISE_FAILPOINT", failpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    command
}

fn wait_for_child(mut child: Child, label: &str, timeout: Duration) {
    let mut status = None;
    if !poll_until(timeout, || {
        status = child.try_wait().expect("poll test child");
        status.is_some()
    }) {
        let _ = child.kill();
        let _ = child.wait();
        panic!("{label} did not finish within {timeout:?}");
    }
    let status = status.expect("completed child status");
    assert!(status.success(), "{label} exited with {status}");
}

fn wait_for_child_files(children: &mut [Child], paths: &[PathBuf], timeout: Duration) {
    let mut early_exit = None;
    let ready = poll_until(timeout, || {
        for child in children.iter_mut() {
            if let Some(status) = child.try_wait().expect("poll ready child") {
                early_exit = Some(status);
                return true;
            }
        }
        paths.iter().all(|path| path.exists())
    });
    if !ready || early_exit.is_some() {
        for child in children.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(status) = early_exit {
            panic!("recovery child exited before signaling ready: {status}");
        }
        panic!("recovery children did not become ready within {timeout:?}");
    }
}

fn wait_for_file(path: &Path, timeout: Duration) {
    assert!(
        poll_until(timeout, || path.exists()),
        "test synchronization file did not appear within {timeout:?}: {}",
        path.display(),
    );
}

fn poll_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn table_page_location(path: &Path, table: &str) -> (u64, u64) {
    let connection = rusqlite::Connection::open(path).expect("open page location fixture");
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint fixture before locating page");
    let page_size = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .expect("read fixture page size");
    let root_page = connection
        .query_row(
            "SELECT rootpage FROM sqlite_schema WHERE name = ?1",
            [table],
            |row| row.get(0),
        )
        .expect("find table root page");
    assert!(root_page > 1, "fixture must preserve the schema page");
    (page_size, root_page)
}

fn corrupt_page(path: &Path, page_size: u64, root_page: u64) {
    let mut database = OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open fixture bytes");
    database
        .seek(SeekFrom::Start((root_page - 1) * page_size))
        .expect("seek to table root page");
    database
        .write_all(&vec![0xff; page_size as usize])
        .expect("corrupt table root page");
    database.sync_all().expect("persist fixture corruption");
}

fn assert_sidecar_preserved_or_cleaned(original: &Path, backup: &Path, label: &str) {
    let preserved = backup.exists() && !original.exists();
    let cleaned = !backup.exists() && !original.exists();
    assert!(
        preserved || cleaned,
        "live {label} sidecar must be moved with the backup or deliberately cleaned",
    );
    if preserved {
        assert!(
            std::fs::metadata(backup)
                .expect("preserved sidecar metadata")
                .len()
                > 0,
            "preserved {label} sidecar must not be empty",
        );
    }
}

fn corrupt_table_root_page(path: &Path, table: &str) {
    let (page_size, root_page) = table_page_location(path, table);
    corrupt_page(path, page_size, root_page);
}

fn install_historical_fixture(project: &TempProject, fixture: &str) {
    let root = project.root().to_string_lossy().replace('\'', "''");
    let sql = fixture.replace("__WORKSPACE_ROOT__", &root);
    let connection = rusqlite::Connection::open(project.db()).expect("open historical fixture");
    connection
        .execute_batch(&sql)
        .expect("install independent historical SQL fixture");
}

fn schema_versions(path: PathBuf) -> Vec<u32> {
    let connection = rusqlite::Connection::open(path).expect("inspect schema versions");
    let versions = connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .expect("prepare schema versions")
        .query_map([], |row| row.get(0))
        .expect("query schema versions")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect schema versions");
    versions
}

fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return files;
    };
    for entry in entries {
        let entry = entry.expect("read directory entry");
        if entry.file_type().expect("read entry type").is_dir() {
            files.extend(walk_files(&entry.path()));
        } else {
            files.push(entry.path());
        }
    }
    files.sort();
    files
}

fn tree_hashes(root: &Path) -> Vec<(String, String)> {
    walk_files(root)
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            (relative, file_hash(&path))
        })
        .collect()
}

fn tree_text(root: &Path) -> String {
    walk_files(root)
        .into_iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .collect::<Vec<_>>()
        .join("\n")
}

fn file_hash(path: &Path) -> String {
    format!(
        "{:x}",
        Sha256::digest(std::fs::read(path).expect("read hash input"))
    )
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn memory_survives_store_reopen() {
    let project = TempProject::new("reopen");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Reopen project", None)
        .expect("register workspace");
    let created = store
        .remember(NewMemory {
            workspace_id: workspace.id.clone(),
            kind: MemoryKind::Decision,
            title: "Keep storage local".into(),
            body: "SQLite is the durable shared boundary.".into(),
            source: MemorySource::User,
            source_client: "kodade-ui".into(),
            session_id: None,
            pinned: true,
            idempotency_key: Some("reopen-decision".into()),
            links: Vec::new(),
        })
        .expect("remember decision");
    drop(store);

    let reopened = MemoryStore::open(project.db()).expect("reopen store");
    let persisted = reopened.memory(&created.id).expect("read persisted memory");

    assert_eq!(persisted.workspace_id, workspace.id);
    assert_eq!(persisted.kind, MemoryKind::Decision);
    assert_eq!(persisted.title, "Keep storage local");
    assert_eq!(persisted.body, "SQLite is the durable shared boundary.");
    assert!(persisted.pinned);
    assert_eq!(persisted.version, 1);
}

#[test]
fn full_text_search_returns_matching_markdown_with_an_excerpt() {
    let project = TempProject::new("search");
    let store = MemoryStore::open(project.db()).expect("open store");
    let workspace = store
        .register_workspace(project.root(), "Search project", None)
        .expect("register workspace");
    for (title, body, key) in [
        (
            "SQLite boundary",
            "Use WAL mode so the desktop app and local MCP writers can coexist.",
            "sqlite",
        ),
        (
            "Interface color",
            "Keep the project chrome quiet and monochrome.",
            "color",
        ),
    ] {
        store
            .remember(NewMemory {
                workspace_id: workspace.id.clone(),
                kind: MemoryKind::Fact,
                title: title.into(),
                body: body.into(),
                source: MemorySource::User,
                source_client: "kodade-ui".into(),
                session_id: None,
                pinned: false,
                idempotency_key: Some(key.into()),
                links: Vec::new(),
            })
            .expect("remember searchable fact");
    }

    let page = store
        .search(MemoryQuery {
            workspace_id: workspace.id,
            text: "MCP writers".into(),
            kinds: Vec::new(),
            sources: Vec::new(),
            updated_after: None,
            limit: 20,
            offset: 0,
        })
        .expect("search memories");

    assert_eq!(page.total, 1);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].title, "SQLite boundary");
    assert!(page.items[0].excerpt.contains("MCP"));
    assert!(!page.items[0].excerpt.contains("project chrome"));
}
