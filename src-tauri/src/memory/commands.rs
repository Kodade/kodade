use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::desktop::{open_uri_command, spawn as spawn_desktop, DesktopPlatform};

use super::onboarding::{failed_mcp_health, run_mcp_health, McpHealth};

use super::{
    ActivityEvent, AuditEntry, AuditQuery, Checkpoint, CheckpointQuery, CheckpointSearchHit,
    DeletedMemoryQuery, ExportBundle, LegacyMigrationApply, LegacyMigrationPlan,
    LegacyMigrationRollback, MemoryError, MemoryQuery, MemoryRecord, MemoryRevision,
    MemorySearchHit, MemoryStore, MutationProvenance, NewActivity, NewCheckpoint, NewMemory, Page,
    ProjectScaffoldApply, ProjectScaffoldPlan, ProjectsVault, RetentionReport, RetentionSettings,
    Tombstone, WorkingMemoryMode, WorkingMemoryStatus, Workspace, WorkspaceContext,
    WorkspaceProjectMapping,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBinaryPath {
    path: Option<String>,
    exists: bool,
}

#[tauri::command]
pub fn memory_mcp_binary_path(app: AppHandle) -> Result<McpBinaryPath, String> {
    if let Some(path) = std::env::var_os("KODADE_MCP_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(existing_mcp_binary(path));
        }
        return Err("KODADE_MCP_PATH does not point to a KödMCP helper file".into());
    }
    let resource_dir = app.path().resource_dir().ok();
    let executable = std::env::current_exe().ok();
    if let Some(path) = resolve_mcp_binary_path(resource_dir.as_deref(), executable.as_deref()) {
        return Ok(existing_mcp_binary(path));
    }

    Err("kodade-mcp was not found in the bundled resources; build the KödMCP helper for development".into())
}

fn resolve_mcp_binary_path(
    resource_dir: Option<&Path>,
    executable: Option<&Path>,
) -> Option<PathBuf> {
    // `Contents/MacOS` is stable across the public and development bundles.
    // Resource paths differ by profile, so recording either one in a client
    // config makes that connection fail after switching package flavors.
    let sibling = executable
        .and_then(Path::parent)
        .map(|directory| directory.join(mcp_binary_name()));
    let public_bundled = resource_dir.map(|root| root.join("helpers").join(mcp_binary_name()));
    let development_bundled = resource_dir.map(|root| {
        root.join("kodade-local")
            .join("bin")
            .join(mcp_binary_name())
    });
    let debug = executable.and_then(|executable| {
        executable
            .ancestors()
            .find(|ancestor| ancestor.file_name().is_some_and(|name| name == "target"))
            .map(|target| target.join("debug").join(mcp_binary_name()))
    });
    [sibling, public_bundled, development_bundled, debug]
        .into_iter()
        .flatten()
        .find(|candidate| candidate.is_file())
}

#[tauri::command]
pub async fn memory_mcp_health(
    app: AppHandle,
    workspace_id: String,
    client: String,
    read_only: bool,
) -> Result<McpHealth, String> {
    if client != "claude" && client != "codex" {
        return Err("unsupported agent client".into());
    }
    let (workspace, expected_project_id) = match run_memory(app.clone(), {
        let workspace_id = workspace_id.clone();
        move |store| {
            let workspace = store.workspace(&workspace_id)?;
            let mapping = store.workspace_project_mapping(&workspace_id)?;
            Ok((workspace, mapping.map(|mapping| mapping.project_id)))
        }
    })
    .await
    {
        Ok(workspace) => workspace,
        Err(_) => {
            return Ok(failed_mcp_health(
                &client,
                read_only,
                &workspace_id,
                "workspace",
                "the workspace is not registered",
            ))
        }
    };
    let Some(expected_project_id) = expected_project_id else {
        return Ok(failed_mcp_health(
            &client,
            read_only,
            &workspace_id,
            "mapping",
            "map this workspace to a projects-vault project first",
        ));
    };
    let binary = match memory_mcp_binary_path(app.clone()) {
        Ok(result) => match result.path {
            Some(path) => PathBuf::from(path),
            None => {
                return Ok(failed_mcp_health(
                    &client,
                    read_only,
                    &workspace_id,
                    "binary",
                    "the bundled KödMCP helper is unavailable",
                ))
            }
        },
        Err(_) => {
            return Ok(failed_mcp_health(
                &client,
                read_only,
                &workspace_id,
                "binary",
                "the bundled KödMCP helper is unavailable",
            ))
        }
    };
    let db = database_path(&app)
        .map_err(|_| "the KödMem database location is unavailable".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        run_mcp_health(
            binary,
            db,
            workspace,
            expected_project_id,
            client,
            read_only,
        )
    })
    .await
    .map_err(|_| "KödMCP health worker failed".to_string())
}

