//! Native-only migration from repo-local KödMem data to projects-vault Markdown.
//!
//! The plan is always recomputed under the portable project lock. Legacy
//! sources are backed up and retained; the cutover receipt is the final vault
//! write and only authorizes source snapshots explicitly named by digest.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::super::projects::{ProjectLocation, WorkspaceProjectMapping};
use super::super::{
    checkpoint_with_connection, memory_with_connection, validate_no_likely_credential, Checkpoint,
    MemoryError, MemoryRecord, MemoryStore, NewCheckpoint, NewMemory, Result, StoreAccess,
};
use super::{
    atomic_write, checkpoint_decision_relative, checkpoint_payload_hash,
    checkpoint_worklog_relative, collect_checkpoints, collect_memories, confined_path,
    file_hash_optional, memory_payload_hash, record_relative_path, render_checkpoint_decision,
    render_checkpoint_entry, render_memory_note, render_state, render_template, sha256_bytes,
    state_relative_path, CanonicalCheckpoint, CheckpointDecisionMarker, CheckpointMarker,
    MigrationOrigin, MigrationProvenance, RecordMarker, StateMarker,
};

const CUTOVER_PREFIX: &str = "<!-- kodmem-cutover ";
const CUTOVER_SUFFIX: &str = " -->";
const MIGRATION_NOTE_PREFIX: &str = "<!-- kodmem-migration ";
const PENDING_PREFIX: &str = "<!-- kodmem-migration-pending ";

mod authority;
mod engine;
mod planning;
mod policy;
mod recovery;
mod source;

use authority::*;
use planning::*;
use policy::*;
use recovery::*;
use source::*;

