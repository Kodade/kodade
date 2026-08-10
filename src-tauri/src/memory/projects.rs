use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::{
    audit_mutation, now_millis, validate_no_likely_credential, AuditMutation, MemoryError,
    MemoryStore, Result,
};

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

#[derive(Clone, Debug)]
pub(crate) struct ProjectLocation {
    pub(crate) project_id: String,
    pub(crate) project_display_name: String,
    pub(crate) vault_root: PathBuf,
    pub(crate) project_root: PathBuf,
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
        let vault = self.projects_vault()?.ok_or_else(|| {
            MemoryError::InvalidInput(
                "register an Obsidian projects vault before mapping a workspace".into(),
            )
        })?;
        validate_projects_vault_root(Path::new(&vault.canonical_root))?;
        validate_project_folder(&vault.canonical_root, project_id)?;

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

            let existing_project_name: Option<String> = transaction
                .query_row(
                    "SELECT display_name FROM logical_projects WHERE id = ?1",
                    [project_id],
                    |row| row.get(0),
                )
                .optional()?;
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
    let mut statement =
        connection.prepare("SELECT id, display_name FROM logical_projects ORDER BY id")?;
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