fn existing_mcp_binary(path: PathBuf) -> McpBinaryPath {
    McpBinaryPath {
        path: Some(path.to_string_lossy().to_string()),
        exists: true,
    }
}

fn mcp_binary_name() -> &'static str {
    if cfg!(windows) {
        "kodade-mcp.exe"
    } else {
        "kodade-mcp"
    }
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("kodade-memory.sqlite3"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn memory_database_path(app: AppHandle) -> Result<String, String> {
    database_path(&app).map(|path| path.to_string_lossy().into_owned())
}

async fn run_memory<T, F>(app: AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(MemoryStore) -> super::Result<T> + Send + 'static,
{
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = process_store(path)?;
        operation(store)
    })
    .await
    .map_err(|error| format!("memory worker failed: {error}"))?
    .map_err(|error| error.to_string())
}

fn process_store(path: PathBuf) -> super::Result<MemoryStore> {
    static STORE: OnceLock<Mutex<Option<(PathBuf, MemoryStore)>>> = OnceLock::new();
    let cache = STORE.get_or_init(|| Mutex::new(None));
    let mut cached = cache.lock().map_err(|_| {
        super::MemoryError::InvalidInput("memory store cache is unavailable".into())
    })?;
    if let Some((cached_path, store)) = cached.as_ref() {
        if cached_path == &path {
            return Ok(store.clone());
        }
    }
    let store = MemoryStore::open(&path)?;
    *cached = Some((path, store.clone()));
    Ok(store)
}

fn open_in_obsidian(uri: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let command = open_uri_command(DesktopPlatform::MacOs, uri);
    #[cfg(target_os = "windows")]
    let command = open_uri_command(DesktopPlatform::Windows, uri);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        spawn_desktop(command, "cannot open project knowledge in Obsidian")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = uri;
        Err("opening project knowledge in Obsidian is unsupported on this platform".into())
    }
}

