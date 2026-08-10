use std::fmt;
use std::fs::{File, OpenOptions};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::types::Value;
use rusqlite::{
    params, params_from_iter, Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};

pub mod commands;
mod projects;
mod scaffold;
mod working;

pub use projects::{
    LogicalProject, ProjectKnowledgeContext, ProjectKnowledgeKind, ProjectKnowledgeProvenance,
    ProjectKnowledgeSource, ProjectKnowledgeSync, ProjectKnowledgeSyncStatus, ProjectsVault,
    WorkspaceProjectMapping,
};
pub use scaffold::{
    ProjectScaffoldApply, ProjectScaffoldPlan, ScaffoldOperation, ScaffoldOperationKind,
};
pub use working::{WorkingMemoryContext, WorkingMemoryMode, WorkingMemoryStatus};

pub type Result<T> = std::result::Result<T, MemoryError>;

pub const MEMORY_TITLE_LIMIT: usize = 200;
const MEMORY_SCHEMA_VERSION: u32 = 11;
const SEARCH_OFFSET_LIMIT: u32 = 10_000;

#[derive(Debug)]
pub enum MemoryError {
    Database(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    CorruptDatabase(String),
    NotFound(String),
    WorkspaceNotRegistered(String),
    WorkspaceRestricted(String),
    InvalidInput(String),
    VersionConflict { expected: u64, actual: u64 },
}

impl fmt::Display for MemoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => write!(f, "memory database error: {error}"),
            Self::Io(error) => write!(f, "memory filesystem error: {error}"),
            Self::Json(error) => write!(f, "memory JSON error: {error}"),
            Self::CorruptDatabase(message) => write!(f, "memory database is corrupt: {message}"),
            Self::NotFound(id) => write!(f, "memory not found: {id}"),
            Self::WorkspaceNotRegistered(root) => {
                write!(f, "workspace is not registered in Kodade: {root}")
            }
            Self::WorkspaceRestricted(id) => {
                write!(f, "memory is outside the workspace allowed by Kodade: {id}")
            }
            Self::InvalidInput(message) => f.write_str(message),
            Self::VersionConflict { expected, actual } => write!(
                f,
                "memory version conflict: expected {expected}, current version is {actual}"
            ),
        }
    }
}

impl std::error::Error for MemoryError {}

impl From<rusqlite::Error> for MemoryError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value)
    }
}

impl From<std::io::Error> for MemoryError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for MemoryError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Clone, Debug)]
pub struct MemoryStore {
    path: PathBuf,
    access: StoreAccess,
}

#[derive(Clone, Debug)]
enum StoreAccess {
    Writable { recovery: Arc<Mutex<RecoveryState>> },
    ReadOnly,
}

#[derive(Debug, Default)]
struct RecoveryState {
    backup: Option<PathBuf>,
}

struct LockedConnection {
    connection: Option<Connection>,
    recovery_lock: Option<File>,
}

impl Deref for LockedConnection {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        self.connection
            .as_ref()
            .expect("locked memory connection is available until drop")
    }
}

impl DerefMut for LockedConnection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.connection
            .as_mut()
            .expect("locked memory connection is available until drop")
    }
}

