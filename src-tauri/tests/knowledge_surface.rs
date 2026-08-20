//! KödMem knowledge-surface model tests.
//!
//! The vault fixtures in `tests/fixtures/knowledge/` were recorded from the
//! pre-change tree (schema version 12) by `knowledge_surface_capture.rs`. The
//! invariant tests below replay that real persisted shape and assert the
//! resolved paths, vault writes, and stored config are unchanged.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use kodade_lib::memory::{
    KnowledgeSurfaceMode, MemorySource, MemoryStore, NewCheckpoint, ScaffoldOperationKind,
};
use tempfile::TempDir;

const FIXTURE_SQL: &str = include_str!("fixtures/knowledge/vault-mapped-v12.sql");
const FIXTURE_LAYOUT: &str = include_str!("fixtures/knowledge/vault-project-layout.json");
const FIXTURE_WORKSPACE_ID: &str = "ws_0f4d2c1a9b8e7f6a5d4c3b2a19087766";
const FIXTURE_PROJECT_ID: &str = "fixture-project";
const FIXTURE_PROJECT_NAME: &str = "Fixture project";
// Recorded verbatim from the fixture dump.
const FIXTURE_MAPPING_CREATED_AT: i64 = 1787198735728;

struct VaultFixture {
    _temp: TempDir,
    vault: PathBuf,
    workspace_root: PathBuf,
    db: PathBuf,
    store: MemoryStore,
}

impl VaultFixture {
    /// Materialize the recorded vault-mapped setup: the on-disk project folder
    /// plus the schema-12 SQLite database, both exactly as recorded.
    fn load() -> Self {
        let temp = tempfile::tempdir().expect("temp");
        let vault = temp.path().join("vault");
        fs::create_dir_all(vault.join(".obsidian")).expect("obsidian");
        fs::create_dir(vault.join("10-Projects")).expect("lane");
        let vault = fs::canonicalize(&vault).expect("canonical vault");
        let workspace_root = temp.path().join("checkout");
        fs::create_dir(&workspace_root).expect("checkout");
        let workspace_root = fs::canonicalize(&workspace_root).expect("canonical checkout");

        let project_root = vault.join("10-Projects").join(FIXTURE_PROJECT_ID);
        fs::create_dir(&project_root).expect("project root");
        let layout: serde_json::Value = serde_json::from_str(FIXTURE_LAYOUT).expect("layout json");
        for entry in layout["entries"].as_array().expect("entries") {
            let relative = entry["relativePath"].as_str().expect("relative");
            let target = project_root.join(relative);
            if entry["kind"] == "dir" {
                fs::create_dir_all(&target).expect("fixture dir");
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).expect("fixture parent");
                }
                fs::write(&target, entry["content"].as_str().expect("content"))
                    .expect("fixture file");
            }
        }

        let db = temp.path().join("memory.sqlite3");
        let sql = FIXTURE_SQL
            .replace("__VAULT_ROOT__", vault.to_str().expect("utf8"))
            .replace("__WORKSPACE_ROOT__", workspace_root.to_str().expect("utf8"))
            .replace("__WORKSPACE_ID__", FIXTURE_WORKSPACE_ID);
        let connection = rusqlite::Connection::open(&db).expect("open fixture db");
        connection.execute_batch(&sql).expect("load fixture dump");
        drop(connection);

        // Opening the store runs every pending migration, including the new one.
        let store = MemoryStore::open(&db).expect("open store");
        Self {
            _temp: temp,
            vault,
            workspace_root,
            db,
            store,
        }
    }

    fn project_root(&self) -> PathBuf {
        self.vault.join("10-Projects").join(FIXTURE_PROJECT_ID)
    }
}

fn relative_tree(root: &Path) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    fn walk(root: &Path, current: &Path, out: &mut BTreeSet<String>) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            out.insert(
                path.strip_prefix(root)
                    .expect("relative")
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
            if path.is_dir() {
                walk(root, &path, out);
            }
        }
    }
    walk(root, root, &mut out);
    out
}