#[tauri::command]
pub async fn memory_register_workspace(
    app: AppHandle,
    root: String,
    display_name: String,
    color: Option<String>,
) -> Result<Workspace, String> {
    run_memory(app, move |store| {
        store.register_workspace(root, &display_name, color.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn memory_resolve_workspace(
    app: AppHandle,
    root: String,
) -> Result<Option<Workspace>, String> {
    run_memory(app, move |store| match store.resolve_workspace(root) {
        Ok(workspace) => Ok(Some(workspace)),
        Err(MemoryError::WorkspaceNotRegistered(_)) => Ok(None),
        Err(error) => Err(error),
    })
    .await
}

#[tauri::command]
pub async fn memory_list_workspaces(app: AppHandle) -> Result<Vec<Workspace>, String> {
    run_memory(app, move |store| store.workspaces()).await
}

#[tauri::command]
pub async fn memory_relink_workspace(
    app: AppHandle,
    workspace_id: String,
    expected_root: String,
    new_root: String,
    source_client: String,
) -> Result<Workspace, String> {
    run_memory(app, move |store| {
        store.relink_workspace(&workspace_id, &expected_root, new_root, &source_client)
    })
    .await
}

#[tauri::command]
pub async fn memory_projects_vault(app: AppHandle) -> Result<Option<ProjectsVault>, String> {
    run_memory(app, move |store| store.projects_vault()).await
}

#[tauri::command]
pub async fn memory_register_projects_vault(
    app: AppHandle,
    root: String,
) -> Result<ProjectsVault, String> {
    run_memory(app, move |store| store.register_projects_vault(root)).await
}

#[tauri::command]
pub async fn memory_workspace_project_mapping(
    app: AppHandle,
    workspace_id: String,
) -> Result<Option<WorkspaceProjectMapping>, String> {
    run_memory(app, move |store| {
        store.workspace_project_mapping(&workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn memory_map_workspace_to_project(
    app: AppHandle,
    workspace_id: String,
    expected_project_id: Option<String>,
    project_id: String,
    project_display_name: String,
) -> Result<WorkspaceProjectMapping, String> {
    run_memory(app, move |store| {
        store.map_workspace_to_project(
            &workspace_id,
            expected_project_id.as_deref(),
            &project_id,
            &project_display_name,
        )
    })
    .await
}

#[tauri::command]
pub async fn memory_project_workspace_mappings(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<WorkspaceProjectMapping>, String> {
    run_memory(app, move |store| {
        store.project_workspace_mappings(&project_id)
    })
    .await
}

#[tauri::command]
pub async fn memory_preview_project_scaffold(
    app: AppHandle,
    workspace_id: String,
) -> Result<ProjectScaffoldPlan, String> {
    run_memory(app, move |store| {
        store.preview_project_scaffold(&workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn memory_apply_project_scaffold(
    app: AppHandle,
    workspace_id: String,
    expected_fingerprint: String,
) -> Result<ProjectScaffoldApply, String> {
    run_memory(app, move |store| {
        store.apply_project_scaffold(&workspace_id, &expected_fingerprint)
    })
    .await
}

#[tauri::command]
pub async fn memory_preview_legacy_migration(
    app: AppHandle,
    workspace_id: String,
) -> Result<LegacyMigrationPlan, String> {
    run_memory(app, move |store| {
        store.preview_legacy_migration(&workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn memory_apply_legacy_migration(
    app: AppHandle,
    workspace_id: String,
    expected_fingerprint: String,
) -> Result<LegacyMigrationApply, String> {
    run_memory(app, move |store| {
        store.apply_legacy_migration(&workspace_id, &expected_fingerprint)
    })
    .await
}

#[tauri::command]
pub async fn memory_rollback_legacy_migration(
    app: AppHandle,
    workspace_id: String,
    migration_id: String,
    expected_manifest_sha256: String,
) -> Result<LegacyMigrationRollback, String> {
    run_memory(app, move |store| {
        store.rollback_legacy_migration(&workspace_id, &migration_id, &expected_manifest_sha256)
    })
    .await
}

#[tauri::command]
pub async fn memory_open_project_in_obsidian(
    app: AppHandle,
    workspace_id: String,
) -> Result<(), String> {
    let uri = run_memory(app, move |store| store.project_obsidian_uri(&workspace_id)).await?;
    open_in_obsidian(&uri)
}

#[tauri::command]
pub async fn memory_context(
    app: AppHandle,
    workspace_id: String,
) -> Result<WorkspaceContext, String> {
    run_memory(app, move |store| store.context(&workspace_id)).await
}

#[tauri::command]
pub async fn memory_search(
    app: AppHandle,
    query: MemoryQuery,
) -> Result<Page<MemorySearchHit>, String> {
    run_memory(app, move |store| store.search(query)).await
}

#[tauri::command]
pub async fn memory_get(app: AppHandle, id: String) -> Result<MemoryRecord, String> {
    run_memory(app, move |store| store.memory(&id)).await
}

#[tauri::command]
pub async fn memory_list_deleted(
    app: AppHandle,
    query: DeletedMemoryQuery,
) -> Result<Page<MemoryRecord>, String> {
    run_memory(app, move |store| store.deleted_memory_page(query)).await
}

#[tauri::command]
pub async fn memory_remember(app: AppHandle, input: NewMemory) -> Result<MemoryRecord, String> {
    run_memory(app, move |store| store.remember(input)).await
}

#[tauri::command]
pub async fn memory_revise(
    app: AppHandle,
    input: MemoryRevision,
    expected_content_hash: Option<String>,
) -> Result<MemoryRecord, String> {
    run_memory(app, move |store| {
        store.revise_with_content_hash(input, expected_content_hash.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn memory_forget(
    app: AppHandle,
    id: String,
    expected_version: u64,
    source_client: String,
    session_id: Option<String>,
    expected_content_hash: Option<String>,
) -> Result<Tombstone, String> {
    run_memory(app, move |store| {
        let current = store.memory(&id)?;
        store.forget_in_workspace_with_content_hash(
            &id,
            expected_version,
            &current.workspace_id,
            expected_content_hash.as_deref(),
            &source_client,
            session_id.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn memory_restore(
    app: AppHandle,
    id: String,
    expected_version: u64,
    source_client: String,
    session_id: Option<String>,
    expected_content_hash: Option<String>,
) -> Result<MemoryRecord, String> {
    run_memory(app, move |store| {
        store.restore_with_content_hash(
            &id,
            expected_version,
            expected_content_hash.as_deref(),
            &source_client,
            session_id.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn memory_checkpoint(
    app: AppHandle,
    input: NewCheckpoint,
    expected_state_hash: Option<String>,
) -> Result<Checkpoint, String> {
    run_memory(app, move |store| {
        store.checkpoint_with_state_hash(input, expected_state_hash.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn memory_search_checkpoints(
    app: AppHandle,
    query: CheckpointQuery,
) -> Result<Page<CheckpointSearchHit>, String> {
    run_memory(app, move |store| store.search_checkpoints(query)).await
}

#[tauri::command]
pub async fn memory_working_status(
    app: AppHandle,
    workspace_id: String,
) -> Result<Option<WorkingMemoryStatus>, String> {
    run_memory(app, move |store| store.working_memory_status(&workspace_id)).await
}

#[tauri::command]
pub async fn memory_activate_working(
    app: AppHandle,
    workspace_id: String,
    mode: WorkingMemoryMode,
    export_existing: bool,
) -> Result<WorkingMemoryStatus, String> {
    run_memory(app, move |store| {
        store.activate_working_memory(&workspace_id, mode, export_existing)
    })
    .await
}

#[tauri::command]
pub async fn memory_sync_working(app: AppHandle, workspace_id: String) -> Result<u64, String> {
    run_memory(app, move |store| store.sync_working_memory(&workspace_id)).await
}

#[tauri::command]
pub async fn memory_observe_commit(
    app: AppHandle,
    workspace_id: String,
    head: String,
) -> Result<Option<Checkpoint>, String> {
    run_memory(app, move |store| {
        store.observe_working_memory_commit(&workspace_id, &head)
    })
    .await
}

#[tauri::command]
pub async fn memory_audit(app: AppHandle, query: AuditQuery) -> Result<Page<AuditEntry>, String> {
    run_memory(app, move |store| store.audit_page(query)).await
}

#[tauri::command]
pub async fn memory_set_retention(
    app: AppHandle,
    workspace_id: String,
    settings: RetentionSettings,
    provenance: MutationProvenance,
) -> Result<Workspace, String> {
    run_memory(app, move |store| {
        store.set_retention(&workspace_id, settings, provenance)
    })
    .await
}

#[tauri::command]
pub async fn memory_run_retention(
    app: AppHandle,
    workspace_id: String,
    now: i64,
    batch_size: u32,
    provenance: MutationProvenance,
) -> Result<RetentionReport, String> {
    run_memory(app, move |store| {
        store.run_retention(&workspace_id, now, batch_size, provenance)
    })
    .await
}

#[tauri::command]
pub async fn memory_drain_retention(
    app: AppHandle,
    workspace_id: String,
    provenance: MutationProvenance,
) -> Result<RetentionReport, String> {
    run_memory(app, move |store| {
        store.drain_retention(&workspace_id, now_millis(), 1000, 10_000, provenance)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    markdown_path: String,
    json_path: String,
}

#[tauri::command]
pub async fn memory_export_to_directory(
    app: AppHandle,
    workspace_id: String,
    destination: String,
) -> Result<ExportResult, String> {
    run_memory(app, move |store| {
        let bundle = store.export_workspace(&workspace_id)?;
        write_export(&workspace_id, Path::new(&destination), bundle)
    })
    .await
}

#[tauri::command]
pub async fn memory_purge_workspace(app: AppHandle, workspace_id: String) -> Result<(), String> {
    run_memory(app, move |store| store.purge_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn memory_record_activity(
    app: AppHandle,
    input: NewActivity,
) -> Result<Option<ActivityEvent>, String> {
    run_memory(app, move |store| {
        let workspace_id = input.workspace_id.clone();
        let provenance = MutationProvenance {
            source_client: input.source.clone(),
            session_id: input.session_id.clone(),
        };
        let event = store.record_activity(input)?;
        if let Some(event) = event.as_ref() {
            store.checkpoint_activity_fallback(event)?;
            store.run_retention(&workspace_id, now_millis(), 500, provenance)?;
        }
        Ok(event)
    })
    .await
}

fn write_export(
    workspace_id: &str,
    destination: &Path,
    bundle: ExportBundle,
) -> super::Result<ExportResult> {
    static EXPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    std::fs::create_dir_all(destination)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = EXPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let base = format!(
        "kodade-memory-{workspace_id}-{timestamp}-{}-{sequence}",
        std::process::id()
    );
    let markdown_path = destination.join(format!("{base}.md"));
    let json_path = destination.join(format!("{base}.json"));
    write_new_atomic(&markdown_path, bundle.markdown.as_bytes())?;
    if let Err(error) = write_new_atomic(&json_path, bundle.json.as_bytes()) {
        let _ = std::fs::remove_file(&markdown_path);
        return Err(error.into());
    }
    Ok(ExportResult {
        markdown_path: markdown_path.to_string_lossy().to_string(),
        json_path: json_path.to_string_lossy().to_string(),
    })
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn write_new_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("export"),
        std::process::id()
    ));
    std::fs::write(&temporary, contents)?;
    match std::fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_mcp_path_prefers_the_profile_neutral_executable_sibling() {
        let fixture = tempfile::tempdir().expect("create packaged helper fixture");
        let contents = fixture.path().join("kodade.app").join("Contents");
        let executable = contents.join("MacOS").join("kodade");
        let sibling = contents.join("MacOS").join(mcp_binary_name());
        let resources = contents.join("Resources");
        let public = resources.join("helpers").join(mcp_binary_name());
        let development = resources
            .join("kodade-local")
            .join("bin")
            .join(mcp_binary_name());
        for path in [&executable, &sibling, &public, &development] {
            std::fs::create_dir_all(path.parent().expect("fixture parent"))
                .expect("create fixture parent");
            std::fs::write(path, b"fixture").expect("write fixture file");
        }

        assert_eq!(
            resolve_mcp_binary_path(Some(&resources), Some(&executable)),
            Some(sibling),
            "agent config must use one packaged path across public and development profiles"
        );
    }

    #[test]
    fn process_cache_recovers_a_database_corrupted_after_startup() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodade-memory-command-cache-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create cache recovery fixture");
        let path = root.join("memory.sqlite3");
        let first = process_store(path.clone()).expect("open process-cached store");
        let original = first
            .register_workspace(&root, "Original", None)
            .expect("register before corruption");
        std::fs::write(&path, b"not sqlite after process cache initialization")
            .expect("corrupt cached database");

        let cached = process_store(path).expect("reuse process-cached store");
        let recovered = cached
            .register_workspace(&root, "Recovered", None)
            .expect("cached store recovers");

        assert_ne!(recovered.id, original.id);
        assert!(cached
            .recovery_backup()
            .expect("preserved runtime corruption")
            .exists());
        drop(cached);
        drop(first);
        let _ = std::fs::remove_dir_all(root);
    }
}