impl Drop for LockedConnection {
    fn drop(&mut self) {
        // Windows will not rename an open SQLite database. Close SQLite and
        // all of its statements before allowing exclusive recovery to begin.
        drop(self.connection.take());
        if let Some(lock) = &self.recovery_lock {
            let _ = FileExt::unlock(lock);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub canonical_root: String,
    pub display_name: String,
    pub color: Option<String>,
    pub capture_paused: bool,
    pub activity_retention_days: u32,
    pub audit_retention_days: u32,
    pub tombstone_retention_days: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Summary,
    Decision,
    Task,
    Fact,
    Preference,
}

impl MemoryKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Decision => "decision",
            Self::Task => "task",
            Self::Fact => "fact",
            Self::Preference => "preference",
        }
    }

    fn parse(value: String) -> Result<Self> {
        match value.as_str() {
            "summary" => Ok(Self::Summary),
            "decision" => Ok(Self::Decision),
            "task" => Ok(Self::Task),
            "fact" => Ok(Self::Fact),
            "preference" => Ok(Self::Preference),
            _ => Err(MemoryError::InvalidInput(format!(
                "unknown memory kind in database: {value}"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySource {
    User,
    Kodade,
    Agent,
}

impl MemorySource {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Kodade => "kodade",
            Self::Agent => "agent",
        }
    }

    fn parse(value: String) -> Result<Self> {
        match value.as_str() {
            "user" => Ok(Self::User),
            "kodade" => Ok(Self::Kodade),
            "agent" => Ok(Self::Agent),
            _ => Err(MemoryError::InvalidInput(format!(
                "unknown memory source in database: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryLink {
    pub target_id: String,
    pub relation: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMemory {
    pub workspace_id: String,
    pub kind: MemoryKind,
    pub title: String,
    pub body: String,
    pub source: MemorySource,
    pub source_client: String,
    pub session_id: Option<String>,
    pub pinned: bool,
    pub idempotency_key: Option<String>,
    pub links: Vec<MemoryLink>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub workspace_id: String,
    pub kind: MemoryKind,
    pub title: String,
    pub body: String,
    pub source: MemorySource,
    pub source_client: String,
    pub session_id: Option<String>,
    pub pinned: bool,
    pub version: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub links: Vec<MemoryLink>,
    pub backlinks: Vec<MemoryLink>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRevision {
    pub id: String,
    pub expected_version: u64,
    pub kind: MemoryKind,
    pub title: String,
    pub body: String,
    pub pinned: bool,
    pub source_client: String,
    pub session_id: Option<String>,
    pub links: Vec<MemoryLink>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub id: String,
    pub workspace_id: String,
    pub version: u64,
    pub deleted_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCheckpoint {
    pub workspace_id: String,
    pub summary: String,
    pub decisions: Vec<String>,
    pub next_actions: Vec<String>,
    pub changed_paths: Vec<String>,
    pub source: MemorySource,
    pub source_client: String,
    pub session_id: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub workspace_id: String,
    pub summary: String,
    pub decisions: Vec<String>,
    pub next_actions: Vec<String>,
    pub changed_paths: Vec<String>,
    pub source: MemorySource,
    pub source_client: String,
    pub session_id: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointQuery {
    pub workspace_id: String,
    pub text: String,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSearchHit {
    pub id: String,
    pub workspace_id: String,
    pub summary: String,
    pub excerpt: String,
    pub source: MemorySource,
    pub source_client: String,
    pub session_id: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    ProjectOpened,
    ProjectClosed,
    SessionStarted,
    SessionExited,
    Active,
    Idle,
    FileOpened,
    FileSaved,
    ProviderLaunched,
}

impl ActivityKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ProjectOpened => "project_opened",
            Self::ProjectClosed => "project_closed",
            Self::SessionStarted => "session_started",
            Self::SessionExited => "session_exited",
            Self::Active => "active",
            Self::Idle => "idle",
            Self::FileOpened => "file_opened",
            Self::FileSaved => "file_saved",
            Self::ProviderLaunched => "provider_launched",
        }
    }

    fn parse(value: String) -> Result<Self> {
        match value.as_str() {
            "project_opened" => Ok(Self::ProjectOpened),
            "project_closed" => Ok(Self::ProjectClosed),
            "session_started" => Ok(Self::SessionStarted),
            "session_exited" => Ok(Self::SessionExited),
            "active" => Ok(Self::Active),
            "idle" => Ok(Self::Idle),
            "file_opened" => Ok(Self::FileOpened),
            "file_saved" => Ok(Self::FileSaved),
            "provider_launched" => Ok(Self::ProviderLaunched),
            _ => Err(MemoryError::InvalidInput(format!(
                "unknown activity kind in database: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewActivity {
    pub workspace_id: String,
    pub kind: ActivityKind,
    pub source: String,
    pub session_id: Option<String>,
    pub relative_path: Option<String>,
    pub provider: Option<String>,
    pub occurred_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub id: String,
    pub workspace_id: String,
    pub sequence: u64,
    pub kind: ActivityKind,
    pub source: String,
    pub session_id: Option<String>,
    pub relative_path: Option<String>,
    pub provider: Option<String>,
    pub occurred_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSettings {
    pub capture_paused: bool,
    pub activity_days: u32,
    pub audit_days: u32,
    pub tombstone_days: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationProvenance {
    pub source_client: String,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub workspace_id: String,
    pub client: String,
    pub capability: String,
    pub action: String,
    pub target_id: Option<String>,
    pub session_id: Option<String>,
    pub result: String,
    pub occurred_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundle {
    pub json: String,
    pub markdown: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionReport {
    pub activity_deleted: u64,
    pub audit_deleted: u64,
    pub tombstones_deleted: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    pub workspace: Workspace,
    pub latest_checkpoint: Option<Checkpoint>,
    pub pinned_decisions: Vec<MemoryRecord>,
    pub open_tasks: Vec<MemoryRecord>,
    pub recent_memories: Vec<MemoryRecord>,
    pub working_memory: Option<WorkingMemoryContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_knowledge: Option<ProjectKnowledgeContext>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceExport<'a> {
    schema_version: u32,
    exported_at: i64,
    workspace: &'a Workspace,
    memories: &'a [MemoryRecord],
    checkpoints: &'a [Checkpoint],
    activity: &'a [ActivityEvent],
    audit: &'a [AuditEntry],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryQuery {
    pub workspace_id: String,
    pub text: String,
    pub kinds: Vec<MemoryKind>,
    pub sources: Vec<MemorySource>,
    pub updated_after: Option<i64>,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedMemoryQuery {
    pub workspace_id: String,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    pub workspace_id: String,
    pub target_id: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchHit {
    pub id: String,
    pub workspace_id: String,
    pub kind: MemoryKind,
    pub title: String,
    pub excerpt: String,
    pub source: MemorySource,
    pub pinned: bool,
    pub version: u64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_source: Option<ProjectKnowledgeProvenance>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub limit: u32,
    pub offset: u32,
}

impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let store = Self {
            path,
            access: StoreAccess::Writable {
                recovery: Arc::new(Mutex::new(RecoveryState::default())),
            },
        };
        if let Err(error) = store.initialize() {
            if !is_corruption(&error) {
                return Err(error);
            }
            store.recover_corrupt_database()?;
        }
        Ok(store)
    }

    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if !path.is_file() {
            return Err(MemoryError::InvalidInput(format!(
                "read-only memory database does not exist: {}",
                path.display()
            )));
        }
        let store = Self {
            path,
            access: StoreAccess::ReadOnly,
        };
        let connection = store.open_connection()?;
        Self::validate_read_only_schema(&connection)?;
        quick_check(&connection)?;
        Ok(store)
    }

    pub fn recovery_backup(&self) -> Option<PathBuf> {
        match &self.access {
            StoreAccess::Writable { recovery } => {
                recovery.lock().ok().and_then(|state| state.backup.clone())
            }
            StoreAccess::ReadOnly => None,
        }
    }

    fn initialize(&self) -> Result<()> {
        // Serialize first-open migration and the rollback->WAL journal
        // transition across every concurrent opener (threads and processes).
        // Holding the recovery lock exclusively means one opener runs the
        // migration while the rest wait on the OS file lock instead of racing
        // SQLite's page locks. Under a concurrent first open the migration write
        // transaction and the journal-mode change run while the database is
        // still in rollback-journal mode, where a lock upgrade can return
        // SQLITE_BUSY immediately even with a busy_timeout set. Once WAL is
        // established, per-operation connections take a shared lock and rely on
        // busy_timeout for normal write concurrency.
        let lock = self.open_recovery_lock()?;
        lock.lock_exclusive()?;
        let result = self.initialize_recovery_locked();
        FileExt::unlock(&lock)?;
        result
    }

    fn initialize_recovery_locked(&self) -> Result<()> {
        let mut connection = self.open_connection()?;
        Self::initialize_connection(&mut connection)
    }

    fn initialize_connection(connection: &mut Connection) -> Result<()> {
        migrate(connection)?;
        // Journal mode is persistent database state. Set it while opening the
        // store, not on every short-lived operation, so concurrent writers do
        // not contend on a repeated mode transition.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        quick_check(connection)?;
        Ok(())
    }

    fn recover_corrupt_database(&self) -> Result<()> {
        let StoreAccess::Writable { recovery } = &self.access else {
            return Err(MemoryError::CorruptDatabase(
                "read-only stores cannot recover or replace the database".into(),
            ));
        };
        let mut recovery = recovery.lock().map_err(|_| {
            MemoryError::InvalidInput("memory recovery state is unavailable".into())
        })?;
        let lock = self.open_recovery_lock()?;
        lock.lock_exclusive()?;
        let result = self.recover_corrupt_database_locked(&mut recovery);
        FileExt::unlock(&lock)?;
        result
    }

    fn recover_corrupt_database_locked(&self, recovery: &mut RecoveryState) -> Result<()> {
        // Another process may have replaced this database while this caller
        // waited for the file lock. Running the full initializer here both
        // recognizes that replacement and guarantees it is migrated and valid.
        match self.initialize_recovery_locked() {
            Ok(()) => return Ok(()),
            Err(error) if is_corruption(&error) => {}
            Err(error) => return Err(error),
        }
        let backup = preserve_corrupt_database(&self.path)?;
        recovery.backup = Some(backup);
        self.initialize_recovery_locked()?;
        Ok(())
    }

    fn validate_read_only_schema(connection: &Connection) -> Result<()> {
        let has_migration_table: bool = connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'schema_migrations'
             )",
            [],
            |row| row.get(0),
        )?;
        if !has_migration_table {
            return Err(MemoryError::InvalidInput(format!(
                "read-only memory database schema is older than current version {MEMORY_SCHEMA_VERSION}; open Kodade normally to migrate it"
            )));
        }
        let newest: Option<u32> =
            connection.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })?;
        let newest = newest.unwrap_or_default();
        if newest < MEMORY_SCHEMA_VERSION {
            return Err(MemoryError::InvalidInput(format!(
                "read-only memory database schema {newest} is older than current version {MEMORY_SCHEMA_VERSION}; open Kodade normally to migrate it"
            )));
        }
        if newest > MEMORY_SCHEMA_VERSION {
            return Err(MemoryError::InvalidInput(format!(
                "memory database schema {newest} is newer than this Kodade build supports"
            )));
        }
        Ok(())
    }

    pub fn register_workspace(
        &self,
        root: impl AsRef<Path>,
        display_name: &str,
        color: Option<&str>,
    ) -> Result<Workspace> {
        let canonical = std::fs::canonicalize(root)?;
        if !canonical.is_dir() {
            return Err(MemoryError::InvalidInput(
                "workspace root must be a directory".into(),
            ));
        }
        let canonical_root = canonical.to_string_lossy().to_string();
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err(MemoryError::InvalidInput(
                "workspace display name cannot be empty".into(),
            ));
        }
        validate_no_likely_credential("workspace root", &canonical_root)?;
        validate_no_likely_credential("workspace display name", display_name)?;
        validate_optional_no_likely_credential("workspace color", color)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection.execute(
                "INSERT INTO workspaces (
                    id, canonical_root, display_name, color, created_at, updated_at
                 ) VALUES (
                    'ws_' || lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?4
                 ) ON CONFLICT(canonical_root) DO UPDATE SET
                    display_name = excluded.display_name,
                    color = excluded.color,
                    updated_at = excluded.updated_at",
                params![canonical_root, display_name, color, now],
            )?;
            self.workspace_by_root(&canonical_root)
        })
    }

    pub fn resolve_workspace(&self, root: impl AsRef<Path>) -> Result<Workspace> {
        let canonical = std::fs::canonicalize(root)?;
        let canonical_root = canonical.to_string_lossy().to_string();
        self.run_with_recovery(|| {
            self.workspace_by_root(&canonical_root)
                .map_err(|error| match error {
                    MemoryError::Database(rusqlite::Error::QueryReturnedNoRows) => {
                        MemoryError::WorkspaceNotRegistered(canonical_root.clone())
                    }
                    other => other,
                })
        })
    }

    pub fn relink_workspace(
        &self,
        workspace_id: &str,
        expected_root: &str,
        new_root: impl AsRef<Path>,
        source_client: &str,
    ) -> Result<Workspace> {
        validate_source_client("workspace relink", source_client)?;
        validate_no_likely_credential("workspace id", workspace_id)?;
        validate_no_likely_credential("expected workspace root", expected_root)?;
        let canonical = std::fs::canonicalize(new_root)?;
        if !canonical.is_dir() {
            return Err(MemoryError::InvalidInput(
                "workspace root must be a directory".into(),
            ));
        }
        let canonical_root = canonical.to_string_lossy().to_string();
        validate_no_likely_credential("workspace root", &canonical_root)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let updated = transaction.execute(
                "UPDATE workspaces SET canonical_root = ?1, updated_at = ?2
                 WHERE id = ?3 AND canonical_root = ?4",
                params![canonical_root, now, workspace_id, expected_root],
            )?;
            if updated != 1 {
                let exists = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
                    [workspace_id],
                    |row| row.get::<_, bool>(0),
                )?;
                return Err(if exists {
                    MemoryError::InvalidInput(
                        "workspace root changed before the relink completed".into(),
                    )
                } else {
                    MemoryError::WorkspaceNotRegistered(workspace_id.into())
                });
            }
            audit_mutation(
                &transaction,
                workspace_id,
                AuditMutation {
                    client: source_client,
                    session_id: None,
                    capability: "memory:write",
                    action: "relink_workspace",
                    target_id: None,
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            workspace_with_connection(&connection, workspace_id)
        })
    }

    pub fn workspace(&self, id: &str) -> Result<Workspace> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            workspace_with_connection(&connection, id)
        })
    }

    pub fn workspaces(&self) -> Result<Vec<Workspace>> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id, canonical_root, display_name, color, capture_paused,
                        activity_retention_days, audit_retention_days,
                        tombstone_retention_days, created_at, updated_at
                 FROM workspaces
                 ORDER BY updated_at DESC, id ASC",
            )?;
            let workspaces = statement
                .query_map([], workspace_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(workspaces)
        })
    }

    pub fn context(&self, workspace_id: &str) -> Result<WorkspaceContext> {
        let mut context = self.run_with_recovery(|| {
            let connection = self.connection()?;
            let workspace = workspace_with_connection(&connection, workspace_id)?;
            let pinned_decisions = memories_for_query(
                &connection,
                "SELECT id FROM memories
             WHERE workspace_id = ?1 AND deleted_at IS NULL
                   AND kind = 'decision' AND pinned = 1
             ORDER BY updated_at DESC, id LIMIT 20",
                workspace_id,
            )?;
            let open_tasks = memories_for_query(
                &connection,
                "SELECT id FROM memories
             WHERE workspace_id = ?1 AND deleted_at IS NULL AND kind = 'task'
             ORDER BY pinned DESC, updated_at DESC, id LIMIT 50",
                workspace_id,
            )?;
            let recent_memories = memories_for_query(
                &connection,
                "SELECT id FROM memories
             WHERE workspace_id = ?1 AND deleted_at IS NULL
             ORDER BY updated_at DESC, id LIMIT 30",
                workspace_id,
            )?;
            let latest_checkpoint_id = connection
                .query_row(
                    "SELECT id FROM checkpoints WHERE workspace_id = ?1
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    [workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let latest_checkpoint = latest_checkpoint_id
                .as_deref()
                .map(|id| checkpoint_with_connection(&connection, id))
                .transpose()?;
            Ok(WorkspaceContext {
                workspace,
                latest_checkpoint,
                pinned_decisions,
                open_tasks,
                recent_memories,
                working_memory: None,
                project_knowledge: None,
            })
        })?;
        context.working_memory = self.working_memory_context(&context.workspace)?;
        context.project_knowledge = self.project_knowledge_context(&context.workspace.id)?;
        Ok(context)
    }

    pub fn set_retention(
        &self,
        workspace_id: &str,
        settings: RetentionSettings,
        provenance: MutationProvenance,
    ) -> Result<Workspace> {
        if settings.activity_days > 3650
            || settings.audit_days > 3650
            || settings.tombstone_days > 3650
        {
            return Err(MemoryError::InvalidInput(
                "retention cannot exceed 3650 days".into(),
            ));
        }
        validate_no_likely_credential("retention workspace id", workspace_id)?;
        validate_mutation_provenance("retention", &provenance)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let updated = transaction.execute(
                "UPDATE workspaces SET capture_paused = ?1,
                    activity_retention_days = ?2, audit_retention_days = ?3,
                    tombstone_retention_days = ?4, updated_at = ?5
             WHERE id = ?6",
                params![
                    settings.capture_paused,
                    settings.activity_days,
                    settings.audit_days,
                    settings.tombstone_days,
                    now,
                    workspace_id,
                ],
            )?;
            if updated != 1 {
                return Err(MemoryError::WorkspaceNotRegistered(workspace_id.into()));
            }
            audit_mutation(
                &transaction,
                workspace_id,
                AuditMutation {
                    client: &provenance.source_client,
                    session_id: provenance.session_id.as_deref(),
                    capability: "memory:write",
                    action: "set_retention",
                    target_id: None,
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            workspace_with_connection(&connection, workspace_id)
        })
    }

    pub fn record_activity(&self, input: NewActivity) -> Result<Option<ActivityEvent>> {
        if input.source.trim().is_empty() || input.source.chars().count() > 80 {
            return Err(MemoryError::InvalidInput(
                "activity source must be between 1 and 80 characters".into(),
            ));
        }
        validate_no_likely_credential("activity workspace id", &input.workspace_id)?;
        validate_no_likely_credential("activity source", &input.source)?;
        validate_optional_no_likely_credential("activity session id", input.session_id.as_deref())?;
        if let Some(path) = input.relative_path.as_deref() {
            if !is_confined_relative_path(path) {
                return Err(MemoryError::InvalidInput(format!(
                    "activity path must stay relative to the workspace: {path}"
                )));
            }
            validate_no_likely_credential("activity path", path)?;
        }
        if input
            .provider
            .as_ref()
            .is_some_and(|provider| provider.chars().count() > 80)
        {
            return Err(MemoryError::InvalidInput(
                "activity provider cannot exceed 80 characters".into(),
            ));
        }
        validate_optional_no_likely_credential("activity provider", input.provider.as_deref())?;
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let paused = transaction
                .query_row(
                    "SELECT capture_paused FROM workspaces WHERE id = ?1",
                    [&input.workspace_id],
                    |row| row.get::<_, bool>(0),
                )
                .optional()?
                .ok_or_else(|| MemoryError::WorkspaceNotRegistered(input.workspace_id.clone()))?;
            if paused {
                return Ok(None);
            }
            let occurred_at = input.occurred_at.unwrap_or_else(now_millis);
            transaction.execute(
                "INSERT INTO activity_workspace_sequences (workspace_id, next_sequence)
                 VALUES (?1, 1)
                 ON CONFLICT(workspace_id) DO UPDATE
                    SET next_sequence = next_sequence + 1",
                [&input.workspace_id],
            )?;
            let sequence: u64 = transaction.query_row(
                "SELECT next_sequence FROM activity_workspace_sequences WHERE workspace_id = ?1",
                [&input.workspace_id],
                |row| row.get(0),
            )?;
            transaction.execute(
                "INSERT INTO activity_events (
                id, workspace_id, kind, source, session_id, relative_path,
                provider, occurred_at, sequence
             ) VALUES ('act_' || lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    input.workspace_id,
                    input.kind.as_str(),
                    input.source,
                    input.session_id,
                    input.relative_path,
                    input.provider,
                    occurred_at,
                    sequence,
                ],
            )?;
            let id: String = transaction.query_row(
                "SELECT id FROM activity_events WHERE rowid = last_insert_rowid()",
                [],
                |row| row.get(0),
            )?;
            transaction.commit()?;
            Ok(Some(ActivityEvent {
                id,
                workspace_id: input.workspace_id.clone(),
                sequence,
                kind: input.kind,
                source: input.source.clone(),
                session_id: input.session_id.clone(),
                relative_path: input.relative_path.clone(),
                provider: input.provider.clone(),
                occurred_at,
            }))
        })
    }

    pub fn remember(&self, input: NewMemory) -> Result<MemoryRecord> {
        validate_memory(&input, MEMORY_TITLE_LIMIT)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let inserted = transaction.execute(
                "INSERT INTO memories (
                id, workspace_id, kind, title, body, source, source_client,
                session_id, pinned, version, idempotency_key, created_at, updated_at
             ) VALUES (
                'mem_' || lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, 1, ?9, ?10, ?10
             ) ON CONFLICT(workspace_id, idempotency_key) DO NOTHING",
                params![
                    &input.workspace_id,
                    input.kind.as_str(),
                    input.title.trim(),
                    &input.body,
                    input.source.as_str(),
                    &input.source_client,
                    &input.session_id,
                    input.pinned,
                    &input.idempotency_key,
                    now,
                ],
            )?;

            let id: String = if let Some(key) = input.idempotency_key.as_deref() {
                transaction.query_row(
                    "SELECT id FROM memories WHERE workspace_id = ?1 AND idempotency_key = ?2",
                    params![input.workspace_id, key],
                    |row| row.get::<_, String>(0),
                )?
            } else {
                transaction.query_row(
                    "SELECT id FROM memories WHERE rowid = last_insert_rowid()",
                    [],
                    |row| row.get::<_, String>(0),
                )?
            };
            if inserted == 0 {
                transaction.commit()?;
                return memory_with_connection(&connection, &id);
            }
            insert_links(&transaction, &id, &input.workspace_id, &input.links, now)?;
            audit_mutation(
                &transaction,
                &input.workspace_id,
                AuditMutation {
                    client: &input.source_client,
                    session_id: input.session_id.as_deref(),
                    capability: "memory:write",
                    action: "remember",
                    target_id: Some(&id),
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            memory_with_connection(&connection, &id)
        })
    }

    pub fn remember_batch(&self, inputs: Vec<NewMemory>) -> Result<u64> {
        if inputs.len() > 50_000 {
            return Err(MemoryError::InvalidInput(
                "memory batch cannot exceed 50000 records".into(),
            ));
        }
        for input in &inputs {
            validate_memory(input, MEMORY_TITLE_LIMIT)?;
        }
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut inserted_count = 0_u64;
            for input in &inputs {
                let inserted = transaction.execute(
                    "INSERT INTO memories (
                    id, workspace_id, kind, title, body, source, source_client,
                    session_id, pinned, version, idempotency_key, created_at, updated_at
                 ) VALUES (
                    'mem_' || lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, 1, ?9, ?10, ?10
                 ) ON CONFLICT(workspace_id, idempotency_key) DO NOTHING",
                    params![
                        input.workspace_id,
                        input.kind.as_str(),
                        input.title.trim(),
                        input.body,
                        input.source.as_str(),
                        input.source_client,
                        input.session_id,
                        input.pinned,
                        input.idempotency_key,
                        now,
                    ],
                )?;
                if inserted == 0 {
                    continue;
                }
                let id: String = transaction.query_row(
                    "SELECT id FROM memories WHERE rowid = last_insert_rowid()",
                    [],
                    |row| row.get(0),
                )?;
                insert_links(&transaction, &id, &input.workspace_id, &input.links, now)?;
                audit_mutation(
                    &transaction,
                    &input.workspace_id,
                    AuditMutation {
                        client: &input.source_client,
                        session_id: input.session_id.as_deref(),
                        capability: "memory:write",
                        action: "remember",
                        target_id: Some(&id),
                        occurred_at: now,
                    },
                )?;
                inserted_count += 1;
            }
            transaction.commit()?;
            Ok(inserted_count)
        })
    }

    pub fn revise(&self, input: MemoryRevision) -> Result<MemoryRecord> {
        validate_memory_revision(&input, MEMORY_TITLE_LIMIT)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = transaction
                .query_row(
                    "SELECT workspace_id, version FROM memories
                 WHERE id = ?1 AND deleted_at IS NULL",
                    [&input.id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
                )
                .optional()?
                .ok_or_else(|| MemoryError::NotFound(input.id.clone()))?;
            if current.1 != input.expected_version {
                return Err(MemoryError::VersionConflict {
                    expected: input.expected_version,
                    actual: current.1,
                });
            }
            let updated = transaction.execute(
                "UPDATE memories SET kind = ?1, title = ?2, body = ?3, pinned = ?4,
                    source_client = ?5, session_id = ?6, version = version + 1,
                    updated_at = ?7
             WHERE id = ?8 AND version = ?9 AND deleted_at IS NULL",
                params![
                    input.kind.as_str(),
                    input.title.trim(),
                    &input.body,
                    input.pinned,
                    &input.source_client,
                    &input.session_id,
                    now,
                    &input.id,
                    input.expected_version,
                ],
            )?;
            if updated != 1 {
                let actual = transaction.query_row(
                    "SELECT version FROM memories WHERE id = ?1",
                    [&input.id],
                    |row| row.get(0),
                )?;
                return Err(MemoryError::VersionConflict {
                    expected: input.expected_version,
                    actual,
                });
            }
            transaction.execute("DELETE FROM memory_links WHERE source_id = ?1", [&input.id])?;
            insert_links(&transaction, &input.id, &current.0, &input.links, now)?;
            audit_mutation(
                &transaction,
                &current.0,
                AuditMutation {
                    client: &input.source_client,
                    session_id: input.session_id.as_deref(),
                    capability: "memory:write",
                    action: "revise",
                    target_id: Some(&input.id),
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            memory_with_connection(&connection, &input.id)
        })
    }

    pub fn forget(
        &self,
        id: &str,
        expected_version: u64,
        source_client: &str,
        session_id: Option<&str>,
    ) -> Result<Tombstone> {
        self.forget_inner(id, expected_version, None, source_client, session_id)
    }

    pub fn forget_in_workspace(
        &self,
        id: &str,
        expected_version: u64,
        workspace_id: &str,
        source_client: &str,
        session_id: Option<&str>,
    ) -> Result<Tombstone> {
        validate_no_likely_credential("memory workspace id", workspace_id)?;
        self.forget_inner(
            id,
            expected_version,
            Some(workspace_id),
            source_client,
            session_id,
        )
    }

    fn forget_inner(
        &self,
        id: &str,
        expected_version: u64,
        workspace_id: Option<&str>,
        source_client: &str,
        session_id: Option<&str>,
    ) -> Result<Tombstone> {
        validate_source_client("memory", source_client)?;
        validate_no_likely_credential("memory id", id)?;
        validate_optional_no_likely_credential("memory session id", session_id)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = transaction
                .query_row(
                    "SELECT workspace_id, version FROM memories
                 WHERE id = ?1 AND deleted_at IS NULL",
                    [id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
                )
                .optional()?
                .ok_or_else(|| MemoryError::NotFound(id.into()))?;
            if workspace_id.is_some_and(|allowed| allowed != current.0) {
                return Err(MemoryError::WorkspaceRestricted(id.into()));
            }
            if current.1 != expected_version {
                return Err(MemoryError::VersionConflict {
                    expected: expected_version,
                    actual: current.1,
                });
            }
            let deleted = transaction.execute(
                "UPDATE memories SET deleted_at = ?1, updated_at = ?1,
                    version = version + 1, source_client = ?2, session_id = ?3
             WHERE id = ?4 AND version = ?5 AND deleted_at IS NULL",
                params![now, source_client, session_id, id, expected_version],
            )?;
            if deleted != 1 {
                let actual = transaction.query_row(
                    "SELECT version FROM memories WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )?;
                return Err(MemoryError::VersionConflict {
                    expected: expected_version,
                    actual,
                });
            }
            audit_mutation(
                &transaction,
                &current.0,
                AuditMutation {
                    client: source_client,
                    session_id,
                    capability: "memory:write",
                    action: "forget",
                    target_id: Some(id),
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            Ok(Tombstone {
                id: id.into(),
                workspace_id: current.0,
                version: expected_version + 1,
                deleted_at: now,
            })
        })
    }

    pub fn restore(
        &self,
        id: &str,
        expected_version: u64,
        source_client: &str,
        session_id: Option<&str>,
    ) -> Result<MemoryRecord> {
        validate_source_client("memory", source_client)?;
        validate_no_likely_credential("memory id", id)?;
        validate_optional_no_likely_credential("memory session id", session_id)?;
        let now = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = transaction
                .query_row(
                    "SELECT m.workspace_id, m.version, m.deleted_at,
                            w.tombstone_retention_days
                     FROM memories m
                     JOIN workspaces w ON w.id = m.workspace_id
                     WHERE m.id = ?1 AND m.deleted_at IS NOT NULL",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, u64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, u32>(3)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| MemoryError::NotFound(id.into()))?;
            if current.1 != expected_version {
                return Err(MemoryError::VersionConflict {
                    expected: expected_version,
                    actual: current.1,
                });
            }
            if current.2 < retention_cutoff(now, current.3) {
                return Err(MemoryError::InvalidInput(format!(
                    "memory can only be restored within {} days of deletion",
                    current.3
                )));
            }
            transaction.execute(
                "UPDATE memories SET deleted_at = NULL, updated_at = ?1,
                    version = version + 1, source_client = ?2, session_id = ?3
             WHERE id = ?4 AND version = ?5 AND deleted_at IS NOT NULL",
                params![now, source_client, session_id, id, expected_version],
            )?;
            audit_mutation(
                &transaction,
                &current.0,
                AuditMutation {
                    client: source_client,
                    session_id,
                    capability: "memory:write",
                    action: "restore",
                    target_id: Some(id),
                    occurred_at: now,
                },
            )?;
            transaction.commit()?;
            memory_with_connection(&connection, id)
        })
    }

    pub fn checkpoint(&self, input: NewCheckpoint) -> Result<Checkpoint> {
        self.checkpoint_with_state(input, true)
    }

    fn checkpoint_with_state(
        &self,
        input: NewCheckpoint,
        update_state: bool,
    ) -> Result<Checkpoint> {
        validate_checkpoint(&input)?;
        let decisions = serde_json::to_string(&input.decisions)?;
        let next_actions = serde_json::to_string(&input.next_actions)?;
        let changed_paths = serde_json::to_string(&input.changed_paths)?;
        let now = now_millis();
        let checkpoint = self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let inserted = transaction.execute(
                "INSERT INTO checkpoints (
                    id, workspace_id, summary, decisions_json, next_actions_json,
                    changed_paths_json, source, source_client, session_id,
                    idempotency_key, created_at, updates_state
                 ) VALUES (
                    'cp_' || lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5,
                    ?6, ?7, ?8, ?9, ?10, ?11
                 ) ON CONFLICT(workspace_id, idempotency_key) DO NOTHING",
                params![
                    input.workspace_id,
                    input.summary.trim(),
                    decisions,
                    next_actions,
                    changed_paths,
                    input.source.as_str(),
                    input.source_client,
                    input.session_id,
                    input.idempotency_key,
                    now,
                    update_state,
                ],
            )?;
            let id: String = if let Some(key) = input.idempotency_key.as_deref() {
                transaction.query_row(
                    "SELECT id FROM checkpoints WHERE workspace_id = ?1 AND idempotency_key = ?2",
                    params![input.workspace_id, key],
                    |row| row.get(0),
                )?
            } else {
                transaction.query_row(
                    "SELECT id FROM checkpoints WHERE rowid = last_insert_rowid()",
                    [],
                    |row| row.get(0),
                )?
            };
            if inserted == 1 {
                audit_mutation(
                    &transaction,
                    &input.workspace_id,
                    AuditMutation {
                        client: &input.source_client,
                        session_id: input.session_id.as_deref(),
                        capability: "memory:write",
                        action: "checkpoint",
                        target_id: Some(&id),
                        occurred_at: now,
                    },
                )?;
            }
            transaction.commit()?;
            checkpoint_with_connection(&connection, &id)
        })?;
        self.write_checkpoint_working_memory(&checkpoint, update_state)?;
        Ok(checkpoint)
    }

    pub fn checkpoint_by_id(&self, id: &str) -> Result<Checkpoint> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            checkpoint_with_connection(&connection, id)
        })
    }

    pub fn search_checkpoints(&self, query: CheckpointQuery) -> Result<Page<CheckpointSearchHit>> {
        if query.workspace_id.trim().is_empty() {
            return Err(MemoryError::InvalidInput(
                "workspace id cannot be empty".into(),
            ));
        }
        self.run_with_recovery(|| {
            let limit = query.limit.clamp(1, 100);
            let connection = self.connection()?;
            let fts = fts_query(&query.text);
            let (from, filter, excerpt, order, mut values) = if let Some(fts) = fts {
                (
                    "checkpoint_fts JOIN checkpoints c ON c.id = checkpoint_fts.checkpoint_id",
                    "c.workspace_id = ? AND checkpoint_fts MATCH ?",
                    "snippet(checkpoint_fts, 2, '<mark>', '</mark>', '…', 20)",
                    "bm25(checkpoint_fts), c.created_at DESC",
                    vec![Value::Text(query.workspace_id.clone()), Value::Text(fts)],
                )
            } else {
                (
                    "checkpoints c",
                    "c.workspace_id = ?",
                    "substr(c.summary, 1, 240)",
                    "c.created_at DESC",
                    vec![Value::Text(query.workspace_id.clone())],
                )
            };
            let total = connection.query_row(
                &format!("SELECT COUNT(*) FROM {from} WHERE {filter}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )?;
            values.push(i64::from(limit).into());
            values.push(i64::from(query.offset).into());
            let sql = format!(
                "SELECT c.id, c.workspace_id, c.summary, {excerpt}, c.source,
                        c.source_client, c.session_id, c.created_at
             FROM {from} WHERE {filter} ORDER BY {order} LIMIT ? OFFSET ?"
            );
            let mut statement = connection.prepare(&sql)?;
            let items = statement
                .query_map(params_from_iter(values), |row| {
                    let source =
                        MemorySource::parse(row.get(4)?).map_err(to_sql_conversion_error)?;
                    Ok(CheckpointSearchHit {
                        id: row.get(0)?,
                        workspace_id: row.get(1)?,
                        summary: row.get(2)?,
                        excerpt: row.get(3)?,
                        source,
                        source_client: row.get(5)?,
                        session_id: row.get(6)?,
                        created_at: row.get(7)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Page {
                items,
                total,
                limit,
                offset: query.offset,
            })
        })
    }

    pub fn audit(&self, workspace_id: &str, limit: u32) -> Result<Vec<AuditEntry>> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id, workspace_id, client, capability, action, target_id,
                    session_id, result, occurred_at
             FROM mcp_audit WHERE workspace_id = ?1
             ORDER BY occurred_at DESC, rowid DESC LIMIT ?2",
            )?;
            let entries = statement
                .query_map(params![workspace_id, limit.clamp(1, 500)], |row| {
                    Ok(AuditEntry {
                        id: row.get(0)?,
                        workspace_id: row.get(1)?,
                        client: row.get(2)?,
                        capability: row.get(3)?,
                        action: row.get(4)?,
                        target_id: row.get(5)?,
                        session_id: row.get(6)?,
                        result: row.get(7)?,
                        occurred_at: row.get(8)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(entries)
        })
    }

    pub fn audit_page(&self, query: AuditQuery) -> Result<Page<AuditEntry>> {
        if query.workspace_id.trim().is_empty() {
            return Err(MemoryError::InvalidInput(
                "workspace id cannot be empty".into(),
            ));
        }
        validate_no_likely_credential("audit workspace id", &query.workspace_id)?;
        validate_optional_no_likely_credential("audit target", query.target_id.as_deref())?;
        self.run_with_recovery(|| {
            let limit = query.limit.clamp(1, 100);
            let connection = self.connection()?;
            let target_id = query.target_id.as_deref();
            let total = connection.query_row(
                "SELECT COUNT(*) FROM mcp_audit
                 WHERE workspace_id = ?1 AND (?2 IS NULL OR target_id = ?2)",
                params![&query.workspace_id, target_id],
                |row| row.get(0),
            )?;
            let mut statement = connection.prepare(
                "SELECT id, workspace_id, client, capability, action, target_id,
                        session_id, result, occurred_at
                 FROM mcp_audit
                 WHERE workspace_id = ?1 AND (?2 IS NULL OR target_id = ?2)
                 ORDER BY occurred_at DESC, rowid DESC LIMIT ?3 OFFSET ?4",
            )?;
            let items = statement
                .query_map(
                    params![&query.workspace_id, target_id, limit, query.offset],
                    |row| {
                        Ok(AuditEntry {
                            id: row.get(0)?,
                            workspace_id: row.get(1)?,
                            client: row.get(2)?,
                            capability: row.get(3)?,
                            action: row.get(4)?,
                            target_id: row.get(5)?,
                            session_id: row.get(6)?,
                            result: row.get(7)?,
                            occurred_at: row.get(8)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Page {
                items,
                total,
                limit,
                offset: query.offset,
            })
        })
    }

    pub fn export_workspace(&self, workspace_id: &str) -> Result<ExportBundle> {
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            let workspace = workspace_with_connection(&transaction, workspace_id)?;
            let memory_ids = query_ids(
                &transaction,
                "SELECT id FROM memories WHERE workspace_id = ?1 ORDER BY created_at, id",
                workspace_id,
            )?;
            let memories = memory_ids
                .iter()
                .map(|id| memory_with_connection(&transaction, id))
                .collect::<Result<Vec<_>>>()?;
            let checkpoint_ids = query_ids(
                &transaction,
                "SELECT id FROM checkpoints WHERE workspace_id = ?1 ORDER BY created_at, id",
                workspace_id,
            )?;
            let checkpoints = checkpoint_ids
                .iter()
                .map(|id| checkpoint_with_connection(&transaction, id))
                .collect::<Result<Vec<_>>>()?;
            let activity = activity_for_workspace(&transaction, workspace_id)?;
            let audit = audit_for_workspace(&transaction, workspace_id)?;
            let exported_at = now_millis();
            let json = serde_json::to_string_pretty(&WorkspaceExport {
                schema_version: 1,
                exported_at,
                workspace: &workspace,
                memories: &memories,
                checkpoints: &checkpoints,
                activity: &activity,
                audit: &audit,
            })?;
            let markdown = export_markdown(&workspace, &memories, &checkpoints, exported_at);
            transaction.commit()?;
            Ok(ExportBundle { json, markdown })
        })
    }

    pub fn run_retention(
        &self,
        workspace_id: &str,
        now: i64,
        batch_size: u32,
        provenance: MutationProvenance,
    ) -> Result<RetentionReport> {
        validate_no_likely_credential("retention workspace id", workspace_id)?;
        validate_mutation_provenance("retention", &provenance)?;
        let batch_size = batch_size.clamp(1, 10_000);
        self.run_with_recovery(|| {
            self.run_retention_batch(workspace_id, now, batch_size, &provenance)
        })
    }

    pub fn drain_retention(
        &self,
        workspace_id: &str,
        now: i64,
        batch_size: u32,
        max_passes: u32,
        provenance: MutationProvenance,
    ) -> Result<RetentionReport> {
        validate_no_likely_credential("retention workspace id", workspace_id)?;
        validate_mutation_provenance("retention", &provenance)?;
        if max_passes == 0 || max_passes > 10_000 {
            return Err(MemoryError::InvalidInput(
                "retention drain passes must be between 1 and 10000".into(),
            ));
        }
        let batch_size = batch_size.clamp(1, 10_000);
        self.run_with_recovery(|| {
            let mut total = RetentionReport {
                activity_deleted: 0,
                audit_deleted: 0,
                tombstones_deleted: 0,
            };
            for _ in 0..max_passes {
                let report =
                    self.run_retention_batch(workspace_id, now, batch_size, &provenance)?;
                total.activity_deleted = total
                    .activity_deleted
                    .saturating_add(report.activity_deleted);
                total.audit_deleted = total.audit_deleted.saturating_add(report.audit_deleted);
                total.tombstones_deleted = total
                    .tombstones_deleted
                    .saturating_add(report.tombstones_deleted);
                if report.activity_deleted < u64::from(batch_size)
                    && report.audit_deleted < u64::from(batch_size)
                    && report.tombstones_deleted < u64::from(batch_size)
                {
                    return Ok(total);
                }
            }
            Err(MemoryError::InvalidInput(
                "retention did not finish within the bounded pass limit".into(),
            ))
        })
    }

    fn run_retention_batch(
        &self,
        workspace_id: &str,
        now: i64,
        batch_size: u32,
        provenance: &MutationProvenance,
    ) -> Result<RetentionReport> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let workspace = workspace_with_connection(&transaction, workspace_id)?;
        let batch_size = i64::from(batch_size);
        let activity_deleted = transaction.execute(
            "DELETE FROM activity_events WHERE id IN (
                SELECT id FROM activity_events
                WHERE workspace_id = ?1 AND occurred_at < ?2
                ORDER BY occurred_at LIMIT ?3
             )",
            params![
                workspace_id,
                retention_cutoff(now, workspace.activity_retention_days),
                batch_size,
            ],
        )? as u64;
        let audit_deleted = transaction.execute(
            "DELETE FROM mcp_audit WHERE id IN (
                SELECT id FROM mcp_audit
                WHERE workspace_id = ?1 AND occurred_at < ?2
                ORDER BY occurred_at LIMIT ?3
             )",
            params![
                workspace_id,
                retention_cutoff(now, workspace.audit_retention_days),
                batch_size,
            ],
        )? as u64;
        let tombstones_deleted = transaction.execute(
            "DELETE FROM memories WHERE id IN (
                SELECT id FROM memories
                WHERE workspace_id = ?1 AND deleted_at IS NOT NULL AND deleted_at < ?2
                ORDER BY deleted_at LIMIT ?3
             )",
            params![
                workspace_id,
                retention_cutoff(now, workspace.tombstone_retention_days),
                batch_size,
            ],
        )? as u64;
        audit_mutation(
            &transaction,
            workspace_id,
            AuditMutation {
                client: &provenance.source_client,
                session_id: provenance.session_id.as_deref(),
                capability: "memory:write",
                action: "run_retention",
                target_id: None,
                occurred_at: now_millis(),
            },
        )?;
        transaction.commit()?;
        Ok(RetentionReport {
            activity_deleted,
            audit_deleted,
            tombstones_deleted,
        })
    }

    pub fn purge_workspace(&self, workspace_id: &str) -> Result<()> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            // This is deliberately the one mutation without an audit entry:
            // deleting a workspace cascades to mcp_audit, so an inserted purge
            // record would disappear in the same transaction and mislead users.
            let deleted =
                connection.execute("DELETE FROM workspaces WHERE id = ?1", [workspace_id])?;
            if deleted != 1 {
                return Err(MemoryError::WorkspaceNotRegistered(workspace_id.into()));
            }
            Ok(())
        })
    }

    pub fn memory(&self, id: &str) -> Result<MemoryRecord> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            memory_with_connection(&connection, id)
        })
    }

    /// Lists only tombstones still inside this workspace's configured restore window.
    /// Retention removes expired rows in batches; the cutoff also prevents a stale,
    /// not-yet-purged row from being presented as restorable.
    pub fn deleted_memories(&self, workspace_id: &str, limit: u32) -> Result<Vec<MemoryRecord>> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let workspace = workspace_with_connection(&connection, workspace_id)?;
            let ids = query_ids_with_limit(
                &connection,
                "SELECT id FROM memories
                 WHERE workspace_id = ?1 AND deleted_at IS NOT NULL AND deleted_at >= ?2
                 ORDER BY deleted_at DESC, id LIMIT ?3",
                workspace_id,
                retention_cutoff(now_millis(), workspace.tombstone_retention_days),
                limit.clamp(1, 500),
            )?;
            ids.iter()
                .map(|id| memory_with_connection(&connection, id))
                .collect()
        })
    }

    pub fn deleted_memory_page(&self, query: DeletedMemoryQuery) -> Result<Page<MemoryRecord>> {
        if query.workspace_id.trim().is_empty() {
            return Err(MemoryError::InvalidInput(
                "workspace id cannot be empty".into(),
            ));
        }
        validate_no_likely_credential("deleted memory workspace id", &query.workspace_id)?;
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let workspace = workspace_with_connection(&connection, &query.workspace_id)?;
            let cutoff = retention_cutoff(now_millis(), workspace.tombstone_retention_days);
            let limit = query.limit.clamp(1, 100);
            let total = connection.query_row(
                "SELECT COUNT(*) FROM memories
                 WHERE workspace_id = ?1 AND deleted_at IS NOT NULL AND deleted_at >= ?2",
                params![&query.workspace_id, cutoff],
                |row| row.get(0),
            )?;
            let mut statement = connection.prepare(
                "SELECT id FROM memories
                 WHERE workspace_id = ?1 AND deleted_at IS NOT NULL AND deleted_at >= ?2
                 ORDER BY deleted_at DESC, id LIMIT ?3 OFFSET ?4",
            )?;
            let ids = statement
                .query_map(
                    params![&query.workspace_id, cutoff, limit, query.offset],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let items = ids
                .iter()
                .map(|id| memory_with_connection(&connection, id))
                .collect::<Result<Vec<_>>>()?;
            Ok(Page {
                items,
                total,
                limit,
                offset: query.offset,
            })
        })
    }

    pub fn search(&self, query: MemoryQuery) -> Result<Page<MemorySearchHit>> {
        if query.workspace_id.trim().is_empty() {
            return Err(MemoryError::InvalidInput(
                "workspace id cannot be empty".into(),
            ));
        }
        if query.offset > SEARCH_OFFSET_LIMIT {
            return Err(MemoryError::InvalidInput(format!(
                "memory search offset cannot exceed {SEARCH_OFFSET_LIMIT}"
            )));
        }
        if !matches!(self.access, StoreAccess::ReadOnly)
            && self.working_memory_status(&query.workspace_id)?.is_some()
        {
            self.sync_working_memory(&query.workspace_id)?;
        }
        let project_refresh = self.refresh_project_knowledge(&query.workspace_id)?;
        self.run_with_recovery(|| {
            let limit = query.limit.clamp(1, 100);
            let needed = query.offset.saturating_add(limit);
            let (database_items, database_total) = {
                let mut items = Vec::new();
                let mut offset = 0_u32;
                loop {
                    let mut database_query = query.clone();
                    database_query.limit = needed.saturating_sub(offset).clamp(1, 100);
                    database_query.offset = offset;
                    let page = self.search_database_once(&database_query)?;
                    let page_len = page.items.len() as u32;
                    offset = offset.saturating_add(page_len);
                    items.extend(page.items);
                    if offset >= needed || u64::from(offset) >= page.total || page_len == 0 {
                        break (items, page.total);
                    }
                }
            };
            let (file_items, file_total) = {
                let mut items = Vec::new();
                let mut offset = 0_u32;
                loop {
                    let mut file_query = query.clone();
                    file_query.limit = needed.saturating_sub(offset).clamp(1, 100);
                    file_query.offset = offset;
                    let page = self.working_memory_search_hits(&file_query)?;
                    let page_len = page.items.len() as u32;
                    offset = offset.saturating_add(page_len);
                    items.extend(page.items);
                    if offset >= needed || u64::from(offset) >= page.total || page_len == 0 {
                        break (items, page.total);
                    }
                }
            };
            let (project_items, project_total) = {
                let mut items = Vec::new();
                let mut offset = 0_u32;
                loop {
                    let mut project_query = query.clone();
                    project_query.limit = needed.saturating_sub(offset).clamp(1, 100);
                    project_query.offset = offset;
                    let page = self
                        .project_knowledge_search_hits(&project_query, project_refresh.as_ref())?;
                    let page_len = page.items.len() as u32;
                    offset = offset.saturating_add(page_len);
                    items.extend(page.items);
                    if offset >= needed || u64::from(offset) >= page.total || page_len == 0 {
                        break (items, page.total);
                    }
                }
            };
            let mut items = if query.text.trim().is_empty() {
                let mut merged = project_items;
                merged.extend(file_items);
                merged.extend(database_items);
                merged.sort_by(|left, right| {
                    right
                        .updated_at
                        .cmp(&left.updated_at)
                        .then_with(|| left.id.cmp(&right.id))
                });
                merged
            } else {
                interleave_ranked(project_items, interleave_ranked(file_items, database_items))
            };
            let total = project_total
                .saturating_add(file_total)
                .saturating_add(database_total);
            let start = (query.offset as usize).min(items.len());
            let end = start.saturating_add(limit as usize).min(items.len());
            let page_items = items.drain(start..end).collect();
            Ok(Page {
                items: page_items,
                total,
                limit,
                offset: query.offset,
            })
        })
    }

    fn search_database_once(&self, query: &MemoryQuery) -> Result<Page<MemorySearchHit>> {
        let limit = query.limit.clamp(1, 100);
        let connection = self.connection()?;
        let fts_query = fts_query(&query.text);
        let mut values = Vec::<Value>::new();
        let mut filters = String::from("m.workspace_id = ? AND m.deleted_at IS NULL");
        values.push(query.workspace_id.clone().into());
        if !query.kinds.is_empty() {
            filters.push_str(" AND m.kind IN (");
            filters.push_str(&placeholders(query.kinds.len()));
            filters.push(')');
            values.extend(
                query
                    .kinds
                    .iter()
                    .map(|kind| Value::Text(kind.as_str().into())),
            );
        }
        if !query.sources.is_empty() {
            filters.push_str(" AND m.source IN (");
            filters.push_str(&placeholders(query.sources.len()));
            filters.push(')');
            values.extend(
                query
                    .sources
                    .iter()
                    .map(|source| Value::Text(source.as_str().into())),
            );
        }
        if let Some(updated_after) = query.updated_after {
            filters.push_str(" AND m.updated_at >= ?");
            values.push(updated_after.into());
        }

        let (from, excerpt, order) = if let Some(fts_query) = fts_query {
            filters.push_str(" AND memory_fts MATCH ?");
            values.push(fts_query.into());
            (
                "memory_fts JOIN memories m ON m.id = memory_fts.memory_id",
                "snippet(memory_fts, 3, '<mark>', '</mark>', '…', 20)",
                "bm25(memory_fts), m.updated_at DESC, m.id",
            )
        } else {
            (
                "memories m",
                "substr(m.body, 1, 240)",
                "m.updated_at DESC, m.id",
            )
        };
        let count_sql = format!("SELECT COUNT(*) FROM {from} WHERE {filters}");
        let total: u64 =
            connection.query_row(&count_sql, params_from_iter(values.iter()), |row| {
                row.get(0)
            })?;

        let select_sql = format!(
            "SELECT m.id, m.workspace_id, m.kind, m.title, {excerpt}, m.source,
                    m.pinned, m.version, m.updated_at
             FROM {from} WHERE {filters}
             ORDER BY {order} LIMIT ? OFFSET ?"
        );
        let mut page_values = values;
        page_values.push(i64::from(limit).into());
        page_values.push(i64::from(query.offset).into());
        let mut statement = connection.prepare(&select_sql)?;
        let rows = statement.query_map(params_from_iter(page_values), |row| {
            let kind = MemoryKind::parse(row.get(2)?).map_err(to_sql_conversion_error)?;
            let source = MemorySource::parse(row.get(5)?).map_err(to_sql_conversion_error)?;
            Ok(MemorySearchHit {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                kind,
                title: row.get(3)?,
                excerpt: row.get(4)?,
                source,
                pinned: row.get(6)?,
                version: row.get(7)?,
                updated_at: row.get(8)?,
                file_path: None,
                project_source: None,
            })
        })?;
        let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Page {
            items,
            total,
            limit,
            offset: query.offset,
        })
    }

    fn workspace_by_root(&self, canonical_root: &str) -> Result<Workspace> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, canonical_root, display_name, color, capture_paused,
                        activity_retention_days, audit_retention_days,
                        tombstone_retention_days, created_at, updated_at
                 FROM workspaces WHERE canonical_root = ?1",
                [canonical_root],
                workspace_from_row,
            )
            .map_err(Into::into)
    }

    fn connection(&self) -> Result<LockedConnection> {
        // Corruption must unwind every shared connection before recovery takes
        // the exclusive lock; recovering here would attempt a lock upgrade.
        self.checked_connection()
    }

    fn run_with_recovery<T>(&self, mut operation: impl FnMut() -> Result<T>) -> Result<T> {
        if matches!(self.access, StoreAccess::ReadOnly) {
            return operation();
        }
        let mut recovered = false;
        let mut busy_attempt = 0_u32;
        loop {
            match operation() {
                Err(error) if is_corruption(&error) && !recovered => {
                    self.recover_corrupt_database()?;
                    recovered = true;
                }
                Err(error) if is_database_busy(&error) && busy_attempt < 6 => {
                    let delay = 10_u64 << busy_attempt;
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                    busy_attempt += 1;
                }
                result => return result,
            }
        }
    }

    fn checked_connection(&self) -> Result<LockedConnection> {
        let connection = self.open_locked_connection()?;
        connection.query_row("PRAGMA schema_version", [], |_| Ok(()))?;
        Ok(connection)
    }

    fn open_locked_connection(&self) -> Result<LockedConnection> {
        if matches!(self.access, StoreAccess::ReadOnly) {
            return Ok(LockedConnection {
                connection: Some(self.open_connection()?),
                recovery_lock: None,
            });
        }
        let recovery_lock = self.open_recovery_lock()?;
        recovery_lock.lock_shared()?;
        let connection = self.open_connection()?;
        Ok(LockedConnection {
            connection: Some(connection),
            recovery_lock: Some(recovery_lock),
        })
    }

    fn open_recovery_lock(&self) -> Result<File> {
        let lock_path = PathBuf::from(format!("{}.recovery.lock", self.path.display()));
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(Into::into)
    }

    fn open_connection(&self) -> Result<Connection> {
        let connection = match self.access {
            StoreAccess::Writable { .. } => Connection::open(&self.path)?,
            StoreAccess::ReadOnly => Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?,
        };
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(connection)
    }
}