#[test]
fn legacy_vault_mapping_resolves_to_the_recorded_paths() {
    let fixture = VaultFixture::load();

    let mapping = fixture
        .store
        .workspace_project_mapping(FIXTURE_WORKSPACE_ID)
        .expect("mapping query")
        .expect("mapping present");
    assert_eq!(mapping.workspace_id, FIXTURE_WORKSPACE_ID);
    assert_eq!(mapping.project_id, FIXTURE_PROJECT_ID);
    assert_eq!(mapping.project_display_name, FIXTURE_PROJECT_NAME);
    assert_eq!(
        mapping.workspace_root,
        fixture.workspace_root.to_string_lossy()
    );
    assert_eq!(mapping.created_at, FIXTURE_MAPPING_CREATED_AT);
    assert_eq!(mapping.updated_at, FIXTURE_MAPPING_CREATED_AT);

    // A mapping with no stored mode resolves to the vault surface, rooted at
    // the exact pre-change path.
    let surface = fixture
        .store
        .workspace_knowledge_surface(FIXTURE_WORKSPACE_ID)
        .expect("surface query")
        .expect("surface present");
    assert_eq!(surface.mode, KnowledgeSurfaceMode::Vault);
    assert_eq!(surface.project_id, FIXTURE_PROJECT_ID);
    assert_eq!(
        surface.knowledge_root,
        fixture.project_root().to_string_lossy()
    );

    // The vault still lists exactly the recorded logical project.
    let vault = fixture
        .store
        .projects_vault()
        .expect("vault query")
        .expect("vault present");
    assert_eq!(vault.canonical_root, fixture.vault.to_string_lossy());
    assert_eq!(
        vault
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        vec![FIXTURE_PROJECT_ID]
    );

    // Scaffolding a fully materialized project is still a no-op against the
    // vault root.
    let plan = fixture
        .store
        .preview_project_scaffold(FIXTURE_WORKSPACE_ID)
        .expect("preview");
    assert_eq!(plan.mode, KnowledgeSurfaceMode::Vault);
    assert_eq!(plan.vault_root, fixture.vault.to_string_lossy());
    assert_eq!(plan.project_id, FIXTURE_PROJECT_ID);
    assert!(
        plan.operations.is_empty(),
        "recorded vault project should already be complete: {:?}",
        plan.operations
    );
}

#[test]
fn legacy_vault_mapping_reads_the_recorded_knowledge_sources() {
    let fixture = VaultFixture::load();
    let context = fixture
        .store
        .context(FIXTURE_WORKSPACE_ID)
        .expect("workspace context");
    let knowledge = context
        .project_knowledge
        .expect("project knowledge context");
    assert_eq!(knowledge.project_id, FIXTURE_PROJECT_ID);
    assert_eq!(knowledge.origin, fixture.project_root().to_string_lossy());
    assert!(knowledge.sync.error.is_none(), "{:?}", knowledge.sync);

    let sources = knowledge
        .sources
        .iter()
        .map(|source| source.relative_path.clone())
        .collect::<BTreeSet<_>>();
    assert!(
        sources.contains("Project.md"),
        "expected the recorded Project.md source, got {sources:?}"
    );
    for relative in &sources {
        assert!(
            fixture.project_root().join(relative).exists(),
            "knowledge source {relative} must resolve inside the recorded vault project"
        );
    }
}

#[test]
fn migrating_a_legacy_config_writes_no_knowledge_config_and_moves_no_data() {
    let fixture = VaultFixture::load();
    let before = relative_tree(&fixture.project_root());
    let workspace_before = relative_tree(&fixture.workspace_root);

    let connection = rusqlite::Connection::open(&fixture.db).expect("inspect db");
    let schema_version: u32 = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .expect("schema version");
    assert_eq!(schema_version, 13, "the new migration must be applied");

    // Additive only: the legacy mapping is never rewritten into the new table.
    let config_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspace_knowledge_config",
            [],
            |row| row.get(0),
        )
        .expect("config rows");
    assert_eq!(config_rows, 0);
    let kind: String = connection
        .query_row(
            "SELECT kind FROM logical_projects WHERE id = ?1",
            [FIXTURE_PROJECT_ID],
            |row| row.get(0),
        )
        .expect("project kind");
    assert_eq!(kind, "vault");
    drop(connection);

    // Nothing moved on disk, and the workspace gained no knowledge directory.
    assert_eq!(relative_tree(&fixture.project_root()), before);
    assert_eq!(relative_tree(&fixture.workspace_root), workspace_before);
    assert!(!fixture.workspace_root.join(".kodade").exists());

    // Zero data movement means byte equality, not just matching path sets:
    // every recorded file still holds its recorded content.
    let layout: serde_json::Value = serde_json::from_str(FIXTURE_LAYOUT).expect("layout json");
    let mut compared = 0;
    for entry in layout["entries"].as_array().expect("entries") {
        let relative = entry["relativePath"].as_str().expect("relative");
        let target = fixture.project_root().join(relative);
        if entry["kind"] == "dir" {
            assert!(target.is_dir(), "{relative} must still be a directory");
            continue;
        }
        assert_eq!(
            fs::read_to_string(&target).expect("read recorded file"),
            entry["content"].as_str().expect("content"),
            "{relative} changed while opening the legacy database"
        );
        compared += 1;
    }
    assert!(
        compared >= 9,
        "expected the recorded files, compared {compared}"
    );
}