pub(in crate::memory::portable) use authority::migration_artifacts_authorized;
pub(crate) use authority::{
    migration_note_is_visible, migration_source_modified_at, state_lineage_sha256,
};
pub(in crate::memory::portable) use recovery::{parse_cutover_marker, receipts_cover};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyMigrationStatus {
    NoLegacy,
    Ready,
    Blocked,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyMigrationAction {
    Create,
    Append,
    ReplacePlaceholder,
    SkipDuplicate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyMigrationRecoveryPhase {
    Prepared,
    MarkdownWritten,
    Cutover,
    Complete,
    RollingBack,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationRecovery {
    pub migration_id: String,
    pub manifest_sha256: String,
    pub phase: LegacyMigrationRecoveryPhase,
    pub can_retry: bool,
    pub can_rollback: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LegacyMigrationCounts {
    pub source_files: u32,
    pub memories: u32,
    pub checkpoints: u32,
    pub operations: u32,
    pub duplicates: u32,
    pub conflicts: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LegacyMigrationSource {
    pub workspace_id: String,
    pub workspace_display_name: String,
    pub snapshot_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LegacyMigrationOperation {
    pub action: LegacyMigrationAction,
    pub source_kind: String,
    pub source_relative_path: Option<String>,
    pub source_sha256: String,
    pub target_relative_path: String,
    pub expected_target_sha256: Option<String>,
    pub target_sha256: Option<String>,
    pub item_count: u32,
    pub conflict: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationSystemOperation {
    pub sequence: u8,
    pub kind: String,
    pub target: String,
    pub local_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LegacyMigrationPlan {
    pub schema: u8,
    pub status: LegacyMigrationStatus,
    pub workspace_id: String,
    pub project_id: String,
    pub project_display_name: String,
    pub fingerprint: String,
    pub migration_id: Option<String>,
    pub manifest_sha256: Option<String>,
    pub sources: Vec<LegacyMigrationSource>,
    pub source_snapshots: Vec<SourceSnapshotReceipt>,
    pub counts: LegacyMigrationCounts,
    pub operations: Vec<LegacyMigrationOperation>,
    pub system_operations: Vec<LegacyMigrationSystemOperation>,
    pub can_apply: bool,
    pub source_retained: bool,
    pub creates_local_recovery_backup: bool,
    pub writes_cutover_last: bool,
    pub recovery: Option<LegacyMigrationRecovery>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LegacyMigrationApply {
    pub project_id: String,
    pub migration_id: String,
    pub manifest_sha256: String,
    pub written: u32,
    pub skipped: u32,
    pub backup_path: String,
    pub source_retained: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LegacyMigrationRollback {
    pub project_id: String,
    pub migration_id: String,
    pub restored: u32,
    pub removed: u32,
    pub source_retained: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SourceSnapshotReceipt {
    pub kind: String,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationPolicy {
    schema: u8,
    max_source_files: usize,
    max_source_workspaces: usize,
    max_source_receipts: usize,
    max_target_scan_files: usize,
    max_source_bytes: usize,
    max_document_bytes: u64,
    max_database_records: usize,
    max_database_links: usize,
    max_database_bytes: usize,
    max_canonical_files: usize,
    max_canonical_bytes: usize,
    max_backup_bytes: usize,
    max_cutover_bytes: usize,
    backup_namespace: String,
    repo_sources: Vec<RepoSourcePolicy>,
    repo_note_template: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepoSourcePolicy {
    kind: String,
    exact_paths: Vec<String>,
    #[serde(default)]
    root_prefix: Option<String>,
    #[serde(default)]
    root_suffix: Option<String>,
    #[serde(default)]
    recursive_directory: Option<String>,
    #[serde(default)]
    recursive_extension: Option<String>,
    target_pattern: String,
    #[serde(default)]
    history_pattern: Option<String>,
    note_type: String,
    status: String,
}

#[derive(Clone, Debug)]
struct LegacyFile {
    workspace_id: String,
    relative_path: String,
    kind: String,
    text: String,
    sha256: String,
    snapshot_sha256: String,
    modified_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepoMigrationOrigin {
    source_kind: String,
    source_snapshot_sha256: String,
    legacy_identity: String,
    source_sha256: String,
    source_modified_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepoMigrationMarker {
    schema: u8,
    migration_id: String,
    source_sha256: String,
    source_snapshot_sha256: String,
    source_origins: Vec<RepoMigrationOrigin>,
    source_modified_at: i64,
}

#[derive(Clone, Debug)]
struct LegacyDatabase {
    workspace_id: String,
    memories: Vec<LegacyMemory>,
    checkpoints: Vec<LegacyCheckpoint>,
    serialized_bytes: usize,
    link_count: usize,
    sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMemory {
    record: MemoryRecord,
    idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCheckpoint {
    checkpoint: Checkpoint,
    idempotency_key: Option<String>,
    updates_state: bool,
}

#[derive(Clone, Debug)]
pub(super) struct LegacySnapshot {
    files: Vec<LegacyFile>,
    databases: Vec<LegacyDatabase>,
    pub(super) receipts: Vec<SourceSnapshotReceipt>,
    sources: Vec<LegacyMigrationSource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlannedWrite {
    public: LegacyMigrationOperation,
    contents: Option<String>,
    #[serde(default)]
    evidence: Vec<CutoverTarget>,
}

#[derive(Clone, Debug)]
struct ComputedPlan {
    public: LegacyMigrationPlan,
    location: ProjectLocation,
    writes: Vec<PlannedWrite>,
    snapshot: LegacySnapshot,
    project_note_sha256: String,
    recovery_backup: Option<BackupManifest>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CutoverMarker {
    schema: u8,
    project_id: String,
    authority: String,
    migrations: Vec<CutoverMigration>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CutoverMigration {
    migration_id: String,
    manifest_sha256: String,
    recovery_anchor_sha256: String,
    source_snapshots: Vec<SourceSnapshotReceipt>,
    targets: Vec<CutoverTarget>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PendingPhase {
    Applying,
    RollingBack,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingMarker {
    schema: u8,
    project_id: String,
    migration_id: String,
    manifest_sha256: String,
    recovery_anchor_sha256: String,
    phase: PendingPhase,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CutoverTarget {
    source_kind: String,
    artifact_kind: String,
    artifact_id: String,
    relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lineage_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    origin_source_sha256: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin_provenance_sha256: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BackupPhase {
    Prepared,
    MarkdownWritten,
    Cutover,
    Complete,
    RollingBack,
    RolledBack,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupManifest {
    schema: u8,
    project_id: String,
    migration_id: String,
    manifest_sha256: String,
    preview_fingerprint: String,
    project_note_sha256: String,
    project_note_base64: String,
    integrity_sha256: String,
    phase: BackupPhase,
    plan: LegacyMigrationPlan,
    writes: Vec<PlannedWrite>,
    source_snapshots: Vec<SourceSnapshotReceipt>,
    source_files: Vec<BackupSource>,
    exports: Vec<BackupExport>,
    targets: Vec<BackupTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupSource {
    workspace_id: String,
    relative_path: String,
    sha256: String,
    bytes_base64: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupExport {
    workspace_id: String,
    json: String,
    markdown: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupTarget {
    relative_path: String,
    before_base64: Option<String>,
    before_sha256: Option<String>,
    after_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationAnchor {
    schema: u8,
    project_id: String,
    migration_id: String,
    manifest_sha256: String,
    preview_fingerprint: String,
    project_note_sha256: String,
    source_snapshots: Vec<SourceSnapshotReceipt>,
}