fn validate_memory(input: &NewMemory, title_limit: usize) -> Result<()> {
    if input.workspace_id.trim().is_empty() {
        return Err(MemoryError::InvalidInput(
            "workspace id cannot be empty".into(),
        ));
    }
    validate_no_likely_credential("memory workspace id", &input.workspace_id)?;
    validate_memory_fields(&input.title, &input.body, &input.source_client, title_limit)?;
    validate_optional_no_likely_credential("memory session id", input.session_id.as_deref())?;
    validate_optional_no_likely_credential(
        "memory idempotency key",
        input.idempotency_key.as_deref(),
    )?;
    validate_memory_links(&input.links)
}

fn validate_memory_fields(
    title: &str,
    body: &str,
    source_client: &str,
    title_limit: usize,
) -> Result<()> {
    if title.trim().is_empty() || title.chars().count() > title_limit {
        return Err(MemoryError::InvalidInput(format!(
            "memory title must be between 1 and {title_limit} characters"
        )));
    }
    if body.len() > 256 * 1024 {
        return Err(MemoryError::InvalidInput(
            "memory body exceeds the 256 KiB limit".into(),
        ));
    }
    validate_no_likely_credential("memory title", title)?;
    validate_no_likely_credential("memory body", body)?;
    validate_source_client("memory", source_client)?;
    Ok(())
}

