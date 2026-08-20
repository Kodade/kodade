//! Fixture generator for the KödMem knowledge-surface invariant tests.
//!
//! This is a recording tool, not an assertion. It builds a real vault-mapped
//! KödMem setup with the production code paths and writes the resulting SQLite
//! dump, scaffold plan, and on-disk layout into `tests/fixtures/knowledge/`.
//! The committed fixtures were recorded from the pre-change tree (commit
//! 436cda0, schema version 12) and must not be regenerated casually: the
//! invariant tests exist precisely to prove that today's code still reproduces
//! that recording byte for byte.
//!
//! Run with: `cargo test --test knowledge_surface_capture -- --ignored`

use std::fs;
use std::path::{Path, PathBuf};

use kodade_lib::memory::{MemorySource, MemoryStore, NewCheckpoint};

const PROJECT_ID: &str = "fixture-project";
const PROJECT_NAME: &str = "Fixture project";

#[test]
#[ignore = "fixture recorder; run explicitly to regenerate tests/fixtures/knowledge"]
fn record_vault_fixture() {
    let temp = tempfile::tempdir().expect("temp");
    let vault = temp.path().join("vault");
    fs::create_dir_all(vault.join(".obsidian")).expect("obsidian");
    fs::create_dir(vault.join("10-Projects")).expect("lane");
    let vault = fs::canonicalize(&vault).expect("canonical vault");
    let checkout = temp.path().join("checkout");
    fs::create_dir(&checkout).expect("checkout");
    let checkout = fs::canonicalize(&checkout).expect("canonical checkout");
    let db = temp.path().join("memory.sqlite3");

    let store = MemoryStore::open(&db).expect("open store");
    store.register_projects_vault(&vault).expect("vault");
    let workspace = store
        .register_workspace(&checkout, PROJECT_NAME, None)
        .expect("workspace");
    store
        .map_workspace_to_project(&workspace.id, None, PROJECT_ID, PROJECT_NAME)
        .expect("mapping");
    let plan = store
        .preview_project_scaffold(&workspace.id)
        .expect("preview");
    store
        .apply_project_scaffold(&workspace.id, &plan.fingerprint)
        .expect("apply");
    store
        .checkpoint_with_authority(
            NewCheckpoint {
                workspace_id: workspace.id.clone(),
                session_id: None,
                summary: "Recorded fixture checkpoint".into(),
                decisions: vec!["Recorded fixture decision".into()],
                next_actions: vec!["Recorded fixture next action".into()],
                changed_paths: vec!["src/lib.rs".into()],
                source: MemorySource::Kodade,
                source_client: "kodade-ui".into(),
                idempotency_key: None,
            },
            false,
            None,
        )
        .expect("checkpoint");
    drop(store);

    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("knowledge");
    fs::create_dir_all(&fixtures).expect("fixture dir");

    // SQLite dump with absolute roots replaced by substitution tokens.
    let dump = sqlite_dump(&db)
        .replace(vault.to_str().expect("utf8"), "__VAULT_ROOT__")
        .replace(checkout.to_str().expect("utf8"), "__WORKSPACE_ROOT__")
        .replace(&workspace.id, "__WORKSPACE_ID__");
    fs::write(fixtures.join("vault-mapped-v12.sql"), dump).expect("write dump");

    // The complete on-disk project folder, path plus bytes.
    let project_root = vault.join("10-Projects").join(PROJECT_ID);
    let mut entries = Vec::new();
    walk(&project_root, &project_root, &mut entries);
    entries.sort();
    let layout = entries
        .into_iter()
        .map(|relative| {
            let path = project_root.join(&relative);
            let kind = if path.is_dir() { "dir" } else { "file" };
            let body = if path.is_dir() {
                String::new()
            } else {
                fs::read_to_string(&path).unwrap_or_default()
            };
            serde_json::json!({
                "relativePath": relative,
                "kind": kind,
                "content": body,
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        fixtures.join("vault-project-layout.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "projectId": PROJECT_ID,
            "projectDisplayName": PROJECT_NAME,
            "entries": layout,
        }))
        .expect("layout json"),
    )
    .expect("write layout");
}

fn walk(root: &Path, current: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .expect("relative")
            .to_string_lossy()
            .replace('\\', "/");
        out.push(relative);
        if path.is_dir() {
            walk(root, &path, out);
        }
    }
}

fn sqlite_dump(db: &PathBuf) -> String {
    let output = std::process::Command::new("sqlite3")
        .arg(db)
        .arg(".dump")
        .output()
        .expect("sqlite3 .dump");
    assert!(output.status.success(), "sqlite3 dump failed");
    String::from_utf8(output.stdout).expect("dump utf8")
}