#[test]
fn legacy_vault_mapping_still_writes_checkpoints_into_the_vault() {
    let fixture = VaultFixture::load();
    let workspace_before = relative_tree(&fixture.workspace_root);
    let before = relative_tree(&fixture.project_root());

    fixture
        .store
        .checkpoint_with_authority(
            NewCheckpoint {
                workspace_id: FIXTURE_WORKSPACE_ID.into(),
                session_id: None,
                summary: "Invariant checkpoint".into(),
                decisions: vec!["Invariant decision".into()],
                next_actions: vec!["Invariant next action".into()],
                changed_paths: vec!["src/lib.rs".into()],
                source: MemorySource::Kodade,
                source_client: "kodade-ui".into(),
                idempotency_key: None,
            },
            false,
            None,
        )
        .expect("checkpoint");

    let after = relative_tree(&fixture.project_root());
    assert!(
        after.len() > before.len(),
        "the checkpoint must land in the vault project"
    );
    assert_eq!(
        relative_tree(&fixture.workspace_root),
        workspace_before,
        "a vault-mapped workspace must never gain workspace-local knowledge files"
    );
}

#[test]
fn a_local_project_id_can_never_become_a_vault_mapping_target() {
    let fixture = VaultFixture::load();
    let local_root = fixture._temp.path().join("local-checkout");
    fs::create_dir(&local_root).expect("local checkout");
    let local_root = fs::canonicalize(&local_root).expect("canonical local checkout");
    let local_workspace = fixture
        .store
        .register_workspace(&local_root, "Local surface", None)
        .expect("local workspace");
    let surface = fixture
        .store
        .enable_local_knowledge(&local_workspace.id)
        .expect("enable local");

    // The local project stays out of the vault picker...
    let vault = fixture
        .store
        .projects_vault()
        .expect("vault query")
        .expect("vault present");
    assert!(!vault
        .projects
        .iter()
        .any(|project| project.id == surface.project_id));

    // ...and cannot be claimed by a vault mapping.
    let error = fixture
        .store
        .map_workspace_to_project(
            FIXTURE_WORKSPACE_ID,
            Some(FIXTURE_PROJECT_ID),
            &surface.project_id,
            "Local surface",
        )
        .expect_err("a local project is not a mapping target");
    assert!(
        error.to_string().contains("local knowledge project"),
        "unexpected error: {error}"
    );
}

// -- local knowledge surface -------------------------------------------------

struct LocalFixture {
    _temp: TempDir,
    workspace_root: PathBuf,
    store: MemoryStore,
    workspace_id: String,
}

impl LocalFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("temp");
        let workspace_root = temp.path().join("checkout");
        fs::create_dir(&workspace_root).expect("checkout");
        let workspace_root = fs::canonicalize(&workspace_root).expect("canonical checkout");
        let store = MemoryStore::open(temp.path().join("memory.sqlite3")).expect("open store");
        let workspace = store
            .register_workspace(&workspace_root, "Local surface", None)
            .expect("workspace");
        Self {
            _temp: temp,
            workspace_root,
            store,
            workspace_id: workspace.id,
        }
    }

    fn knowledge_root(&self) -> PathBuf {
        self.workspace_root.join(".kodade").join("knowledge")
    }
}

#[test]
fn a_workspace_without_a_mapping_or_a_mode_has_no_knowledge_surface() {
    let fixture = LocalFixture::new();
    assert!(fixture
        .store
        .workspace_knowledge_surface(&fixture.workspace_id)
        .expect("surface query")
        .is_none());
    assert!(fixture
        .store
        .preview_project_scaffold(&fixture.workspace_id)
        .is_err());
    assert!(!fixture.workspace_root.join(".kodade").exists());
}