fn validate_memory_revision(input: &MemoryRevision, title_limit: usize) -> Result<()> {
    validate_no_likely_credential("memory id", &input.id)?;
    validate_memory_fields(&input.title, &input.body, &input.source_client, title_limit)?;
    validate_optional_no_likely_credential("memory session id", input.session_id.as_deref())?;
    validate_memory_links(&input.links)
}

fn validate_memory_links(links: &[MemoryLink]) -> Result<()> {
    for link in links {
        validate_no_likely_credential("memory link target", &link.target_id)?;
        validate_no_likely_credential("memory link relation", &link.relation)?;
        let relation = link.relation.trim();
        if relation.is_empty() || relation.chars().count() > 80 {
            return Err(MemoryError::InvalidInput(
                "memory link relation must be between 1 and 80 characters".into(),
            ));
        }
    }
    Ok(())
}

fn validate_source_client(scope: &str, source_client: &str) -> Result<()> {
    if source_client.trim().is_empty() {
        return Err(MemoryError::InvalidInput(format!(
            "{scope} source client cannot be empty"
        )));
    }
    validate_no_likely_credential(&format!("{scope} source client"), source_client)
}

fn validate_optional_no_likely_credential(field: &str, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        validate_no_likely_credential(field, value)?;
    }
    Ok(())
}

