use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

use super::credential::validate_no_likely_credential;
use super::{audit_mutation, now_millis, AuditMutation, MemoryError, MemoryStore, Result};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalProject {
    pub id: String,
    pub display_name: String,
    pub folder_exists: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsVault {
    pub canonical_root: String,
    pub projects: Vec<LogicalProject>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectMapping {
    pub workspace_id: String,
    pub project_id: String,
    pub workspace_root: String,
    pub workspace_display_name: String,
    pub project_display_name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

mod knowledge;

pub use knowledge::{
    ProjectKnowledgeContext, ProjectKnowledgeKind, ProjectKnowledgeProvenance,
    ProjectKnowledgeSource, ProjectKnowledgeSync, ProjectKnowledgeSyncStatus,
};

/// Where a workspace's durable knowledge lives. `Vault` is the original
/// projects-vault mapping; `Local` keeps the same documents inside the
/// workspace itself. Legacy configs have no stored mode and always resolve to
/// `Vault` through the existing mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KnowledgeSurfaceMode {
    Vault,
    Local,
}

/// The resolved knowledge surface for one workspace. Vault surfaces are derived
/// from the existing mapping and never written to the knowledge config table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceKnowledgeSurface {
    pub workspace_id: String,
    pub mode: KnowledgeSurfaceMode,
    pub project_id: String,
    pub project_display_name: String,
    pub knowledge_root: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectLocation {
    pub(crate) project_id: String,
    pub(crate) project_display_name: String,
    pub(crate) mode: KnowledgeSurfaceMode,
    /// Vault surfaces: the registered vault root. Local surfaces: the
    /// workspace knowledge root, which is also the project root.
    pub(crate) surface_root: PathBuf,
    pub(crate) project_root: PathBuf,
}

/// The knowledge root a local surface uses: `<workspaceRoot>/.kodade/knowledge`.
/// Deliberately separate from `.kodade/memory`, which belongs to the repo-local
/// working-memory feature and keeps its own STATE.md format there.
pub(crate) fn local_knowledge_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".kodade").join("knowledge")
}

/// Directory that must contain `project_root`. Vault surfaces confine to
/// `<vault>/10-Projects`; local surfaces confine to the knowledge root itself.
pub(crate) fn validate_knowledge_container(location: &ProjectLocation) -> Result<PathBuf> {
    match location.mode {
        KnowledgeSurfaceMode::Vault => Ok(PathBuf::from(validate_projects_vault_root(
            &location.surface_root,
        )?)
        .join("10-Projects")),
        KnowledgeSurfaceMode::Local => validate_local_knowledge_root(&location.surface_root),
    }
}