#[test]
fn local_mode_resolves_the_knowledge_root_inside_the_workspace() {
    let fixture = LocalFixture::new();
    let surface = fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("enable local");
    assert_eq!(surface.mode, KnowledgeSurfaceMode::Local);
    assert_eq!(surface.project_id, "local-surface");
    assert_eq!(surface.project_display_name, "Local surface");
    assert_eq!(
        surface.knowledge_root,
        fixture.knowledge_root().to_string_lossy()
    );

    // Enabling twice is idempotent and never creates a second project.
    let again = fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("enable local twice");
    assert_eq!(again, surface);

    // Local projects stay out of the vault picker.
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace_id)
        .expect("preview local");
    assert_eq!(plan.mode, KnowledgeSurfaceMode::Local);
    assert_eq!(plan.vault_root, fixture.workspace_root.to_string_lossy());
    let planned = plan
        .operations
        .iter()
        .map(|operation| operation.relative_path.clone())
        .collect::<Vec<_>>();
    assert_eq!(planned[0], ".kodade");
    assert_eq!(planned[1], ".kodade/knowledge");
    assert_eq!(planned[2], ".kodade/knowledge/.gitignore");
    assert!(planned.contains(&".kodade/knowledge/Project.md".to_string()));
    assert!(planned.contains(&".kodade/knowledge/STATE.md".to_string()));
    assert!(planned.contains(&".kodade/knowledge/Worklog".to_string()));
}

#[test]
fn local_mode_refuses_to_share_a_workspace_with_repo_local_working_memory() {
    let fixture = LocalFixture::new();
    fixture
        .store
        .activate_working_memory(
            &fixture.workspace_id,
            kodade_lib::memory::WorkingMemoryMode::Local,
            false,
        )
        .expect("activate working memory");
    let error = fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect_err("one knowledge surface per workspace");
    assert!(
        error.to_string().contains("repo-local working memory"),
        "unexpected error: {error}"
    );
    assert!(fixture
        .store
        .workspace_knowledge_surface(&fixture.workspace_id)
        .expect("surface query")
        .is_none());
}

#[test]
fn local_scaffold_is_idempotent_and_self_ignoring() {
    let fixture = LocalFixture::new();
    fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("enable local");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace_id)
        .expect("preview local");
    let applied = fixture
        .store
        .apply_project_scaffold(&fixture.workspace_id, &plan.fingerprint)
        .expect("apply local");
    assert_eq!(applied.created.len(), plan.operations.len());
    assert!(applied
        .created
        .iter()
        .any(
            |operation| operation.relative_path == ".kodade/knowledge/.gitignore"
                && operation.kind == ScaffoldOperationKind::CreateFile
        ));

    // The knowledge directory ignores itself; the user's own .gitignore is
    // never touched.
    assert_eq!(
        fs::read_to_string(fixture.knowledge_root().join(".gitignore")).expect("gitignore"),
        "*\n"
    );
    assert!(!fixture.workspace_root.join(".gitignore").exists());
    assert!(fixture.knowledge_root().join("Project.md").is_file());

    // Re-previewing after a complete scaffold plans nothing.
    let tree = relative_tree(&fixture.knowledge_root());
    let repeat = fixture
        .store
        .preview_project_scaffold(&fixture.workspace_id)
        .expect("re-preview local");
    assert!(
        repeat.operations.is_empty(),
        "local scaffold must be idempotent: {:?}",
        repeat.operations
    );
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace_id, &repeat.fingerprint)
        .expect("re-apply local");
    assert_eq!(relative_tree(&fixture.knowledge_root()), tree);
}

#[test]
fn local_mode_writes_checkpoints_into_the_workspace_knowledge_root() {
    let fixture = LocalFixture::new();
    fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("enable local");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace_id)
        .expect("preview local");
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace_id, &plan.fingerprint)
        .expect("apply local");

    fixture
        .store
        .checkpoint_with_authority(
            NewCheckpoint {
                workspace_id: fixture.workspace_id.clone(),
                session_id: None,
                summary: "Local checkpoint".into(),
                decisions: vec!["Local decision".into()],
                next_actions: vec!["Local next action".into()],
                changed_paths: vec!["src/lib.rs".into()],
                source: MemorySource::Kodade,
                source_client: "kodade-ui".into(),
                idempotency_key: None,
            },
            false,
            None,
        )
        .expect("local checkpoint");

    let tree = relative_tree(&fixture.knowledge_root());
    assert!(
        tree.iter().any(|path| path.starts_with("Worklog/")),
        "the local surface must own the same writer paths: {tree:?}"
    );
    // Nothing escaped the knowledge root.
    let workspace_tree = relative_tree(&fixture.workspace_root);
    for path in &workspace_tree {
        assert!(
            path == ".kodade" || path.starts_with(".kodade/"),
            "local knowledge must stay under .kodade: {path}"
        );
    }
}