fn validate_mutation_provenance(scope: &str, provenance: &MutationProvenance) -> Result<()> {
    validate_source_client(scope, &provenance.source_client)?;
    validate_optional_no_likely_credential(
        &format!("{scope} session id"),
        provenance.session_id.as_deref(),
    )
}

fn validate_audit_metadata(
    workspace_id: &str,
    client: &str,
    session_id: Option<&str>,
    capability: &str,
    action: &str,
    target_id: Option<&str>,
) -> Result<()> {
    validate_no_likely_credential("audit workspace id", workspace_id)?;
    validate_source_client("audit", client)?;
    validate_optional_no_likely_credential("audit session id", session_id)?;
    validate_no_likely_credential("audit capability", capability)?;
    validate_no_likely_credential("audit action", action)?;
    validate_optional_no_likely_credential("audit target", target_id)
}

fn validate_no_likely_credential(field: &str, value: &str) -> Result<()> {
    if contains_likely_credential(value) {
        return Err(MemoryError::InvalidInput(format!(
            "{field} contains likely credential material"
        )));
    }
    Ok(())
}

fn insert_links(
    transaction: &rusqlite::Transaction<'_>,
    source_id: &str,
    workspace_id: &str,
    links: &[MemoryLink],
    now: i64,
) -> Result<()> {
    for link in links {
        let relation = link.relation.trim();
        if relation.is_empty() || relation.chars().count() > 80 {
            return Err(MemoryError::InvalidInput(
                "memory link relation must be between 1 and 80 characters".into(),
            ));
        }
        let inserted = transaction.execute(
            "INSERT INTO memory_links(source_id, target_id, relation, created_at)
             SELECT ?1, target.id, ?3, ?4
             FROM memories target
             WHERE target.id = ?2 AND target.workspace_id = ?5
                   AND target.deleted_at IS NULL",
            params![source_id, link.target_id, relation, now, workspace_id],
        )?;
        if inserted != 1 {
            return Err(MemoryError::InvalidInput(format!(
                "linked memory is not in the workspace: {}",
                link.target_id
            )));
        }
    }
    Ok(())
}

