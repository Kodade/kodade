use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kodade_lib::memory::{
    ActivityKind, AuditQuery, CheckpointQuery, DeletedMemoryQuery, MemoryError, MemoryKind,
    MemoryLink, MemoryQuery, MemoryRevision, MemorySource, MemoryStore, MutationProvenance,
    NewActivity, NewCheckpoint, NewMemory, ProjectKnowledgeSyncStatus, RetentionSettings,
    WorkingMemoryMode,
};
use sha2::{Digest, Sha256};

struct TempProject {
    dir: PathBuf,
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
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
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
    assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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
                vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
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
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
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
    let knowledge = context
        .project_knowledge
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