#[test]
fn local_knowledge_round_trips_through_disable_and_re_enable() {
    let fixture = LocalFixture::new();
    let first = fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("enable local");

    fixture
        .store
        .disable_local_knowledge(&fixture.workspace_id)
        .expect("disable local");
    assert!(fixture
        .store
        .workspace_knowledge_surface(&fixture.workspace_id)
        .expect("surface query")
        .is_none());

    // Disabling twice is a no-op, not an error.
    fixture
        .store
        .disable_local_knowledge(&fixture.workspace_id)
        .expect("disable local twice");

    // Nothing referenced the local project, so re-enabling reclaims its ID.
    let second = fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("re-enable local");
    assert_eq!(second.project_id, first.project_id);
    assert_eq!(second.knowledge_root, first.knowledge_root);
}

#[test]
fn disabling_local_knowledge_is_refused_for_a_vault_mapping() {
    let fixture = VaultFixture::load();
    let error = fixture
        .store
        .disable_local_knowledge(FIXTURE_WORKSPACE_ID)
        .expect_err("a vault mapping is not disable-able");
    assert!(
        error.to_string().contains("projects vault"),
        "unexpected error: {error}"
    );
    // The mapping survives the refusal untouched.
    assert!(fixture
        .store
        .workspace_project_mapping(FIXTURE_WORKSPACE_ID)
        .expect("mapping query")
        .is_some());
}

#[test]
fn an_enabled_local_surface_blocks_repo_local_working_memory_before_scaffolding() {
    let fixture = LocalFixture::new();
    fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("enable local");
    // No scaffold yet, so there is no Project.md authority marker; the guard
    // must still refuse on the stored config alone.
    assert!(!fixture.knowledge_root().exists());
    let error = fixture
        .store
        .activate_working_memory(
            &fixture.workspace_id,
            kodade_lib::memory::WorkingMemoryMode::Local,
            false,
        )
        .expect_err("one knowledge surface per workspace");
    assert!(
        error.to_string().contains("knowledge surface"),
        "unexpected error: {error}"
    );
    assert!(!fixture.workspace_root.join(".kodade").exists());
}

#[test]
fn an_enabled_but_unscaffolded_local_surface_reports_a_sync_error() {
    let fixture = LocalFixture::new();
    fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("enable local");
    let context = fixture
        .store
        .context(&fixture.workspace_id)
        .expect("workspace context");
    let knowledge = context
        .project_knowledge
        .expect("project knowledge context");
    // 4b owns the UX for this state; the model just has to surface it rather
    // than fail the whole context load.
    let error = knowledge.sync.error.expect("unscaffolded sync error");
    assert!(
        error.contains("inaccessible"),
        "unexpected sync error: {error}"
    );
    assert!(knowledge.sources.is_empty());
}

#[test]
fn a_local_surface_has_no_obsidian_link() {
    let fixture = LocalFixture::new();
    fixture
        .store
        .enable_local_knowledge(&fixture.workspace_id)
        .expect("enable local");
    let plan = fixture
        .store
        .preview_project_scaffold(&fixture.workspace_id)
        .expect("preview local");
    fixture
        .store
        .apply_project_scaffold(&fixture.workspace_id, &plan.fingerprint)
        .expect("apply local");

    let error = fixture
        .store
        .project_obsidian_uri(&fixture.workspace_id)
        .expect_err("local knowledge is not an Obsidian vault");
    assert!(
        error.to_string().contains("not in an Obsidian vault"),
        "unexpected error: {error}"
    );
}

#[test]
fn local_project_ids_fold_accents_the_way_the_vault_setup_form_does() {
    // Matches projectIdFromName in ProjectsVaultSetup.tsx, verified against the
    // TypeScript implementation for each of these inputs.
    for (display_name, expected) in [
        ("Ködade", "kodade"),
        ("Café", "cafe"),
        ("Köd 🚀 Chat", "kod-chat"),
        ("日本語", "project"),
        ("🚀", "project"),
        ("  --Ö--  ", "o"),
        ("ﬁle Ⅳ", "file-iv"),
    ] {
        let temp = tempfile::tempdir().expect("temp");
        let workspace_root = temp.path().join("checkout");
        fs::create_dir(&workspace_root).expect("checkout");
        let store = MemoryStore::open(temp.path().join("memory.sqlite3")).expect("open store");
        let workspace = store
            .register_workspace(&workspace_root, display_name, None)
            .expect("workspace");
        let surface = store
            .enable_local_knowledge(&workspace.id)
            .expect("enable local");
        assert_eq!(
            surface.project_id, expected,
            "unexpected slug for {display_name}"
        );
    }
}