struct AuditMutation<'a> {
    client: &'a str,
    session_id: Option<&'a str>,
    capability: &'a str,
    action: &'a str,
    target_id: Option<&'a str>,
    occurred_at: i64,
}

fn audit_mutation(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    mutation: AuditMutation<'_>,
) -> Result<()> {
    validate_audit_metadata(
        workspace_id,
        mutation.client,
        mutation.session_id,
        mutation.capability,
        mutation.action,
        mutation.target_id,
    )?;
    transaction.execute(
        "INSERT INTO mcp_audit (
            id, workspace_id, client, capability, action, target_id, session_id, result, occurred_at
         ) VALUES (
            'audit_' || lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, 'ok', ?7
         )",
        params![
            workspace_id,
            mutation.client,
            mutation.capability,
            mutation.action,
            mutation.target_id,
            mutation.session_id,
            mutation.occurred_at
        ],
    )?;
    Ok(())
}

fn query_ids(connection: &Connection, sql: &str, workspace_id: &str) -> Result<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let ids = statement
        .query_map([workspace_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

fn memories_for_query(
    connection: &Connection,
    sql: &str,
    workspace_id: &str,
) -> Result<Vec<MemoryRecord>> {
    query_ids(connection, sql, workspace_id)?
        .iter()
        .map(|id| memory_with_connection(connection, id))
        .collect()
}

fn query_ids_with_limit(
    connection: &Connection,
    sql: &str,
    workspace_id: &str,
    cutoff: i64,
    limit: u32,
) -> Result<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let ids = statement
        .query_map(params![workspace_id, cutoff, limit], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

fn workspace_with_connection(connection: &Connection, id: &str) -> Result<Workspace> {
    connection
        .query_row(
            "SELECT id, canonical_root, display_name, color, capture_paused,
                    activity_retention_days, audit_retention_days,
                    tombstone_retention_days, created_at, updated_at
             FROM workspaces WHERE id = ?1",
            [id],
            workspace_from_row,
        )
        .optional()?
        .ok_or_else(|| MemoryError::WorkspaceNotRegistered(id.into()))
}

fn memory_with_connection(connection: &Connection, id: &str) -> Result<MemoryRecord> {
    let mut record = connection
        .query_row(
            "SELECT id, workspace_id, kind, title, body, source, source_client,
                    session_id, pinned, version, created_at, updated_at, deleted_at
             FROM memories WHERE id = ?1",
            [id],
            memory_from_row,
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(id.into()))?;
    record.links = memory_links(connection, id, false)?;
    record.backlinks = memory_links(connection, id, true)?;
    Ok(record)
}

fn checkpoint_with_connection(connection: &Connection, id: &str) -> Result<Checkpoint> {
    let raw = connection
        .query_row(
            "SELECT id, workspace_id, summary, decisions_json, next_actions_json,
                    changed_paths_json, source, source_client, session_id, created_at
             FROM checkpoints WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(id.into()))?;
    Ok(Checkpoint {
        id: raw.0,
        workspace_id: raw.1,
        summary: raw.2,
        decisions: serde_json::from_str(&raw.3)?,
        next_actions: serde_json::from_str(&raw.4)?,
        changed_paths: serde_json::from_str(&raw.5)?,
        source: MemorySource::parse(raw.6)?,
        source_client: raw.7,
        session_id: raw.8,
        created_at: raw.9,
    })
}

fn activity_for_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Vec<ActivityEvent>> {
    let mut statement = connection.prepare(
        "SELECT id, workspace_id, kind, source, session_id, relative_path,
                provider, occurred_at, sequence
         FROM activity_events WHERE workspace_id = ?1 ORDER BY occurred_at, sequence",
    )?;
    let activity = statement
        .query_map([workspace_id], |row| {
            let kind = ActivityKind::parse(row.get(2)?).map_err(to_sql_conversion_error)?;
            Ok(ActivityEvent {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                sequence: row.get(8)?,
                kind,
                source: row.get(3)?,
                session_id: row.get(4)?,
                relative_path: row.get(5)?,
                provider: row.get(6)?,
                occurred_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(activity)
}

fn audit_for_workspace(connection: &Connection, workspace_id: &str) -> Result<Vec<AuditEntry>> {
    let mut statement = connection.prepare(
        "SELECT id, workspace_id, client, capability, action, target_id,
                session_id, result, occurred_at
         FROM mcp_audit WHERE workspace_id = ?1 ORDER BY occurred_at, rowid",
    )?;
    let entries = statement
        .query_map([workspace_id], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                client: row.get(2)?,
                capability: row.get(3)?,
                action: row.get(4)?,
                target_id: row.get(5)?,
                session_id: row.get(6)?,
                result: row.get(7)?,
                occurred_at: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(entries)
}

fn export_markdown(
    workspace: &Workspace,
    memories: &[MemoryRecord],
    checkpoints: &[Checkpoint],
    exported_at: i64,
) -> String {
    let mut output = format!(
        "# {}\n\n- Workspace ID: `{}`\n- Root: `{}`\n- Exported at: `{exported_at}`\n\n## Memories\n\n",
        single_line(&workspace.display_name),
        workspace.id,
        workspace.canonical_root,
    );
    for memory in memories {
        output.push_str(&format!(
            "### {}\n\n- ID: `{}`\n- Type: `{}`\n- Source: `{}` / `{}`\n- Version: `{}`{}\n\n{}\n\n",
            single_line(&memory.title),
            memory.id,
            memory.kind.as_str(),
            memory.source.as_str(),
            memory.source_client,
            memory.version,
            memory
                .deleted_at
                .map(|timestamp| format!("\n- Deleted at: `{timestamp}`"))
                .unwrap_or_default(),
            memory.body,
        ));
    }
    output.push_str("## Checkpoints\n\n");
    for checkpoint in checkpoints {
        output.push_str(&format!(
            "### Checkpoint `{}`\n\n{}\n\n",
            checkpoint.id, checkpoint.summary
        ));
        if !checkpoint.decisions.is_empty() {
            output.push_str("Decisions:\n\n");
            for decision in &checkpoint.decisions {
                output.push_str(&format!("- {}\n", single_line(decision)));
            }
            output.push('\n');
        }
        if !checkpoint.next_actions.is_empty() {
            output.push_str("Next actions:\n\n");
            for action in &checkpoint.next_actions {
                output.push_str(&format!("- {}\n", single_line(action)));
            }
            output.push('\n');
        }
    }
    output
}

fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn retention_cutoff(now: i64, days: u32) -> i64 {
    now.saturating_sub(i64::from(days).saturating_mul(24 * 60 * 60 * 1000))
}

fn validate_checkpoint(input: &NewCheckpoint) -> Result<()> {
    if input.workspace_id.trim().is_empty() {
        return Err(MemoryError::InvalidInput(
            "workspace id cannot be empty".into(),
        ));
    }
    if input.summary.trim().is_empty() || input.summary.len() > 64 * 1024 {
        return Err(MemoryError::InvalidInput(
            "checkpoint summary must be between 1 byte and 64 KiB".into(),
        ));
    }
    validate_no_likely_credential("checkpoint workspace id", &input.workspace_id)?;
    validate_source_client("checkpoint", &input.source_client)?;
    validate_optional_no_likely_credential("checkpoint session id", input.session_id.as_deref())?;
    validate_optional_no_likely_credential(
        "checkpoint idempotency key",
        input.idempotency_key.as_deref(),
    )?;
    if input.decisions.len() > 100
        || input.next_actions.len() > 100
        || input.changed_paths.len() > 500
    {
        return Err(MemoryError::InvalidInput(
            "checkpoint item limit exceeded".into(),
        ));
    }
    if std::iter::once(input.summary.as_str())
        .chain(input.decisions.iter().map(String::as_str))
        .chain(input.next_actions.iter().map(String::as_str))
        .chain(input.changed_paths.iter().map(String::as_str))
        .any(contains_likely_credential)
    {
        return Err(MemoryError::InvalidInput(
            "checkpoint contains likely credential material".into(),
        ));
    }
    for path in &input.changed_paths {
        if !is_confined_relative_path(path) {
            return Err(MemoryError::InvalidInput(format!(
                "checkpoint path must stay relative to the workspace: {path}"
            )));
        }
        validate_no_likely_credential("checkpoint changed path", path)?;
    }
    Ok(())
}

fn is_confined_relative_path(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.as_bytes().get(1) == Some(&b':')
    {
        return false;
    }
    !trimmed
        .split(['/', '\\'])
        .any(|component| component == ".." || component.is_empty())
}

fn contains_likely_credential(value: &str) -> bool {
    if serde_json::from_str::<serde_json::Value>(value.trim())
        .is_ok_and(|json| json_contains_likely_credential(&json))
    {
        return true;
    }
    contains_likely_credential_text(value)
}

fn json_contains_likely_credential(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(fields) => fields.iter().any(|(key, value)| {
            let normalized_key = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            let assigned_credential = if normalized_key == "authorization" {
                value
                    .as_str()
                    .is_some_and(contains_authorization_scheme_credential)
            } else if is_suspicious_secret_key(key) {
                json_scalar(value).is_some_and(|assigned| {
                    !assigned.is_empty() && !is_placeholder_value(&assigned)
                })
            } else {
                false
            };
            assigned_credential || json_contains_likely_credential(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(json_contains_likely_credential),
        serde_json::Value::String(value) => contains_likely_credential_text(value),
        _ => false,
    }
}

fn json_scalar(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => Some(value.trim().to_owned()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn contains_likely_credential_text(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    // Split the markers so source-secret scanners do not mistake the detector for a key.
    let private_key_markers = [
        concat!("-----BEGIN ", "PRIVATE KEY-----"),
        concat!("-----BEGIN RSA ", "PRIVATE KEY-----"),
        concat!("-----BEGIN OPENSSH ", "PRIVATE KEY-----"),
        concat!("-----BEGIN EC ", "PRIVATE KEY-----"),
    ];
    if private_key_markers
        .iter()
        .any(|marker| upper.contains(marker))
    {
        return true;
    }
    contains_known_credential_token(value)
        || contains_authorization_credential(value)
        || contains_jwt_bearer(value)
        || contains_uri_userinfo_credential(value)
        || contains_suspicious_assignment(value)
}

// This is deliberately conservative rather than pretending arbitrary prose can
// be classified perfectly. We reject well-known credential forms and values
// assigned to credential-shaped keys, while accepting explicit template values.
fn contains_known_credential_token(value: &str) -> bool {
    const PREFIXES: [(&str, usize); 13] = [
        ("ghp_", 24),
        ("gho_", 24),
        ("ghu_", 24),
        ("ghs_", 24),
        ("ghr_", 24),
        ("github_pat_", 30),
        ("sk-", 23),
        ("xoxb-", 20),
        ("xoxp-", 20),
        ("xoxa-", 20),
        ("xoxr-", 20),
        ("xoxs-", 20),
        ("AKIA", 20),
    ];
    value.char_indices().any(|(start, _)| {
        PREFIXES
            .iter()
            .any(|(prefix, minimum)| credential_token_at(value, start, prefix, *minimum))
            || credential_token_at(value, start, "ASIA", 20)
    })
}

fn contains_jwt_bearer(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(relative_index) = lower[search_from..].find("bearer") {
        let bearer = search_from + relative_index;
        search_from = bearer + "bearer".len();
        if !has_word_boundaries(value, bearer, "bearer".len()) {
            continue;
        }
        let candidate = authorization_value(&value[search_from..]);
        let segments = candidate.split('.').collect::<Vec<_>>();
        if segments.len() == 3
            && segments[0].starts_with("eyJ")
            && segments.iter().all(|segment| {
                segment.len() >= 8
                    && segment
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            })
        {
            return true;
        }
    }
    false
}

// A credential-like Bearer or Basic value is unsafe when it is attached to an
// authorization header. Unlike raw prose about bearer tokens, that shape is a
// concrete request credential even if an OAuth provider makes the value opaque.
fn contains_authorization_credential(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(relative_index) = lower[search_from..].find("authorization") {
        let authorization = search_from + relative_index;
        search_from = authorization + "authorization".len();
        if !has_word_boundaries(value, authorization, "authorization".len()) {
            continue;
        }
        let after_header = trim_serialized_quotes(&value[search_from..]);
        let Some(after_separator) = after_header
            .strip_prefix(':')
            .or_else(|| after_header.strip_prefix('='))
        else {
            continue;
        };
        let credentials = trim_serialized_quotes(after_separator);
        if contains_authorization_scheme_credential(credentials) {
            return true;
        }
    }
    false
}

fn contains_authorization_scheme_credential(value: &str) -> bool {
    let credentials = trim_serialized_quotes(value);
    let lower_credentials = credentials.to_ascii_lowercase();
    for scheme in ["bearer", "basic"] {
        let Some(after_scheme) = lower_credentials.strip_prefix(scheme) else {
            continue;
        };
        if !after_scheme.chars().next().is_some_and(char::is_whitespace) {
            continue;
        }
        let scheme_value = &credentials[scheme.len()..];
        let candidate = authorization_value(scheme_value);
        if !candidate.is_empty()
            && !is_placeholder_value(candidate)
            && !is_authorization_explanatory_prose(scheme_value)
        {
            return true;
        }
    }
    false
}

fn is_authorization_explanatory_prose(value: &str) -> bool {
    let mut words = value.split_whitespace().map(|word| {
        word.trim_matches(|character: char| !character.is_ascii_alphabetic())
            .to_ascii_lowercase()
    });
    let first = words.next().unwrap_or_default();
    let second = words.next().unwrap_or_default();
    matches!(
        (first.as_str(), second.as_str()),
        ("authentication", "is" | "uses" | "means" | "refers")
            | ("authorization", "is" | "uses" | "means" | "refers")
            | ("tokens", "are" | "use")
            | ("credentials", "are" | "use")
            | ("scheme", "is" | "uses")
    )
}

// JSON, JavaScript object literals, and serialized snippets commonly quote both
// the Authorization key and its value. Accept only those narrow wrappers before
// requiring a real header separator, so prose about authorization still passes.
fn trim_serialized_quotes(value: &str) -> &str {
    let mut remaining = value.trim_start_matches(char::is_whitespace);
    loop {
        let next = remaining.strip_prefix(['\'', '\"']).or_else(|| {
            remaining
                .strip_prefix('\\')
                .and_then(|rest| rest.strip_prefix(['\'', '\"']))
        });
        let Some(next) = next else {
            return remaining;
        };
        remaining = next.trim_start_matches(char::is_whitespace);
    }
}

fn has_word_boundaries(value: &str, start: usize, len: usize) -> bool {
    let before = value[..start].chars().next_back();
    let after = value[start + len..].chars().next();
    !before.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        && !after.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn authorization_value(value: &str) -> &str {
    value
        .trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == ':')
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_matches(|ch: char| matches!(ch, '\\' | '\'' | '\"' | ',' | ';' | ')' | ']' | '}'))
}

fn contains_uri_userinfo_credential(value: &str) -> bool {
    let mut remainder = value;
    while let Some(scheme) = remainder.find("://") {
        let authority = &remainder[scheme + 3..]
            .split(['/', '\\', '?', '#', ' ', '\n', '\r'])
            .next()
            .unwrap_or_default();
        if let Some((userinfo, _host)) = authority.rsplit_once('@') {
            if let Some((user, password)) = userinfo.split_once(':') {
                if !user.is_empty() && !password.is_empty() && !is_placeholder_value(password) {
                    return true;
                }
            }
        }
        remainder = &remainder[scheme + 3..];
    }
    false
}

fn contains_suspicious_assignment(value: &str) -> bool {
    for (index, character) in value.char_indices() {
        if character != '=' && character != ':' {
            continue;
        }
        let key = value[..index]
            .rsplit(['\n', '\r', ' ', '\t', ',', ';', '{', '['])
            .next()
            .unwrap_or_default()
            .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-');
        if !is_suspicious_secret_key(key) {
            continue;
        }
        let assigned = value[index + character.len_utf8()..]
            .trim_start()
            .trim_start_matches(['\"', '\''])
            .split(['\n', '\r', ' ', '\t', ',', ';', '&', ')', ']'])
            .next()
            .unwrap_or_default()
            .trim_matches(|ch: char| ch == '\"' || ch == '\'');
        if !assigned.is_empty() && !is_placeholder_value(assigned) {
            return true;
        }
    }
    false
}

fn is_suspicious_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "credential",
        "apikey",
        "accesskey",
        "privatekey",
        "databaseurl",
        "connectionstring",
    ]
    .iter()
    .any(|secret_key| normalized == *secret_key || normalized.ends_with(secret_key))
}

fn is_placeholder_value(value: &str) -> bool {
    let trimmed = value.trim();
    if (trimmed.starts_with("${") && trimmed.ends_with('}'))
        || (trimmed.starts_with("{{") && trimmed.ends_with("}}"))
        || (trimmed.starts_with('<') && trimmed.ends_with('>'))
    {
        return true;
    }
    let normalized = trimmed
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "placeholder"
            | "example"
            | "demo"
            | "redacted"
            | "yourtoken"
            | "yourapikey"
            | "yourpassword"
            | "replacewithtoken"
            | "replacewithvalue"
            | "changeme"
    )
}

fn credential_token_at(value: &str, start: usize, prefix: &str, minimum: usize) -> bool {
    let candidate = &value[start..];
    if !candidate.starts_with(prefix) {
        return false;
    }
    if value[..start]
        .chars()
        .next_back()
        .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return false;
    }
    candidate
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .count()
        >= minimum
}

fn migrate(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
         );",
    )?;

    let newest: Option<u32> =
        transaction.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })?;
    if newest.is_some_and(|version| version > MEMORY_SCHEMA_VERSION) {
        return Err(MemoryError::InvalidInput(format!(
            "memory database schema {} is newer than this Kodade build supports",
            newest.unwrap_or_default()
        )));
    }

    apply_migration(
        &transaction,
        1,
        "CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            canonical_root TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            color TEXT,
            capture_paused INTEGER NOT NULL DEFAULT 0 CHECK (capture_paused IN (0, 1)),
            activity_retention_days INTEGER NOT NULL DEFAULT 30,
            audit_retention_days INTEGER NOT NULL DEFAULT 30,
            tombstone_retention_days INTEGER NOT NULL DEFAULT 30,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('summary', 'decision', 'task', 'fact', 'preference')),
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('user', 'kodade', 'agent')),
            source_client TEXT NOT NULL,
            session_id TEXT,
            pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
            version INTEGER NOT NULL DEFAULT 1,
            idempotency_key TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            UNIQUE(workspace_id, idempotency_key)
         );",
    )?;
    apply_migration(
        &transaction,
        2,
        "CREATE VIRTUAL TABLE memory_fts USING fts5(
            memory_id UNINDEXED,
            workspace_id UNINDEXED,
            title,
            body,
            tokenize = 'unicode61'
         );
         CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories
         WHEN new.deleted_at IS NULL BEGIN
            INSERT INTO memory_fts(memory_id, workspace_id, title, body)
            VALUES (new.id, new.workspace_id, new.title, new.body);
         END;
         CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
            DELETE FROM memory_fts WHERE memory_id = old.id;
            INSERT INTO memory_fts(memory_id, workspace_id, title, body)
            SELECT new.id, new.workspace_id, new.title, new.body
            WHERE new.deleted_at IS NULL;
         END;
         CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
            DELETE FROM memory_fts WHERE memory_id = old.id;
         END;
         INSERT INTO memory_fts(memory_id, workspace_id, title, body)
         SELECT id, workspace_id, title, body FROM memories WHERE deleted_at IS NULL;",
    )?;
    apply_migration(
        &transaction,
        3,
        "CREATE TABLE memory_links (
            source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            relation TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(source_id, target_id, relation),
            CHECK(source_id <> target_id)
         );
         CREATE INDEX memory_links_target_idx ON memory_links(target_id);",
    )?;
    apply_migration(
        &transaction,
        4,
        "CREATE TABLE checkpoints (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            summary TEXT NOT NULL,
            decisions_json TEXT NOT NULL,
            next_actions_json TEXT NOT NULL,
            changed_paths_json TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('user', 'kodade', 'agent')),
            source_client TEXT NOT NULL,
            session_id TEXT,
            idempotency_key TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(workspace_id, idempotency_key)
         );
         CREATE INDEX checkpoints_workspace_created_idx
            ON checkpoints(workspace_id, created_at DESC);
         CREATE VIRTUAL TABLE checkpoint_fts USING fts5(
            checkpoint_id UNINDEXED,
            workspace_id UNINDEXED,
            summary,
            tokenize = 'unicode61'
         );
         CREATE TRIGGER checkpoints_fts_insert AFTER INSERT ON checkpoints BEGIN
            INSERT INTO checkpoint_fts(checkpoint_id, workspace_id, summary)
            VALUES (new.id, new.workspace_id, new.summary);
         END;
         CREATE TRIGGER checkpoints_fts_delete AFTER DELETE ON checkpoints BEGIN
            DELETE FROM checkpoint_fts WHERE checkpoint_id = old.id;
         END;",
    )?;
    apply_migration(
        &transaction,
        5,
        "CREATE TABLE activity_events (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN (
                'project_opened', 'project_closed', 'session_started', 'session_exited',
                'active', 'idle', 'file_opened', 'file_saved', 'provider_launched'
            )),
            source TEXT NOT NULL,
            session_id TEXT,
            relative_path TEXT,
            provider TEXT,
            occurred_at INTEGER NOT NULL
         );
         CREATE INDEX activity_workspace_time_idx
            ON activity_events(workspace_id, occurred_at DESC);
         CREATE TABLE mcp_audit (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            client TEXT NOT NULL,
            capability TEXT NOT NULL,
            action TEXT NOT NULL,
            target_id TEXT,
            result TEXT NOT NULL,
            occurred_at INTEGER NOT NULL
         );
         CREATE INDEX audit_workspace_time_idx
            ON mcp_audit(workspace_id, occurred_at DESC);",
    )?;
    apply_migration(
        &transaction,
        6,
        "ALTER TABLE mcp_audit ADD COLUMN session_id TEXT;",
    )?;
    apply_migration(
        &transaction,
        7,
        "ALTER TABLE activity_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
         UPDATE activity_events
         SET sequence = (
            SELECT COUNT(*) FROM activity_events AS earlier
            WHERE earlier.workspace_id = activity_events.workspace_id
              AND (
                earlier.occurred_at < activity_events.occurred_at
                OR (
                    earlier.occurred_at = activity_events.occurred_at
                    AND earlier.rowid <= activity_events.rowid
                )
              )
         );
         CREATE UNIQUE INDEX activity_workspace_sequence_idx
            ON activity_events(workspace_id, sequence);
         CREATE INDEX activity_workspace_time_sequence_idx
            ON activity_events(workspace_id, occurred_at DESC, sequence DESC);
         CREATE TABLE activity_workspace_sequences (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            next_sequence INTEGER NOT NULL
         );
         INSERT INTO activity_workspace_sequences(workspace_id, next_sequence)
         SELECT workspace_id, MAX(sequence)
         FROM activity_events
         GROUP BY workspace_id;",
    )?;
    apply_migration(
        &transaction,
        8,
        "CREATE TABLE working_memory_config (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            mode TEXT NOT NULL CHECK (mode IN ('commit', 'local')),
            activated_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_indexed_at INTEGER,
            last_commit TEXT
         );
         CREATE TABLE working_memory_files (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('summary', 'decision')),
            updated_at INTEGER NOT NULL,
            UNIQUE(workspace_id, relative_path)
         );
         CREATE INDEX working_memory_files_workspace_idx
            ON working_memory_files(workspace_id, updated_at DESC);
         CREATE VIRTUAL TABLE working_memory_fts USING fts5(
            file_id UNINDEXED,
            workspace_id UNINDEXED,
            title,
            body,
            tokenize = 'unicode61'
         );
         CREATE TRIGGER working_memory_fts_insert AFTER INSERT ON working_memory_files BEGIN
            INSERT INTO working_memory_fts(file_id, workspace_id, title, body)
            VALUES (new.id, new.workspace_id, new.title, new.body);
         END;
         CREATE TRIGGER working_memory_fts_update AFTER UPDATE ON working_memory_files BEGIN
            DELETE FROM working_memory_fts WHERE file_id = old.id;
            INSERT INTO working_memory_fts(file_id, workspace_id, title, body)
            VALUES (new.id, new.workspace_id, new.title, new.body);
         END;
         CREATE TRIGGER working_memory_fts_delete AFTER DELETE ON working_memory_files BEGIN
            DELETE FROM working_memory_fts WHERE file_id = old.id;
         END;",
    )?;
    apply_migration(
        &transaction,
        9,
        "ALTER TABLE checkpoints
            ADD COLUMN updates_state INTEGER NOT NULL DEFAULT 1
            CHECK (updates_state IN (0, 1));",
    )?;
    apply_migration(
        &transaction,
        10,
        "CREATE TABLE projects_vault_config (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            canonical_root TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE logical_projects (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE workspace_project_mappings (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES logical_projects(id) ON DELETE RESTRICT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE INDEX workspace_project_mappings_project_idx
            ON workspace_project_mappings(project_id, workspace_id);",
    )?;
    apply_migration(
        &transaction,
        11,
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
            document_id UNINDEXED,
            project_id UNINDEXED,
            title,
            body,
            tokenize = 'unicode61'
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
         END;",
    )?;
    transaction.commit()?;
    Ok(())
}