pub(crate) fn validate_local_knowledge_root(root: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(root).map_err(|error| {
        MemoryError::InvalidInput(format!(
            "workspace knowledge root is inaccessible at {}: {error}",
            root.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MemoryError::InvalidInput(
            "workspace knowledge root must be a regular directory, not a symlink".into(),
        ));
    }
    std::fs::canonicalize(root).map_err(Into::into)
}

/// One knowledge surface per workspace: the refusal a vault mapping gives a
/// workspace that already keeps its knowledge locally.
const LOCAL_SURFACE_BLOCKS_MAPPING: &str =
    "this workspace uses local project knowledge; turn it off before mapping it to a projects vault";

/// Confinement failure wording, kept byte-identical for vault surfaces.
pub(crate) fn knowledge_escape_message(mode: KnowledgeSurfaceMode, label: &str) -> String {
    match mode {
        KnowledgeSurfaceMode::Vault => {
            format!("{label} folder escapes the registered projects vault")
        }
        KnowledgeSurfaceMode::Local => {
            format!("{label} folder escapes the workspace knowledge root")
        }
    }
}

impl MemoryStore {
    pub fn register_projects_vault(&self, root: impl AsRef<Path>) -> Result<ProjectsVault> {
        let canonical_root = validate_projects_vault_root(root.as_ref())?;
        validate_no_likely_credential("projects vault root", &canonical_root)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection.execute(
                "INSERT INTO projects_vault_config (
                    singleton, canonical_root, created_at, updated_at
                 ) VALUES (1, ?1, ?2, ?2)
                 ON CONFLICT(singleton) DO UPDATE SET
                    canonical_root = excluded.canonical_root,
                    updated_at = excluded.updated_at",
                params![canonical_root, now],
            )?;
            projects_vault_with_connection(&connection)
        })?
        .ok_or_else(|| MemoryError::InvalidInput("projects vault registration failed".into()))
    }

    pub fn projects_vault(&self) -> Result<Option<ProjectsVault>> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            projects_vault_with_connection(&connection)
        })
    }

    pub fn workspace_project_mapping(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceProjectMapping>> {
        validate_no_likely_credential("workspace id", workspace_id)?;
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            workspace_project_mapping_with_connection(&connection, workspace_id)
        })
    }

    pub fn project_workspace_mappings(
        &self,
        project_id: &str,
    ) -> Result<Vec<WorkspaceProjectMapping>> {
        validate_project_id(project_id)?;
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT m.workspace_id, m.project_id, w.canonical_root, w.display_name,
                        p.display_name, m.created_at, m.updated_at
                 FROM workspace_project_mappings m
                 JOIN workspaces w ON w.id = m.workspace_id
                 JOIN logical_projects p ON p.id = m.project_id
                 WHERE m.project_id = ?1
                 ORDER BY w.display_name COLLATE NOCASE, m.workspace_id",
            )?;
            let mappings = statement
                .query_map([project_id], workspace_project_mapping_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(mappings)
        })
    }

    /// The stored local knowledge config for a workspace, if it has one. Vault
    /// surfaces are derived from the mapping and never appear here.
    fn local_knowledge_config(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceKnowledgeSurface>> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            local_knowledge_surface_with_connection(&connection, workspace_id)
        })
    }

    /// Resolve the knowledge surface for a workspace without writing anything.
    /// Legacy configs carry no stored mode: a mapping resolves to `Vault`, and
    /// a workspace with neither mapping nor local config has no surface at all.
    pub fn workspace_knowledge_surface(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceKnowledgeSurface>> {
        validate_no_likely_credential("workspace id", workspace_id)?;
        if let Some(local) = self.local_knowledge_config(workspace_id)? {
            return Ok(Some(local));
        }
        let Some(mapping) = self.workspace_project_mapping(workspace_id)? else {
            return Ok(None);
        };
        let vault = self.projects_vault()?.ok_or_else(|| {
            MemoryError::InvalidInput("mapped workspace has no registered projects vault".into())
        })?;
        Ok(Some(WorkspaceKnowledgeSurface {
            workspace_id: mapping.workspace_id,
            mode: KnowledgeSurfaceMode::Vault,
            knowledge_root: Path::new(&vault.canonical_root)
                .join("10-Projects")
                .join(&mapping.project_id)
                .to_string_lossy()
                .into_owned(),
            project_id: mapping.project_id,
            project_display_name: mapping.project_display_name,
            created_at: mapping.created_at,
            updated_at: mapping.updated_at,
        }))
    }

    /// Opt a workspace into a local knowledge surface. Idempotent: an already
    /// local workspace returns its existing surface untouched.
    pub fn enable_local_knowledge(&self, workspace_id: &str) -> Result<WorkspaceKnowledgeSurface> {
        validate_no_likely_credential("workspace id", workspace_id)?;
        if let Some(existing) = self.local_knowledge_config(workspace_id)? {
            return Ok(existing);
        }
        if self.workspace_project_mapping(workspace_id)?.is_some() {
            return Err(MemoryError::InvalidInput(
                "this workspace is mapped to a projects vault; unmap it before using local knowledge"
                    .into(),
            ));
        }
        // One knowledge surface per workspace. The two features now use
        // separate directories, so this is a coherence rule rather than a
        // collision fix. (The reverse direction is already refused by
        // activate_working_memory once a local surface has authority.)
        if self.working_memory_status(workspace_id)?.is_some() {
            return Err(MemoryError::InvalidInput(
                "repo-local working memory is already active for this workspace; turn it off before using local knowledge"
                    .into(),
            ));
        }
        let workspace = self.workspace(workspace_id)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let project_id = available_local_project_id(&transaction, &workspace.display_name)?;
            transaction.execute(
                "INSERT INTO logical_projects (id, display_name, kind, created_at, updated_at)
                 VALUES (?1, ?2, 'local', ?3, ?3)",
                params![project_id, workspace.display_name, now],
            )?;
            transaction.execute(
                "INSERT INTO workspace_knowledge_config (
                    workspace_id, mode, project_id, created_at, updated_at
                 ) VALUES (?1, 'local', ?2, ?3, ?3)",
                params![workspace_id, project_id, now],
            )?;
            audit_mutation(
                &transaction,
                workspace_id,
                AuditMutation {
                    client: "kodade-ui",
                    session_id: None,
                    capability: "memory:write",
                    action: "enable_local_knowledge",
                    target_id: None,
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            local_knowledge_surface_with_connection(&connection, workspace_id)?.ok_or_else(|| {
                MemoryError::InvalidInput("local knowledge surface was not saved".into())
            })
        })
    }

    /// Turn a local knowledge surface back off. Only local configs can be
    /// disabled; a vault mapping is refused. Idempotent for a workspace that
    /// has no surface at all. Files under the knowledge root are left alone.
    pub fn disable_local_knowledge(&self, workspace_id: &str) -> Result<()> {
        validate_no_likely_credential("workspace id", workspace_id)?;
        let Some(surface) = self.local_knowledge_config(workspace_id)? else {
            if self.workspace_project_mapping(workspace_id)?.is_some() {
                return Err(MemoryError::InvalidInput(
                    "this workspace uses a projects vault; change its mapping instead of disabling local knowledge"
                        .into(),
                ));
            }
            return Ok(());
        };
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "DELETE FROM workspace_knowledge_config WHERE workspace_id = ?1 AND mode = 'local'",
                [workspace_id],
            )?;
            // logical_projects is RESTRICT-referenced and also carries record
            // provenance. Drop the local project only when nothing points at it
            // any more; otherwise leave the row, which stays kind = 'local' and
            // therefore stays out of the vault project picker.
            let referenced: bool = transaction.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM workspace_knowledge_config WHERE project_id = ?1
                    UNION ALL
                    SELECT 1 FROM workspace_project_mappings WHERE project_id = ?1
                    UNION ALL
                    SELECT 1 FROM memories WHERE canonical_project_id = ?1
                    UNION ALL
                    SELECT 1 FROM checkpoints WHERE canonical_project_id = ?1
                 )",
                [&surface.project_id],
                |row| row.get(0),
            )?;
            if !referenced {
                transaction.execute(
                    "DELETE FROM logical_projects WHERE id = ?1 AND kind = 'local'",
                    [&surface.project_id],
                )?;
            }
            audit_mutation(
                &transaction,
                workspace_id,
                AuditMutation {
                    client: "kodade-ui",
                    session_id: None,
                    capability: "memory:write",
                    action: "disable_local_knowledge",
                    target_id: None,
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            Ok(())
        })
    }

    pub fn map_workspace_to_project(
        &self,
        workspace_id: &str,
        expected_project_id: Option<&str>,
        project_id: &str,
        project_display_name: &str,
    ) -> Result<WorkspaceProjectMapping> {
        validate_no_likely_credential("workspace id", workspace_id)?;
        validate_project_id(project_id)?;
        if let Some(expected) = expected_project_id {
            validate_project_id(expected)?;
        }
        let project_display_name = project_display_name.trim();
        if project_display_name.is_empty() {
            return Err(MemoryError::InvalidInput(
                "logical project display name cannot be empty".into(),
            ));
        }
        validate_no_likely_credential("logical project display name", project_display_name)?;
        // Refused before the lock work below, which would otherwise report the
        // local knowledge root instead of the real reason. The same check runs
        // again inside the transaction, where it is race-free.
        if self.local_knowledge_config(workspace_id)?.is_some() {
            return Err(MemoryError::InvalidInput(
                LOCAL_SURFACE_BLOCKS_MAPPING.into(),
            ));
        }
        let vault = self.projects_vault()?.ok_or_else(|| {
            MemoryError::InvalidInput(
                "register an Obsidian projects vault before mapping a workspace".into(),
            )
        })?;
        validate_projects_vault_root(Path::new(&vault.canonical_root))?;
        validate_project_folder(&vault.canonical_root, project_id)?;

        // Mapping changes participate in the same canonical-root locks as
        // portable writes and migrations. Sorting the exact roots avoids
        // deadlock when a remap spans two logical projects.
        let mut locked_locations = Vec::new();
        if let Some(current) = self.project_location(workspace_id)? {
            locked_locations.push(current);
        }
        let destination = ProjectLocation {
            project_id: project_id.into(),
            project_display_name: project_display_name.into(),
            mode: KnowledgeSurfaceMode::Vault,
            surface_root: PathBuf::from(&vault.canonical_root),
            project_root: PathBuf::from(&vault.canonical_root)
                .join("10-Projects")
                .join(project_id),
        };
        if destination.project_root.is_dir() {
            locked_locations.push(destination);
        }
        locked_locations.sort_by(|left, right| left.project_root.cmp(&right.project_root));
        locked_locations.dedup_by(|left, right| left.project_root == right.project_root);
        let mut _project_locks = Vec::with_capacity(locked_locations.len());
        for location in &locked_locations {
            _project_locks.push(self.lock_portable_project(location)?);
        }

        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let workspace_exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
                [workspace_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !workspace_exists {
                return Err(MemoryError::WorkspaceNotRegistered(workspace_id.into()));
            }
            let current: Option<String> = transaction
                .query_row(
                    "SELECT project_id FROM workspace_project_mappings WHERE workspace_id = ?1",
                    [workspace_id],
                    |row| row.get(0),
                )
                .optional()?;
            if current.as_deref() != expected_project_id {
                return Err(match current {
                    Some(current) => MemoryError::InvalidInput(format!(
                        "workspace is already mapped to {current}; refresh the mapping before changing it"
                    )),
                    None => MemoryError::InvalidInput(
                        "workspace project mapping changed; refresh before retrying".into(),
                    ),
                });
            }

            let existing_project: Option<(String, String)> = transaction
                .query_row(
                    "SELECT display_name, kind FROM logical_projects WHERE id = ?1",
                    [project_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            // One knowledge surface per workspace, enforced from both
            // directions: `enable_local_knowledge` refuses a vault-mapped
            // workspace, and a local surface refuses a vault mapping. Without
            // this a workspace could hold both rows at once, and
            // `workspace_knowledge_surface` would silently prefer the local
            // config while a vault mapping looked active. Re-checked here in
            // the immediate transaction so a concurrent enable cannot slip
            // between the pre-flight check and this write.
            if local_knowledge_surface_with_connection(&transaction, workspace_id)?.is_some() {
                return Err(MemoryError::InvalidInput(LOCAL_SURFACE_BLOCKS_MAPPING.into()));
            }
            // A local-surface project owns workspace-local files; it can never
            // become a vault mapping target.
            if existing_project
                .as_ref()
                .is_some_and(|(_, kind)| kind == "local")
            {
                return Err(MemoryError::InvalidInput(format!(
                    "{project_id} is a local knowledge project; choose a different logical project ID"
                )));
            }
            let existing_project_name = existing_project.map(|(display_name, _)| display_name);
            if let Some(existing) = existing_project_name.as_deref() {
                if existing != project_display_name {
                    return Err(MemoryError::InvalidInput(format!(
                        "logical project {project_id} already exists as {existing}; choose that project or use a different ID"
                    )));
                }
            }
            ensure_project_folder(&vault.canonical_root, project_id)?;

            transaction.execute(
                "INSERT INTO logical_projects (id, display_name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                    updated_at = excluded.updated_at",
                params![project_id, project_display_name, now],
            )?;
            transaction.execute(
                "INSERT INTO workspace_project_mappings (
                    workspace_id, project_id, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                    project_id = excluded.project_id,
                    updated_at = excluded.updated_at",
                params![workspace_id, project_id, now],
            )?;
            audit_mutation(
                &transaction,
                workspace_id,
                AuditMutation {
                    client: "kodade-ui",
                    session_id: None,
                    capability: "memory:write",
                    action: "map_workspace_project",
                    target_id: None,
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            workspace_project_mapping_with_connection(&connection, workspace_id)?
                .ok_or_else(|| MemoryError::InvalidInput("workspace mapping was not saved".into()))
        })
    }
}

pub(crate) fn validate_projects_vault_root(root: &Path) -> Result<String> {
    let canonical = std::fs::canonicalize(root).map_err(|error| {
        MemoryError::InvalidInput(format!(
            "projects vault is inaccessible at {}: {error}",
            root.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(MemoryError::InvalidInput(
            "projects vault root must be a directory".into(),
        ));
    }
    validate_vault_directory(&canonical.join(".obsidian"), ".obsidian")?;
    validate_vault_directory(&canonical.join("10-Projects"), "10-Projects")?;
    Ok(canonical.to_string_lossy().into_owned())
}

fn validate_vault_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        MemoryError::InvalidInput(format!(
            "projects vault must contain an accessible {label} directory: {error}"
        ))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(MemoryError::InvalidInput(format!(
            "projects vault {label} directory cannot be a symlink"
        )));
    }
    if !metadata.is_dir() {
        return Err(MemoryError::InvalidInput(format!(
            "projects vault {label} entry must be a directory"
        )));
    }
    Ok(())
}

fn validate_project_id(project_id: &str) -> Result<()> {
    let valid = !project_id.is_empty()
        && project_id.len() <= 64
        && project_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && project_id
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && project_id
            .as_bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric());
    if valid {
        Ok(())
    } else {
        Err(MemoryError::InvalidInput(
            "logical project ID must use 1-64 lowercase letters, numbers, or internal hyphens"
                .into(),
        ))
    }
}

fn validate_project_folder(vault_root: &str, project_id: &str) -> Result<()> {
    let folder = Path::new(vault_root).join("10-Projects").join(project_id);
    match std::fs::symlink_metadata(&folder) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(MemoryError::InvalidInput(
            format!("project folder cannot be a symlink: {project_id}"),
        )),
        Ok(metadata) if !metadata.is_dir() => Err(MemoryError::InvalidInput(format!(
            "project folder must be a directory: {project_id}"
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(MemoryError::InvalidInput(format!(
            "project folder is inaccessible for {project_id}: {error}"
        ))),
    }
}

fn ensure_project_folder(vault_root: &str, project_id: &str) -> Result<()> {
    let folder = Path::new(vault_root).join("10-Projects").join(project_id);
    match std::fs::create_dir(&folder) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_project_folder(vault_root, project_id)
        }
        Err(error) => Err(MemoryError::InvalidInput(format!(
            "cannot create project folder for {project_id}: {error}"
        ))),
    }
}

fn projects_vault_with_connection(connection: &Connection) -> Result<Option<ProjectsVault>> {
    let config = connection
        .query_row(
            "SELECT canonical_root, created_at, updated_at
             FROM projects_vault_config WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((canonical_root, created_at, updated_at)) = config else {
        return Ok(None);
    };
    validate_projects_vault_root(Path::new(&canonical_root))?;

    let mut projects = BTreeMap::<String, LogicalProject>::new();
    // Local-surface projects never appear in the vault picker.
    let mut statement = connection.prepare(
        "SELECT id, display_name FROM logical_projects WHERE kind = 'vault' ORDER BY id",
    )?;
    let stored = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, display_name) in stored {
        let folder_exists =
            std::fs::symlink_metadata(Path::new(&canonical_root).join("10-Projects").join(&id))
                .is_ok();
        projects.insert(
            id.clone(),
            LogicalProject {
                id,
                display_name,
                folder_exists,
            },
        );
    }

    let project_root = Path::new(&canonical_root).join("10-Projects");
    let entries = std::fs::read_dir(&project_root).map_err(|error| {
        MemoryError::InvalidInput(format!(
            "projects vault 10-Projects directory is inaccessible: {error}"
        ))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            MemoryError::InvalidInput(format!("cannot read a projects vault entry: {error}"))
        })?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if validate_project_id(&id).is_err() {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            MemoryError::InvalidInput(format!("cannot inspect project folder {id}: {error}"))
        })?;
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        projects
            .entry(id.clone())
            .or_insert_with(|| LogicalProject {
                display_name: id.clone(),
                id,
                folder_exists: true,
            });
    }

    Ok(Some(ProjectsVault {
        canonical_root,
        projects: projects.into_values().collect(),
        created_at,
        updated_at,
    }))
}

