//! Portable projects-vault authority.
//!
//! Markdown is committed before its rebuildable SQLite projection. A small
//! machine-local journal keyed by canonical project root makes multi-file
//! updates resumable without adding operational files to the vault.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::credential::{validate_no_likely_credential, validate_optional_no_likely_credential};
use super::projects::ProjectLocation;
use super::{
    audit_mutation, checkpoint_with_connection, memory_with_connection, now_millis, AuditMutation,
    Checkpoint, MemoryError, MemoryKind, MemoryLink, MemoryRecord, MemoryRevision, MemorySource,
    MemoryStore, NewCheckpoint, NewMemory, Result, StoreAccess, Tombstone,
};

const RECORD_MARKER_PREFIX: &str = "<!-- kodmem-memory ";
const CHECKPOINT_MARKER_PREFIX: &str = "<!-- kodmem-checkpoint ";

mod codec;
mod io;
mod journal;
pub(crate) mod migration;

pub(crate) use codec::portable_projected_memory_id;
use codec::*;
use io::*;
use journal::*;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortablePolicy {
    schema: u8,
    journal_file: String,
    lock_namespace: String,
    state_byte_limit: usize,
    state_file: String,
    max_document_bytes: u64,
    max_project_bytes: usize,
    max_scan_files: usize,
    record_lanes: Vec<RecordLanePolicy>,
    checkpoint: CheckpointPolicy,
    templates: TemplatePolicy,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordLanePolicy {
    kinds: Vec<MemoryKind>,
    active_pattern: String,
    archive_pattern: String,
    #[serde(rename = "type")]
    note_type: String,
    active_status: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointPolicy {
    worklog_root: String,
    worklog_pattern: String,
    decision_pattern: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemplatePolicy {
    memory: Vec<String>,
    daily_header: Vec<String>,
    checkpoint_entry: Vec<String>,
    state: Vec<String>,
    checkpoint_decision: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Journal {
    schema: u8,
    project_id: String,
    workspace_id: String,
    action: String,
    target_id: String,
    source_client: String,
    session_id: Option<String>,
    previous_version: Option<u64>,
    checkpoint: Option<CheckpointMarker>,
    operations: Vec<JournalOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct JournalOperation {
    mode: JournalOperationMode,
    relative_path: String,
    expected_sha256: Option<String>,
    contents: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum JournalOperationMode {
    Replace,
    Append,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct RecordMarker {
    schema: u8,
    record_id: String,
    project_id: String,
    kind: MemoryKind,
    source: MemorySource,
    source_client: String,
    session_id: Option<String>,
    pinned: bool,
    version: u64,
    idempotency_key_hash: Option<String>,
    payload_hash: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    links: Vec<MemoryLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    migration: Option<MigrationProvenance>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct CheckpointMarker {
    schema: u8,
    checkpoint_id: String,
    project_id: String,
    source: MemorySource,
    source_client: String,
    session_id: Option<String>,
    idempotency_key_hash: Option<String>,
    payload_hash: String,
    created_at: i64,
    updates_state: bool,
    summary: String,
    decisions: Vec<String>,
    next_actions: Vec<String>,
    changed_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    migration: Option<MigrationProvenance>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct MigrationProvenance {
    migration_id: String,
    legacy_id: String,
    source_sha256: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    origins: Vec<MigrationOrigin>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct MigrationOrigin {
    source_kind: String,
    legacy_id: String,
    source_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct StateMarker {
    schema: u8,
    checkpoint_id: String,
    #[serde(default)]
    lineage_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(super) struct CheckpointDecisionMarker {
    schema: u8,
    checkpoint_id: String,
    index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    migration: Option<MigrationProvenance>,
}

#[derive(Clone, Debug)]
struct CanonicalMemory {
    marker: RecordMarker,
    title: String,
    body: String,
    relative_path: String,
    sha256: String,
}

#[derive(Clone, Debug)]
struct CanonicalCheckpoint {
    marker: CheckpointMarker,
    summary: String,
    decisions: Vec<String>,
    next_actions: Vec<String>,
    changed_paths: Vec<String>,
    relative_path: String,
}

struct ScanBudget {
    files: usize,
    bytes: usize,
}

impl ScanBudget {
    fn new() -> Self {
        Self { files: 0, bytes: 0 }
    }
}

pub(crate) struct PortableReadSnapshot {
    pub(crate) records: Vec<MemoryRecord>,
    pub(crate) checkpoints: Vec<Checkpoint>,
}

impl MemoryStore {
    pub(crate) fn prepare_portable_read(
        &self,
        workspace_id: &str,
    ) -> Result<Option<PortableReadSnapshot>> {
        if matches!(self.access, StoreAccess::ReadOnly) {
            return self.portable_read_snapshot(workspace_id);
        }
        if self.portable_authority(workspace_id)?.is_some() {
            self.rebuild_project_from_markdown(workspace_id)?;
        }
        Ok(None)
    }

    fn portable_read_snapshot(&self, workspace_id: &str) -> Result<Option<PortableReadSnapshot>> {
        let Some(location) = self.portable_authority(workspace_id)? else {
            return Ok(None);
        };
        let mut budget = ScanBudget::new();
        let mut canonical = collect_memories_with_budget(&location, &mut budget)?;
        let retention_days = self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection
                .query_row(
                    "SELECT tombstone_retention_days FROM workspaces WHERE id = ?1",
                    [workspace_id],
                    |row| row.get::<_, u32>(0),
                )
                .map_err(Into::into)
        })?;
        let cutoff = super::retention_cutoff(now_millis(), retention_days);
        canonical.retain(|memory| {
            memory
                .marker
                .deleted_at
                .is_none_or(|deleted| deleted >= cutoff)
        });
        let id_map = canonical
            .iter()
            .map(|memory| {
                (
                    memory.marker.record_id.clone(),
                    projected_id("mem", workspace_id, &memory.marker.record_id),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut records = canonical
            .iter()
            .map(|memory| MemoryRecord {
                id: id_map[&memory.marker.record_id].clone(),
                workspace_id: workspace_id.into(),
                kind: memory.marker.kind,
                title: memory.title.clone(),
                body: memory.body.clone(),
                source: memory.marker.source,
                source_client: memory.marker.source_client.clone(),
                session_id: memory.marker.session_id.clone(),
                pinned: memory.marker.pinned,
                version: memory.marker.version,
                created_at: memory.marker.created_at,
                updated_at: memory.marker.updated_at,
                deleted_at: memory.marker.deleted_at,
                links: memory
                    .marker
                    .links
                    .iter()
                    .filter_map(|link| {
                        id_map.get(&link.target_id).map(|target_id| MemoryLink {
                            target_id: target_id.clone(),
                            relation: link.relation.clone(),
                        })
                    })
                    .collect(),
                backlinks: Vec::new(),
                project_source: Some(super::ProjectKnowledgeProvenance {
                    project_id: location.project_id.clone(),
                    relative_path: memory.relative_path.clone(),
                    sha256: memory.sha256.clone(),
                }),
            })
            .collect::<Vec<_>>();
        let outgoing = records
            .iter()
            .flat_map(|record| {
                record.links.iter().map(move |link| {
                    (
                        record.id.clone(),
                        link.target_id.clone(),
                        link.relation.clone(),
                    )
                })
            })
            .collect::<Vec<_>>();
        for record in &mut records {
            record.backlinks = outgoing
                .iter()
                .filter(|(_, target_id, _)| target_id == &record.id)
                .map(|(source_id, _, relation)| MemoryLink {
                    target_id: source_id.clone(),
                    relation: relation.clone(),
                })
                .collect();
        }
        let checkpoints = collect_checkpoints_with_budget(&location, &mut budget)?
            .into_iter()
            .map(|checkpoint| Checkpoint {
                id: projected_id("cp", workspace_id, &checkpoint.marker.checkpoint_id),
                workspace_id: workspace_id.into(),
                summary: checkpoint.summary,
                decisions: checkpoint.decisions,
                next_actions: checkpoint.next_actions,
                changed_paths: checkpoint.changed_paths,
                source: checkpoint.marker.source,
                source_client: checkpoint.marker.source_client,
                session_id: checkpoint.marker.session_id,
                created_at: checkpoint.marker.created_at,
            })
            .collect();
        Ok(Some(PortableReadSnapshot {
            records,
            checkpoints,
        }))
    }

    pub(crate) fn memory_for_workspace(
        &self,
        workspace_id: &str,
        id: &str,
    ) -> Result<MemoryRecord> {
        if let Some(snapshot) = self.prepare_portable_read(workspace_id)? {
            return snapshot
                .records
                .into_iter()
                .find(|record| record.id == id)
                .ok_or_else(|| MemoryError::NotFound(id.into()));
        }
        let record = self.memory(id)?;
        if record.workspace_id != workspace_id {
            return Err(MemoryError::NotFound(id.into()));
        }
        Ok(record)
    }

    pub(crate) fn portable_authority(&self, workspace_id: &str) -> Result<Option<ProjectLocation>> {
        let Some(location) = self.project_location(workspace_id)? else {
            return Ok(None);
        };
        match std::fs::symlink_metadata(&location.project_root) {
            Ok(_) => validate_project_root(&location)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if self.has_portable_authority_evidence(&location)? {
                    return Err(MemoryError::InvalidInput(
                        "mapped project folder disappeared after portable writes; restore it before continuing"
                            .into(),
                    ));
                }
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        }
        let project_note = match read_optional_regular(&location, "Project.md")? {
            Some(project_note) => project_note,
            None => {
                if self.has_portable_authority_evidence(&location)? {
                    return Err(MemoryError::InvalidInput(
                        "Project.md authority marker disappeared after portable writes; restore it before continuing"
                            .into(),
                    ));
                }
                return Ok(None);
            }
        };
        if super::scaffold::validate_authority_marker(&project_note, &location.project_id)? {
            super::scaffold::validate_project_identity(
                project_note.as_bytes(),
                &location.project_id,
            )?;
            let cutover = migration::parse_cutover_marker(&project_note, &location.project_id)?;
            if !migration::migration_artifacts_authorized(&location, &project_note)? {
                return Err(MemoryError::InvalidInput(
                    "mapped project contains migration-owned Markdown without a matching completed cutover receipt"
                        .into(),
                ));
            }
            let legacy = self.local_legacy_snapshot(&location.project_id)?;
            if legacy.receipts.is_empty() {
                return Ok(Some(location));
            }
            if cutover
                .as_ref()
                .is_some_and(|marker| migration::receipts_cover(marker, &legacy.receipts))
            {
                Ok(Some(location))
            } else {
                Err(MemoryError::InvalidInput(
                    "mapped project has eligible repo-local KödMem data that is not covered by a projects-vault cutover receipt; preview and apply the legacy migration before continuing"
                        .into(),
                ))
            }
        } else if self.has_portable_authority_evidence(&location)? {
            Err(MemoryError::InvalidInput(
                "Project.md authority marker disappeared after portable writes; restore it before continuing"
                    .into(),
            ))
        } else {
            Ok(None)
        }
    }

    fn has_portable_authority_evidence(&self, location: &ProjectLocation) -> Result<bool> {
        if portable_journal_path(location).is_ok_and(|path| path.exists()) {
            return Ok(true);
        }
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM memories WHERE canonical_project_id = ?1
                        UNION ALL
                        SELECT 1 FROM checkpoints WHERE canonical_project_id = ?1
                     )",
                    [&location.project_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
        })
    }

    pub fn checkpoint_with_state_hash(
        &self,
        input: NewCheckpoint,
        expected_state_sha256: Option<&str>,
    ) -> Result<Checkpoint> {
        self.checkpoint_with_authority(input, true, expected_state_sha256)
    }

    pub fn checkpoint_with_authority(
        &self,
        input: NewCheckpoint,
        update_state: bool,
        expected_state_sha256: Option<&str>,
    ) -> Result<Checkpoint> {
        super::validate_checkpoint(&input)?;
        let Some(location) = self.portable_authority(&input.workspace_id)? else {
            return self.checkpoint_legacy(input, update_state);
        };
        self.portable_checkpoint(input, update_state, expected_state_sha256, location)
    }

    pub(crate) fn portable_checkpoint(
        &self,
        input: NewCheckpoint,
        update_state: bool,
        expected_state_sha256: Option<&str>,
        location: ProjectLocation,
    ) -> Result<Checkpoint> {
        self.require_portable_write_access(&location)?;
        let _lock = self.lock_portable_project(&location)?;
        self.recover_portable_journal(&location, &input.workspace_id)?;
        let payload_hash = checkpoint_payload_hash(&input, update_state)?;
        let key_hash = input.idempotency_key.as_deref().map(sha256_text);
        if let Some(key_hash) = key_hash.as_deref() {
            if let Some(existing) = find_checkpoint_by_key(&location, key_hash)? {
                if existing.marker.payload_hash != payload_hash {
                    return Err(MemoryError::InvalidInput(
                        "checkpoint idempotency key was already used with a different payload"
                            .into(),
                    ));
                }
                self.project_canonical_notes(&location, &input.workspace_id, None)?;
                return self.projected_checkpoint(
                    &input.workspace_id,
                    &location.project_id,
                    &existing.marker.checkpoint_id,
                );
            }
        }

        let policy = portable_policy()?;
        let state_text =
            read_optional_regular(&location, &policy.state_file)?.ok_or_else(|| {
                MemoryError::InvalidInput("mapped project STATE.md is unavailable".into())
            })?;
        let state_hash = sha256_bytes(state_text.as_bytes());
        let state_lineage = migration::state_lineage_sha256(&state_text)?;
        if update_state {
            let expected = expected_state_sha256.ok_or_else(|| {
                MemoryError::InvalidInput(
                    "mapped checkpoint requires expectedStateHash from the latest context".into(),
                )
            })?;
            validate_sha256("expectedStateHash", expected)?;
            if expected != state_hash {
                return Err(MemoryError::ContentConflict {
                    expected: expected.into(),
                    actual: state_hash,
                });
            }
        }

        let now = now_millis();
        let logical_id = unique_id("checkpoint", &location.project_id, now);
        let marker = CheckpointMarker {
            schema: 1,
            checkpoint_id: logical_id.clone(),
            project_id: location.project_id.clone(),
            source: input.source,
            source_client: input.source_client.clone(),
            session_id: input.session_id.clone(),
            idempotency_key_hash: key_hash,
            payload_hash,
            created_at: now,
            updates_state: update_state,
            summary: input.summary.trim().into(),
            decisions: input.decisions.clone(),
            next_actions: input.next_actions.clone(),
            changed_paths: input.changed_paths.clone(),
            migration: None,
        };
        let date = utc_date(SystemTime::now());
        let worklog_relative = fill_pattern(
            &policy.checkpoint.worklog_pattern,
            &[("year", &date[..4]), ("date", date.as_str())],
        )?;
        let worklog_path = location.project_root.join(&worklog_relative);
        let mut operations = vec![JournalOperation {
            mode: JournalOperationMode::Append,
            relative_path: worklog_relative,
            expected_sha256: file_hash_optional(&worklog_path)?,
            contents: Some(render_checkpoint_entry(&marker, &input)?),
        }];
        if update_state {
            operations.push(JournalOperation {
                mode: JournalOperationMode::Replace,
                relative_path: policy.state_file.clone(),
                expected_sha256: Some(expected_state_sha256.expect("checked above").into()),
                contents: Some(render_state(
                    &location,
                    &marker,
                    &input,
                    state_lineage.as_deref(),
                )),
            });
        }
        for (index, decision) in input.decisions.iter().enumerate() {
            let formatted_index = format!("{:02}", index + 1);
            let relative = fill_pattern(
                &policy.checkpoint.decision_pattern,
                &[
                    ("checkpoint_id", logical_id.as_str()),
                    ("index", formatted_index.as_str()),
                ],
            )?;
            operations.push(JournalOperation {
                mode: JournalOperationMode::Replace,
                relative_path: relative,
                expected_sha256: None,
                contents: Some(render_checkpoint_decision(
                    &location, &marker, index, decision,
                )?),
            });
        }
        let journal = Journal {
            schema: 1,
            project_id: location.project_id.clone(),
            workspace_id: input.workspace_id,
            action: "checkpoint".into(),
            target_id: logical_id.clone(),
            source_client: input.source_client,
            session_id: input.session_id,
            previous_version: None,
            checkpoint: Some(marker),
            operations,
        };
        self.commit_portable_journal(&location, &journal)?;
        self.projected_checkpoint(&journal.workspace_id, &location.project_id, &logical_id)
    }

    pub(crate) fn portable_remember(
        &self,
        mut input: NewMemory,
        location: ProjectLocation,
    ) -> Result<MemoryRecord> {
        self.require_portable_write_access(&location)?;
        let _lock = self.lock_portable_project(&location)?;
        self.recover_portable_journal(&location, &input.workspace_id)?;
        input.links =
            self.canonicalize_links(&input.workspace_id, &location.project_id, &input.links)?;
        let payload_hash = memory_payload_hash(&input)?;
        let key_hash = input.idempotency_key.as_deref().map(sha256_text);
        if let Some(key_hash) = key_hash.as_deref() {
            if let Some(existing) = find_memory_by_key(&location, key_hash)? {
                if existing.marker.payload_hash != payload_hash {
                    return Err(MemoryError::InvalidInput(
                        "memory idempotency key was already used with a different payload".into(),
                    ));
                }
                self.project_canonical_notes(&location, &input.workspace_id, None)?;
                return self.projected_memory(
                    &input.workspace_id,
                    &location.project_id,
                    &existing.marker.record_id,
                );
            }
        }
        let now = now_millis();
        let logical_id = unique_id("record", &location.project_id, now);
        let marker = RecordMarker {
            schema: 1,
            record_id: logical_id.clone(),
            project_id: location.project_id.clone(),
            kind: input.kind,
            source: input.source,
            source_client: input.source_client.clone(),
            session_id: input.session_id.clone(),
            pinned: input.pinned,
            version: 1,
            idempotency_key_hash: key_hash,
            payload_hash,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            links: input.links,
            migration: None,
        };
        let relative = record_relative_path(input.kind, &logical_id, false)?;
        let contents = render_memory_note(&location, &marker, input.title.trim(), &input.body)?;
        let journal = Journal {
            schema: 1,
            project_id: location.project_id.clone(),
            workspace_id: input.workspace_id,
            action: "remember".into(),
            target_id: logical_id.clone(),
            source_client: input.source_client,
            session_id: input.session_id,
            previous_version: None,
            checkpoint: None,
            operations: vec![JournalOperation {
                mode: JournalOperationMode::Replace,
                relative_path: relative,
                expected_sha256: None,
                contents: Some(contents),
            }],
        };
        self.commit_portable_journal(&location, &journal)?;
        self.projected_memory(&journal.workspace_id, &location.project_id, &logical_id)
    }

    pub fn revise_with_content_hash(
        &self,
        mut input: MemoryRevision,
        expected_content_sha256: Option<&str>,
    ) -> Result<MemoryRecord> {
        let current = self.memory(&input.id)?;
        let Some(location) = self.portable_authority(&current.workspace_id)? else {
            return self.revise_legacy(input);
        };
        super::validate_memory_revision(&input, super::MEMORY_TITLE_LIMIT)?;
        self.require_portable_write_access(&location)?;
        let expected = required_content_hash(expected_content_sha256)?;
        let _lock = self.lock_portable_project(&location)?;
        self.recover_portable_journal(&location, &current.workspace_id)?;
        let canonical =
            find_memory_by_projected_id(self, &input.id, &current.workspace_id, &location)?;
        verify_record_conflicts(&canonical, input.expected_version, expected)?;
        input.links =
            self.canonicalize_links(&current.workspace_id, &location.project_id, &input.links)?;
        let now = now_millis();
        let mut marker = canonical.marker.clone();
        marker.kind = input.kind;
        marker.source_client = input.source_client.clone();
        marker.session_id = input.session_id.clone();
        marker.pinned = input.pinned;
        marker.version += 1;
        marker.updated_at = now;
        marker.links = input.links;
        let destination = record_relative_path(input.kind, &marker.record_id, false)?;
        let contents = render_memory_note(&location, &marker, input.title.trim(), &input.body)?;
        let mut operations = Vec::new();
        if canonical.relative_path != destination {
            operations.push(JournalOperation {
                mode: JournalOperationMode::Replace,
                relative_path: destination,
                expected_sha256: None,
                contents: Some(contents),
            });
            operations.push(JournalOperation {
                mode: JournalOperationMode::Replace,
                relative_path: canonical.relative_path.clone(),
                expected_sha256: Some(canonical.sha256.clone()),
                contents: None,
            });
        } else {
            operations.push(JournalOperation {
                mode: JournalOperationMode::Replace,
                relative_path: destination,
                expected_sha256: Some(canonical.sha256),
                contents: Some(contents),
            });
        }
        let journal = Journal {
            schema: 1,
            project_id: location.project_id.clone(),
            workspace_id: current.workspace_id,
            action: "revise".into(),
            target_id: marker.record_id.clone(),
            source_client: input.source_client,
            session_id: input.session_id,
            previous_version: Some(canonical.marker.version),
            checkpoint: None,
            operations,
        };
        self.commit_portable_journal(&location, &journal)?;
        self.projected_memory(
            &journal.workspace_id,
            &location.project_id,
            &marker.record_id,
        )
    }

    pub fn forget_in_workspace_with_content_hash(
        &self,
        id: &str,
        expected_version: u64,
        workspace_id: &str,
        expected_content_sha256: Option<&str>,
        source_client: &str,
        session_id: Option<&str>,
    ) -> Result<Tombstone> {
        let Some(location) = self.portable_authority(workspace_id)? else {
            return self.forget_in_workspace_legacy(
                id,
                expected_version,
                workspace_id,
                source_client,
                session_id,
            );
        };
        super::validate_source_client("memory", source_client)?;
        validate_no_likely_credential("memory id", id)?;
        validate_optional_no_likely_credential("memory session id", session_id)?;
        self.require_portable_write_access(&location)?;
        let expected = required_content_hash(expected_content_sha256)?;
        let _lock = self.lock_portable_project(&location)?;
        self.recover_portable_journal(&location, workspace_id)?;
        let canonical = find_memory_by_projected_id(self, id, workspace_id, &location)?;
        verify_record_conflicts(&canonical, expected_version, expected)?;
        let now = now_millis();
        let mut marker = canonical.marker.clone();
        marker.version += 1;
        marker.updated_at = now;
        marker.deleted_at = Some(now);
        marker.source_client = source_client.into();
        marker.session_id = session_id.map(str::to_string);
        let destination = record_relative_path(marker.kind, &marker.record_id, true)?;
        let contents = render_memory_note(&location, &marker, &canonical.title, &canonical.body)?;
        let journal = Journal {
            schema: 1,
            project_id: location.project_id.clone(),
            workspace_id: workspace_id.into(),
            action: "forget".into(),
            target_id: marker.record_id.clone(),
            source_client: source_client.into(),
            session_id: session_id.map(str::to_string),
            previous_version: Some(canonical.marker.version),
            checkpoint: None,
            operations: vec![
                JournalOperation {
                    mode: JournalOperationMode::Replace,
                    relative_path: destination,
                    expected_sha256: None,
                    contents: Some(contents),
                },
                JournalOperation {
                    mode: JournalOperationMode::Replace,
                    relative_path: canonical.relative_path,
                    expected_sha256: Some(canonical.sha256),
                    contents: None,
                },
            ],
        };
        self.commit_portable_journal(&location, &journal)?;
        Ok(Tombstone {
            id: id.into(),
            workspace_id: workspace_id.into(),
            version: marker.version,
            deleted_at: now,
        })
    }

    pub fn restore_with_content_hash(
        &self,
        id: &str,
        expected_version: u64,
        expected_content_sha256: Option<&str>,
        source_client: &str,
        session_id: Option<&str>,
    ) -> Result<MemoryRecord> {
        let current = self.memory(id)?;
        let Some(location) = self.portable_authority(&current.workspace_id)? else {
            return self.restore_legacy(id, expected_version, source_client, session_id);
        };
        super::validate_source_client("memory", source_client)?;
        validate_no_likely_credential("memory id", id)?;
        validate_optional_no_likely_credential("memory session id", session_id)?;
        self.require_portable_write_access(&location)?;
        let expected = required_content_hash(expected_content_sha256)?;
        let _lock = self.lock_portable_project(&location)?;
        self.recover_portable_journal(&location, &current.workspace_id)?;
        let canonical = find_memory_by_projected_id(self, id, &current.workspace_id, &location)?;
        verify_record_conflicts(&canonical, expected_version, expected)?;
        if canonical.marker.deleted_at.is_none() {
            return Err(MemoryError::NotFound(id.into()));
        }
        let retention_days = self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection
                .query_row(
                    "SELECT tombstone_retention_days FROM workspaces WHERE id = ?1",
                    [&current.workspace_id],
                    |row| row.get::<_, u32>(0),
                )
                .map_err(Into::into)
        })?;
        if canonical.marker.deleted_at.is_some_and(|deleted_at| {
            deleted_at < super::retention_cutoff(now_millis(), retention_days)
        }) {
            return Err(MemoryError::InvalidInput(format!(
                "memory can only be restored within {retention_days} days of deletion"
            )));
        }
        let now = now_millis();
        let mut marker = canonical.marker.clone();
        marker.version += 1;
        marker.updated_at = now;
        marker.deleted_at = None;
        marker.source_client = source_client.into();
        marker.session_id = session_id.map(str::to_string);
        let destination = record_relative_path(marker.kind, &marker.record_id, false)?;
        let contents = render_memory_note(&location, &marker, &canonical.title, &canonical.body)?;
        let journal = Journal {
            schema: 1,
            project_id: location.project_id.clone(),
            workspace_id: current.workspace_id,
            action: "restore".into(),
            target_id: marker.record_id.clone(),
            source_client: source_client.into(),
            session_id: session_id.map(str::to_string),
            previous_version: Some(canonical.marker.version),
            checkpoint: None,
            operations: vec![
                JournalOperation {
                    mode: JournalOperationMode::Replace,
                    relative_path: destination,
                    expected_sha256: None,
                    contents: Some(contents),
                },
                JournalOperation {
                    mode: JournalOperationMode::Replace,
                    relative_path: canonical.relative_path,
                    expected_sha256: Some(canonical.sha256),
                    contents: None,
                },
            ],
        };
        self.commit_portable_journal(&location, &journal)?;
        self.projected_memory(
            &journal.workspace_id,
            &location.project_id,
            &marker.record_id,
        )
    }

    pub fn rebuild_project_from_markdown(&self, workspace_id: &str) -> Result<()> {
        let location = self.portable_authority(workspace_id)?.ok_or_else(|| {
            MemoryError::InvalidInput(
                "workspace does not have active projects-vault authority".into(),
            )
        })?;
        self.require_portable_write_access(&location)?;
        let _lock = self.lock_portable_project(&location)?;
        self.recover_portable_journal(&location, workspace_id)?;
        self.project_canonical_notes(&location, workspace_id, None)
    }

    fn require_portable_write_access(&self, location: &ProjectLocation) -> Result<()> {
        if matches!(self.access, StoreAccess::ReadOnly) {
            return Err(MemoryError::InvalidInput(
                "read-only KödMem cannot update projects-vault Markdown".into(),
            ));
        }
        validate_project_root(location)
    }

    pub(crate) fn lock_portable_project(&self, location: &ProjectLocation) -> Result<File> {
        validate_project_root(location)?;
        let lock_root = portable_runtime_root(true)?;
        let path = lock_root.join(format!("{}.lock", portable_root_key(location)?));
        if std::fs::symlink_metadata(&path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
        {
            return Err(MemoryError::InvalidInput(
                "portable project lock must be a regular file".into(),
            ));
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        portable_lock_test_expect_contention(&lock)?;
        lock.lock_exclusive()?;
        portable_lock_test_barrier()?;
        Ok(lock)
    }

    fn recover_portable_journal(
        &self,
        location: &ProjectLocation,
        workspace_id: &str,
    ) -> Result<()> {
        let path = portable_journal_path(location)?;
        let bytes = match read_optional_runtime_journal(&path)? {
            Some(bytes) => bytes,
            None => return Ok(()),
        };
        let journal: Journal = serde_json::from_slice(&bytes)?;
        validate_journal(location, &journal)?;
        self.apply_journal_operations(location, &journal)?;
        self.refresh_project_knowledge(workspace_id)?;
        portable_failpoint("index")?;
        self.project_canonical_notes(location, workspace_id, Some(&journal))?;
        portable_failpoint("projection")?;
        remove_durable(&path)?;
        Ok(())
    }

    fn commit_portable_journal(&self, location: &ProjectLocation, journal: &Journal) -> Result<()> {
        validate_journal(location, journal)?;
        let path = portable_journal_path(location)?;
        if path.exists() {
            return Err(MemoryError::InvalidInput(
                "another portable KödMem transaction needs recovery".into(),
            ));
        }
        atomic_write(&path, &serde_json::to_string_pretty(journal)?)?;
        portable_failpoint("journal")?;
        self.apply_journal_operations(location, journal)?;
        self.refresh_project_knowledge(&journal.workspace_id)?;
        portable_failpoint("index")?;
        self.project_canonical_notes(location, &journal.workspace_id, Some(journal))?;
        portable_failpoint("projection")?;
        remove_durable(&path)?;
        Ok(())
    }

    fn apply_journal_operations(
        &self,
        location: &ProjectLocation,
        journal: &Journal,
    ) -> Result<()> {
        for (index, operation) in journal.operations.iter().enumerate() {
            let path = confined_path(location, &operation.relative_path)?;
            if operation.mode == JournalOperationMode::Append {
                let delta = operation.contents.as_deref().ok_or_else(|| {
                    MemoryError::InvalidInput("append journal operation has no delta".into())
                })?;
                let current = read_optional_regular(location, &operation.relative_path)?;
                let date = operation
                    .relative_path
                    .rsplit('/')
                    .next()
                    .and_then(|file| file.strip_suffix(".md"))
                    .ok_or_else(|| {
                        MemoryError::InvalidInput("daily Worklog path has no date".into())
                    })?;
                let initial = daily_header(date, &location.project_display_name)?;
                if let Some(existing) = current.as_deref() {
                    if let Some(prefix) = existing.strip_suffix(delta) {
                        let prefix_matches = operation
                            .expected_sha256
                            .as_deref()
                            .is_some_and(|expected| sha256_bytes(prefix.as_bytes()) == expected)
                            || operation.expected_sha256.is_none() && prefix == initial;
                        if prefix_matches {
                            portable_failpoint(&format!("markdown-{}", index + 1))?;
                            continue;
                        }
                    }
                }
                let current_hash = current
                    .as_deref()
                    .map(|contents| sha256_bytes(contents.as_bytes()));
                if current_hash != operation.expected_sha256 {
                    return Err(MemoryError::ContentConflict {
                        expected: operation
                            .expected_sha256
                            .clone()
                            .unwrap_or_else(|| "missing".into()),
                        actual: current_hash.unwrap_or_else(|| "missing".into()),
                    });
                }
                let mut target = current.unwrap_or(initial);
                target.push_str(delta);
                if target.len() as u64 > portable_policy()?.max_document_bytes {
                    return Err(MemoryError::InvalidInput(
                        "daily Worklog exceeds the portable file limit".into(),
                    ));
                }
                atomic_write(&path, &target)?;
                portable_failpoint(&format!("markdown-{}", index + 1))?;
                continue;
            }
            let current = file_hash_optional(&path)?;
            let target_hash = operation
                .contents
                .as_deref()
                .map(|value| sha256_bytes(value.as_bytes()));
            if current == target_hash {
                portable_failpoint(&format!("markdown-{}", index + 1))?;
                continue;
            }
            if current != operation.expected_sha256 {
                return Err(MemoryError::ContentConflict {
                    expected: operation
                        .expected_sha256
                        .clone()
                        .unwrap_or_else(|| "missing".into()),
                    actual: current.unwrap_or_else(|| "missing".into()),
                });
            }
            match operation.contents.as_deref() {
                Some(contents) => atomic_write(&path, contents)?,
                None => remove_durable(&path)?,
            }
            portable_failpoint(&format!("markdown-{}", index + 1))?;
        }
        Ok(())
    }

    fn project_canonical_notes(
        &self,
        location: &ProjectLocation,
        workspace_id: &str,
        audit: Option<&Journal>,
    ) -> Result<()> {
        let mut budget = ScanBudget::new();
        let mut memories = collect_memories_with_budget(location, &mut budget)?;
        let checkpoints = collect_checkpoints_with_budget(location, &mut budget)?;
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let retention_days = transaction.query_row(
                "SELECT tombstone_retention_days FROM workspaces WHERE id = ?1",
                [workspace_id],
                |row| row.get::<_, u32>(0),
            )?;
            let cutoff = super::retention_cutoff(now_millis(), retention_days);
            memories.retain(|memory| memory.marker.deleted_at.is_none_or(|deleted| deleted >= cutoff));
            transaction.execute(
                "DELETE FROM memories WHERE workspace_id = ?1 AND canonical_project_id = ?2",
                params![workspace_id, location.project_id],
            )?;
            transaction.execute(
                "DELETE FROM checkpoints WHERE workspace_id = ?1 AND canonical_project_id = ?2",
                params![workspace_id, location.project_id],
            )?;
            let id_map = memories
                .iter()
                .map(|memory| {
                    (
                        memory.marker.record_id.clone(),
                        projected_id("mem", workspace_id, &memory.marker.record_id),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            for memory in &memories {
                let id = &id_map[&memory.marker.record_id];
                transaction.execute(
                    "INSERT INTO memories (
                        id, workspace_id, kind, title, body, source, source_client,
                        session_id, pinned, version, idempotency_key, created_at, updated_at,
                        deleted_at, canonical_project_id, canonical_record_id,
                        canonical_relative_path, canonical_sha256
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12,
                               ?13, ?14, ?15, ?16, ?17)",
                    params![
                        id,
                        workspace_id,
                        memory.marker.kind.as_str(),
                        memory.title,
                        memory.body,
                        memory.marker.source.as_str(),
                        memory.marker.source_client,
                        memory.marker.session_id,
                        memory.marker.pinned,
                        memory.marker.version,
                        memory.marker.created_at,
                        memory.marker.updated_at,
                        memory.marker.deleted_at,
                        location.project_id,
                        memory.marker.record_id,
                        memory.relative_path,
                        memory.sha256,
                    ],
                )?;
            }
            for memory in &memories {
                let source_id = &id_map[&memory.marker.record_id];
                for link in &memory.marker.links {
                    let target_id = id_map
                        .get(&link.target_id)
                        .cloned()
                        .unwrap_or_else(|| link.target_id.clone());
                    transaction.execute(
                        "INSERT OR IGNORE INTO memory_links(source_id, target_id, relation, created_at)
                         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS(
                            SELECT 1 FROM memories WHERE id = ?2 AND workspace_id = ?5
                         )",
                        params![source_id, target_id, link.relation, memory.marker.updated_at, workspace_id],
                    )?;
                }
            }
            for checkpoint in &checkpoints {
                let id = projected_id("cp", workspace_id, &checkpoint.marker.checkpoint_id);
                transaction.execute(
                    "INSERT INTO checkpoints (
                        id, workspace_id, summary, decisions_json, next_actions_json,
                        changed_paths_json, source, source_client, session_id,
                        idempotency_key, created_at, updates_state, canonical_project_id,
                        canonical_checkpoint_id, canonical_relative_path
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        id,
                        workspace_id,
                        checkpoint.summary,
                        serde_json::to_string(&checkpoint.decisions)?,
                        serde_json::to_string(&checkpoint.next_actions)?,
                        serde_json::to_string(&checkpoint.changed_paths)?,
                        checkpoint.marker.source.as_str(),
                        checkpoint.marker.source_client,
                        checkpoint.marker.session_id,
                        checkpoint.marker.created_at,
                        checkpoint.marker.updates_state,
                        location.project_id,
                        checkpoint.marker.checkpoint_id,
                        checkpoint.relative_path,
                    ],
                )?;
            }
            if let Some(journal) = audit {
                let target_id = projected_id(
                    if journal.action == "checkpoint" { "cp" } else { "mem" },
                    workspace_id,
                    &journal.target_id,
                );
                let exists = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mcp_audit
                     WHERE workspace_id = ?1 AND action = ?2 AND target_id = ?3)",
                    params![workspace_id, journal.action, target_id],
                    |row| row.get::<_, bool>(0),
                )?;
                if !exists {
                    audit_mutation(
                        &transaction,
                        workspace_id,
                        AuditMutation {
                            client: &journal.source_client,
                            session_id: journal.session_id.as_deref(),
                            capability: "memory:write",
                            action: &journal.action,
                            target_id: Some(&target_id),
                            occurred_at: now_millis(),
                        },
                    )?;
                }
            }
            transaction.commit()?;
            Ok(())
        })
    }

    fn projected_memory(
        &self,
        workspace_id: &str,
        project_id: &str,
        logical_id: &str,
    ) -> Result<MemoryRecord> {
        let id = projected_id("mem", workspace_id, logical_id);
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let mut record = memory_with_connection(&connection, &id)?;
            let (relative_path, sha256): (String, String) = connection.query_row(
                "SELECT canonical_relative_path, canonical_sha256 FROM memories WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            record.project_source = Some(super::ProjectKnowledgeProvenance {
                project_id: project_id.into(),
                relative_path,
                sha256,
            });
            Ok(record)
        })
    }

    fn projected_checkpoint(
        &self,
        workspace_id: &str,
        _project_id: &str,
        logical_id: &str,
    ) -> Result<Checkpoint> {
        let id = projected_id("cp", workspace_id, logical_id);
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            checkpoint_with_connection(&connection, &id)
        })
    }

    fn canonicalize_links(
        &self,
        workspace_id: &str,
        project_id: &str,
        links: &[MemoryLink],
    ) -> Result<Vec<MemoryLink>> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            links
                .iter()
                .map(|link| {
                    let logical_id = connection
                        .query_row(
                            "SELECT canonical_record_id FROM memories
                             WHERE id = ?1 AND workspace_id = ?2
                               AND canonical_project_id = ?3 AND deleted_at IS NULL",
                            params![link.target_id, workspace_id, project_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .ok_or_else(|| {
                            MemoryError::InvalidInput(format!(
                                "linked memory is not a canonical record in this project: {}",
                                link.target_id
                            ))
                        })?;
                    Ok(MemoryLink {
                        target_id: logical_id,
                        relation: link.relation.clone(),
                    })
                })
                .collect()
        })
    }
}

fn find_memory_by_projected_id(
    store: &MemoryStore,
    id: &str,
    workspace_id: &str,
    location: &ProjectLocation,
) -> Result<CanonicalMemory> {
    let logical_id = store.run_with_recovery(|| {
        let connection = store.connection()?;
        connection
            .query_row(
                "SELECT canonical_record_id FROM memories
                 WHERE id = ?1 AND canonical_project_id = ?2 AND workspace_id = ?3",
                params![id, location.project_id, workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(id.into()))
    })?;
    collect_memories(location)?
        .into_iter()
        .find(|memory| memory.marker.record_id == logical_id)
        .ok_or_else(|| MemoryError::NotFound(id.into()))
}

fn verify_record_conflicts(
    canonical: &CanonicalMemory,
    expected_version: u64,
    expected_hash: &str,
) -> Result<()> {
    if canonical.marker.version != expected_version {
        return Err(MemoryError::VersionConflict {
            expected: expected_version,
            actual: canonical.marker.version,
        });
    }
    if canonical.sha256 != expected_hash {
        return Err(MemoryError::ContentConflict {
            expected: expected_hash.into(),
            actual: canonical.sha256.clone(),
        });
    }
    Ok(())
}

fn required_content_hash(value: Option<&str>) -> Result<&str> {
    let value = value.ok_or_else(|| {
        MemoryError::InvalidInput(
            "mapped memory mutation requires expectedContentHash from get_memory".into(),
        )
    })?;
    validate_sha256("expectedContentHash", value)?;
    Ok(value)
}

pub(super) fn validate_project_root(location: &ProjectLocation) -> Result<()> {
    let container = super::projects::validate_knowledge_container(location)?;
    let metadata = std::fs::symlink_metadata(&location.project_root).map_err(|error| {
        MemoryError::InvalidInput(format!("mapped project folder is unavailable: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MemoryError::InvalidInput(
            "mapped project folder must be a regular directory, not a symlink".into(),
        ));
    }
    let canonical_project = std::fs::canonicalize(&location.project_root)?;
    if !canonical_project.starts_with(&container) {
        return Err(MemoryError::InvalidInput(
            super::projects::knowledge_escape_message(location.mode, "mapped project"),
        ));
    }
    Ok(())
}