fn apply_migration(transaction: &rusqlite::Transaction<'_>, version: u32, sql: &str) -> Result<()> {
    let applied = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
        [version],
        |row| row.get::<_, bool>(0),
    )?;
    if applied {
        return Ok(());
    }
    transaction.execute_batch(sql)?;
    transaction.execute(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
        params![version, now_millis()],
    )?;
    Ok(())
}

fn fts_query(value: &str) -> Option<String> {
    let terms = value
        .split_whitespace()
        .map(|term| term.trim_matches(|ch: char| !ch.is_alphanumeric() && ch != '_'))
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn workspace_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        canonical_root: row.get(1)?,
        display_name: row.get(2)?,
        color: row.get(3)?,
        capture_paused: row.get(4)?,
        activity_retention_days: row.get(5)?,
        audit_retention_days: row.get(6)?,
        tombstone_retention_days: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn memory_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
    let kind = MemoryKind::parse(row.get(2)?).map_err(to_sql_conversion_error)?;
    let source = MemorySource::parse(row.get(5)?).map_err(to_sql_conversion_error)?;
    Ok(MemoryRecord {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        kind,
        title: row.get(3)?,
        body: row.get(4)?,
        source,
        source_client: row.get(6)?,
        session_id: row.get(7)?,
        pinned: row.get(8)?,
        version: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        deleted_at: row.get(12)?,
        links: Vec::new(),
        backlinks: Vec::new(),
    })
}