pub(crate) fn local_knowledge_surface_with_connection(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<WorkspaceKnowledgeSurface>> {
    let row = connection
        .query_row(
            "SELECT c.project_id, p.display_name, w.canonical_root, c.created_at, c.updated_at
             FROM workspace_knowledge_config c
             JOIN logical_projects p ON p.id = c.project_id
             JOIN workspaces w ON w.id = c.workspace_id
             WHERE c.workspace_id = ?1 AND c.mode = 'local'",
            [workspace_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((project_id, project_display_name, workspace_root, created_at, updated_at)) = row
    else {
        return Ok(None);
    };
    Ok(Some(WorkspaceKnowledgeSurface {
        workspace_id: workspace_id.into(),
        mode: KnowledgeSurfaceMode::Local,
        project_id,
        project_display_name,
        knowledge_root: local_knowledge_root(Path::new(&workspace_root))
            .to_string_lossy()
            .into_owned(),
        created_at,
        updated_at,
    }))
}

/// Derive a valid, unused logical project ID from a workspace display name.
fn available_local_project_id(connection: &Connection, display_name: &str) -> Result<String> {
    let base = slug_project_id(display_name);
    for attempt in 0..1_000u32 {
        let candidate = if attempt == 0 {
            base.clone()
        } else {
            let suffix = format!("-{}", attempt + 1);
            let trimmed = base
                .chars()
                .take(64usize.saturating_sub(suffix.len()))
                .collect::<String>();
            format!("{}{suffix}", trimmed.trim_end_matches('-'))
        };
        let taken: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM logical_projects WHERE id = ?1)",
            [&candidate],
            |row| row.get(0),
        )?;
        if !taken {
            return Ok(candidate);
        }
    }
    Err(MemoryError::InvalidInput(
        "could not derive a free local knowledge project ID for this workspace".into(),
    ))
}

/// Mirrors `projectIdFromName` in ProjectsVaultSetup.tsx so a local project ID
/// looks like the one the vault setup form would suggest: NFKD-decompose, drop
/// the combining diacritics block, then collapse every run of non-`[a-z0-9]`
/// into a single hyphen.
fn slug_project_id(display_name: &str) -> String {
    let folded = display_name
        .nfkd()
        .filter(|character| !matches!(character, '\u{0300}'..='\u{036f}'))
        .collect::<String>()
        .to_lowercase();
    let mut slug = String::new();
    for character in folded.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            slug.push(character);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').chars().take(64).collect::<String>();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        "project".into()
    } else {
        slug
    }
}

fn workspace_project_mapping_with_connection(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<WorkspaceProjectMapping>> {
    connection
        .query_row(
            "SELECT m.workspace_id, m.project_id, w.canonical_root, w.display_name,
                    p.display_name, m.created_at, m.updated_at
             FROM workspace_project_mappings m
             JOIN workspaces w ON w.id = m.workspace_id
             JOIN logical_projects p ON p.id = m.project_id
             WHERE m.workspace_id = ?1",
            [workspace_id],
            workspace_project_mapping_from_row,
        )
        .optional()
        .map_err(MemoryError::from)
}

fn workspace_project_mapping_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<WorkspaceProjectMapping> {
    Ok(WorkspaceProjectMapping {
        workspace_id: row.get(0)?,
        project_id: row.get(1)?,
        workspace_root: row.get(2)?,
        workspace_display_name: row.get(3)?,
        project_display_name: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}