fn memory_links(connection: &Connection, id: &str, backlinks: bool) -> Result<Vec<MemoryLink>> {
    let (select_id, filter_id) = if backlinks {
        ("source_id", "target_id")
    } else {
        ("target_id", "source_id")
    };
    let sql = format!(
        "SELECT {select_id}, relation FROM memory_links
         WHERE {filter_id} = ?1 ORDER BY created_at, {select_id}"
    );
    let mut statement = connection.prepare(&sql)?;
    let links = statement
        .query_map([id], |row| {
            Ok(MemoryLink {
                target_id: row.get(0)?,
                relation: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(links)
}

fn to_sql_conversion_error(error: MemoryError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn interleave_ranked(
    left: Vec<MemorySearchHit>,
    right: Vec<MemorySearchHit>,
) -> Vec<MemorySearchHit> {
    let mut left = left.into_iter();
    let mut right = right.into_iter();
    let mut merged = Vec::new();
    loop {
        let mut advanced = false;
        if let Some(item) = left.next() {
            merged.push(item);
            advanced = true;
        }
        if let Some(item) = right.next() {
            merged.push(item);
            advanced = true;
        }
        if !advanced {
            return merged;
        }
    }
}

fn quick_check(connection: &Connection) -> Result<()> {
    let result: String = connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(MemoryError::CorruptDatabase(result))
    }
}

fn is_corruption(error: &MemoryError) -> bool {
    match error {
        MemoryError::CorruptDatabase(_) => true,
        MemoryError::Database(rusqlite::Error::SqliteFailure(error, _)) => matches!(
            error.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
        ),
        _ => false,
    }
}

fn is_database_busy(error: &MemoryError) -> bool {
    matches!(
        error,
        MemoryError::Database(rusqlite::Error::SqliteFailure(error, _))
            if matches!(
                error.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

fn preserve_corrupt_database(path: &Path) -> Result<PathBuf> {
    let backup = PathBuf::from(format!("{}.corrupt-{}", path.display(), now_millis()));
    std::fs::rename(path, &backup)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
        if sidecar.exists() {
            let backup_sidecar = PathBuf::from(format!("{}{}", backup.display(), suffix));
            std::fs::rename(sidecar, backup_sidecar)?;
        }
    }
    Ok(backup)
}
