use super::*;

pub(super) fn legacy_checkpoint_equivalence_key(checkpoint: &LegacyCheckpoint) -> Result<String> {
    let value = &checkpoint.checkpoint;
    let idempotency_key_hash = checkpoint
        .idempotency_key
        .as_deref()
        .map(|key| sha256_bytes(key.as_bytes()));
    Ok(sha256_bytes(&serde_json::to_vec(&(
        value.summary.trim(),
        &value.decisions,
        &value.next_actions,
        &value.changed_paths,
        value.source,
        &value.source_client,
        &value.session_id,
        value.created_at,
        checkpoint.updates_state,
        idempotency_key_hash,
    ))?))
}

pub(super) fn latest_state_checkpoint_logical_id(
    databases: &[LegacyDatabase],
    project_id: &str,
) -> Result<Option<String>> {
    let mut candidates = databases
        .iter()
        .flat_map(|database| database.checkpoints.iter())
        .filter(|checkpoint| checkpoint.updates_state)
        .map(|checkpoint| {
            let equivalence = legacy_checkpoint_equivalence_key(checkpoint)?;
            Ok((
                checkpoint.checkpoint.created_at,
                legacy_logical_id("checkpoint-equivalence", project_id, &equivalence),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    candidates.sort();
    Ok(candidates.pop().map(|(_, id)| id))
}

pub(super) fn checkpoint_equivalence_key(marker: &CheckpointMarker) -> String {
    sha256_bytes(
        &serde_json::to_vec(&(
            marker.summary.trim(),
            &marker.decisions,
            &marker.next_actions,
            &marker.changed_paths,
            marker.source,
            &marker.source_client,
            &marker.session_id,
            marker.created_at,
            marker.updates_state,
            &marker.idempotency_key_hash,
        ))
        .expect("canonical checkpoint equivalence serializes"),
    )
}

pub(super) fn legacy_memory_equivalence_key(memory: &LegacyMemory) -> Result<String> {
    let record = &memory.record;
    Ok(sha256_bytes(&serde_json::to_vec(&(
        record.kind,
        &record.title,
        &record.body,
        record.source,
        &record.source_client,
        &record.session_id,
        record.pinned,
        record.version,
        record.created_at,
        record.updated_at,
        record.deleted_at,
        &record.links,
        &memory.idempotency_key,
    ))?))
}

pub(super) fn validate_legacy_record_chronology(record: &MemoryRecord) -> Result<()> {
    if record.version == 0
        || record.created_at < 0
        || record.updated_at < record.created_at
        || record
            .deleted_at
            .is_some_and(|deleted| deleted < record.updated_at)
    {
        return Err(MemoryError::InvalidInput(
            "legacy memory record chronology is invalid".into(),
        ));
    }
    Ok(())
}

pub(super) fn record_history_matches(left: &RecordMarker, right: &RecordMarker) -> bool {
    left.schema == right.schema
        && left.record_id == right.record_id
        && left.project_id == right.project_id
        && left.kind == right.kind
        && left.source == right.source
        && left.source_client == right.source_client
        && left.session_id == right.session_id
        && left.pinned == right.pinned
        && left.version == right.version
        && left.idempotency_key_hash == right.idempotency_key_hash
        && left.payload_hash == right.payload_hash
        && left.created_at == right.created_at
        && left.updated_at == right.updated_at
        && left.deleted_at == right.deleted_at
        && left.links == right.links
}

pub(super) fn normalize_origins(origins: &mut Vec<MigrationOrigin>) -> Result<()> {
    origins.sort_by(|left, right| {
        (&left.source_kind, &left.legacy_id, &left.source_sha256).cmp(&(
            &right.source_kind,
            &right.legacy_id,
            &right.source_sha256,
        ))
    });
    origins.dedup();
    if origins.is_empty() || origins.len() > 256 {
        return Err(MemoryError::InvalidInput(
            "migration provenance exceeds its bounded origin limit".into(),
        ));
    }
    Ok(())
}

pub(super) fn merged_source_sha256(origins: &[MigrationOrigin]) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(
        &origins
            .iter()
            .map(|origin| origin.source_sha256.as_str())
            .collect::<BTreeSet<_>>(),
    )?))
}

pub(super) fn migration_origins_sha256(origins: &[MigrationOrigin]) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(origins)?))
}

pub(super) fn checkpoint_evidence(source_kind: &str, marker: &CheckpointMarker) -> CutoverTarget {
    CutoverTarget {
        source_kind: source_kind.into(),
        artifact_kind: "canonical-checkpoint".into(),
        artifact_id: marker.checkpoint_id.clone(),
        relative_path: None,
        lineage_sha256: None,
        origin_source_sha256: marker
            .migration
            .as_ref()
            .map(|migration| {
                migration
                    .origins
                    .iter()
                    .map(|origin| origin.source_sha256.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            })
            .unwrap_or_default(),
        origin_provenance_sha256: marker
            .migration
            .as_ref()
            .map(|migration| migration_origins_sha256(&migration.origins))
            .transpose()
            .expect("validated checkpoint origins serialize"),
    }
}

pub(super) fn existing_checkpoint_decision_evidence(
    location: &ProjectLocation,
    checkpoint: &CanonicalCheckpoint,
    source_sha256: &str,
) -> Result<Vec<PlannedWrite>> {
    let mut writes = Vec::new();
    for (index, _) in checkpoint.marker.decisions.iter().enumerate() {
        let relative = checkpoint_decision_relative(&checkpoint.marker.checkpoint_id, index)?;
        let text = read_bounded_regular(
            &location.project_root.join(&relative),
            "canonical checkpoint decision",
        )?;
        let artifact_id = format!("{}:{}", checkpoint.marker.checkpoint_id, index);
        let evidence =
            cutover_artifacts_from_text(&text, "sqlite-checkpoint-decision", &relative, None)?
                .into_iter()
                .find(|target| {
                    target.artifact_kind == "checkpoint-decision"
                        && target.artifact_id == artifact_id
                })
                .ok_or_else(|| {
                    MemoryError::InvalidInput(
                        "canonical checkpoint decision is missing its identity marker".into(),
                    )
                })?;
        let sha = sha256_bytes(text.as_bytes());
        let mut write = LegacyMigrationOperation {
            action: LegacyMigrationAction::SkipDuplicate,
            source_kind: "sqlite-checkpoint-decision".into(),
            source_relative_path: None,
            source_sha256: source_sha256.into(),
            target_relative_path: relative,
            expected_target_sha256: Some(sha.clone()),
            target_sha256: Some(sha),
            item_count: 1,
            conflict: None,
        }
        .into_planned(None);
        write.evidence = vec![evidence];
        writes.push(write);
    }
    Ok(writes)
}

pub(super) fn plan_checkpoint_provenance_merge(
    location: &ProjectLocation,
    checkpoint: &CanonicalCheckpoint,
    marker: &CheckpointMarker,
    source_sha256: &str,
    item_count: u32,
) -> Result<Vec<PlannedWrite>> {
    let path = location.project_root.join(&checkpoint.relative_path);
    let current = read_bounded_regular(&path, "canonical checkpoint Worklog")?;
    let old_line = format!(
        "<!-- kodmem-checkpoint {} -->",
        serde_json::to_string(&checkpoint.marker)?
    );
    let new_line = format!(
        "<!-- kodmem-checkpoint {} -->",
        serde_json::to_string(marker)?
    );
    if current.matches(&old_line).count() != 1 {
        return Err(MemoryError::InvalidInput(
            "canonical checkpoint marker is not uniquely replaceable".into(),
        ));
    }
    let desired = current.replacen(&old_line, &new_line, 1);
    let current_sha = sha256_bytes(current.as_bytes());
    let mut writes = vec![PlannedWrite {
        public: LegacyMigrationOperation {
            action: LegacyMigrationAction::Append,
            source_kind: "sqlite-checkpoint".into(),
            source_relative_path: None,
            source_sha256: source_sha256.into(),
            target_relative_path: checkpoint.relative_path.clone(),
            expected_target_sha256: Some(current_sha),
            target_sha256: Some(sha256_bytes(desired.as_bytes())),
            item_count,
            conflict: None,
        },
        contents: Some(desired),
        evidence: Vec::new(),
    }];
    for (index, decision) in marker.decisions.iter().enumerate() {
        let relative = checkpoint_decision_relative(&marker.checkpoint_id, index)?;
        let current = read_bounded_regular(
            &location.project_root.join(&relative),
            "canonical checkpoint decision",
        )?;
        let desired = render_checkpoint_decision(location, marker, index, decision)?;
        writes.push(PlannedWrite {
            public: LegacyMigrationOperation {
                action: LegacyMigrationAction::Append,
                source_kind: "sqlite-checkpoint-decision".into(),
                source_relative_path: None,
                source_sha256: source_sha256.into(),
                target_relative_path: relative,
                expected_target_sha256: Some(sha256_bytes(current.as_bytes())),
                target_sha256: Some(sha256_bytes(desired.as_bytes())),
                item_count: 1,
                conflict: None,
            },
            contents: Some(desired),
            evidence: Vec::new(),
        });
    }
    Ok(writes)
}

pub(super) fn receipts_for_workspace(
    files: &[LegacyFile],
    databases: &[LegacyDatabase],
    workspace_id: &str,
) -> u32 {
    u32::from(files.iter().any(|file| file.workspace_id == workspace_id))
        + u32::from(
            databases
                .iter()
                .any(|database| database.workspace_id == workspace_id),
        )
}

pub(super) fn is_substantive(kind: &str, text: &str) -> bool {
    let trimmed = text.trim();
    if kind == "state" {
        text.lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty()
                    && !line.starts_with('#')
                    && !line.starts_with("Updated:")
                    && !line.starts_with("<!--")
                    && *line
                        != "KödMem working memory is active. No checkpoint has been recorded yet."
            })
            .any(|line| !line.starts_with("- Leave a checkpoint"))
    } else if kind == "worklog" {
        !matches!(trimmed, "" | "# Project worklog")
            && !(trimmed.starts_with("# Project worklog archive — ")
                && trimmed.lines().count() == 1)
    } else if kind == "decisions" {
        !matches!(trimmed, "" | "# Decisions")
    } else if kind == "imported-records" {
        !matches!(
            trimmed,
            "" | "# Exported durable memories\n\nNo durable memories existed when this snapshot was exported."
        )
    } else {
        !trimmed.is_empty()
    }
}

pub(super) fn portable_file_origin_count(origins: &[&LegacyFile]) -> usize {
    origins
        .iter()
        .map(|origin| {
            (
                origin.snapshot_sha256.as_str(),
                origin.relative_path.as_str(),
                origin.sha256.as_str(),
            )
        })
        .collect::<BTreeSet<_>>()
        .len()
}

pub(super) fn portable_snapshot_file_count(files: &[LegacyFile]) -> usize {
    files
        .iter()
        .map(|file| {
            (
                file.snapshot_sha256.as_str(),
                file.relative_path.as_str(),
                file.sha256.as_str(),
            )
        })
        .collect::<BTreeSet<_>>()
        .len()
}

pub(super) fn plan_file_writes(
    location: &ProjectLocation,
    files: &[LegacyFile],
    migration_id: &str,
    state_checkpoint_id: Option<&str>,
    counts: &mut LegacyMigrationCounts,
) -> Result<Vec<PlannedWrite>> {
    let mut writes = Vec::new();
    let mut states = files
        .iter()
        .filter(|file| file.kind == "state")
        .collect::<Vec<_>>();
    states.sort_by(|left, right| {
        (
            &left.snapshot_sha256,
            &left.relative_path,
            &left.sha256,
            left.modified_at,
        )
            .cmp(&(
                &right.snapshot_sha256,
                &right.relative_path,
                &right.sha256,
                right.modified_at,
            ))
    });
    let unique_states = states
        .iter()
        .map(|file| file.sha256.as_str())
        .collect::<BTreeSet<_>>();
    let state_relative = state_relative_path()?;
    if unique_states.len() > 1 {
        counts.conflicts += unique_states.len() as u32;
        let current_hash = file_hash_optional(&location.project_root.join(&state_relative))?;
        for source in states {
            writes.push(conflict_write(
                source,
                &state_relative,
                current_hash.clone(),
                "multiple mapped workspaces have different substantive legacy state",
            ));
        }
    } else if let Some(source) = states.first() {
        let target = location.project_root.join(&state_relative);
        let current = read_bounded_regular(&target, "projects-vault STATE.md")?;
        let desired =
            render_legacy_note(location, source, &states, migration_id, state_checkpoint_id)?;
        let history = desired.clone();
        let current_hash = sha256_bytes(current.as_bytes());
        if current == desired {
            counts.duplicates += 1;
            writes.push(skip_write(
                source,
                &state_relative,
                Some(current_hash),
                &current,
                "state",
            )?);
        } else if is_scaffold_state_placeholder(location, &current)? {
            let mut write = write_operation(
                source,
                &state_relative,
                LegacyMigrationAction::ReplacePlaceholder,
                Some(current_hash),
                desired,
            );
            write.public.item_count = portable_file_origin_count(&states) as u32;
            writes.push(write);
        } else {
            counts.conflicts += 1;
            writes.push(conflict_write(
                source,
                &state_relative,
                Some(current_hash),
                "projects-vault STATE.md contains non-placeholder content",
            ));
        }
        let history_relative = render_repo_history_target(repo_source_for_kind("state")?, source)?
            .ok_or_else(|| {
                MemoryError::InvalidInput("state history route is unavailable".into())
            })?;
        let history_path = location.project_root.join(&history_relative);
        let mut history_write =
            match read_optional_bounded_regular(&history_path, "migration state history target")? {
                Some(current) if current == history => {
                    counts.duplicates = counts.duplicates.saturating_add(1);
                    skip_write(
                        source,
                        &history_relative,
                        Some(sha256_bytes(current.as_bytes())),
                        &current,
                        "state-history",
                    )?
                }
                Some(current) => {
                    counts.conflicts = counts.conflicts.saturating_add(1);
                    conflict_write(
                        source,
                        &history_relative,
                        Some(sha256_bytes(current.as_bytes())),
                        "migration state history target already contains different content",
                    )
                }
                None => write_operation(
                    source,
                    &history_relative,
                    LegacyMigrationAction::Create,
                    None,
                    history,
                ),
            };
        history_write.public.source_kind = "state-history".into();
        writes.push(history_write);
    }
    let mut grouped = BTreeMap::<String, Vec<&LegacyFile>>::new();
    for source in files.iter().filter(|file| file.kind != "state") {
        let relative = legacy_file_target_relative(source)?;
        grouped.entry(relative).or_default().push(source);
    }
    for (relative, mut origins) in grouped {
        origins.sort_by(|left, right| {
            (
                &left.snapshot_sha256,
                &left.relative_path,
                &left.sha256,
                left.modified_at,
            )
                .cmp(&(
                    &right.snapshot_sha256,
                    &right.relative_path,
                    &right.sha256,
                    right.modified_at,
                ))
        });
        let source = origins[0];
        let desired = render_legacy_note(location, source, &origins, migration_id, None)?;
        let target = location.project_root.join(&relative);
        let mut write = match read_optional_bounded_regular(&target, "migration target")? {
            Some(current) if current == desired => {
                counts.duplicates += 1;
                skip_write(
                    source,
                    &relative,
                    Some(sha256_bytes(current.as_bytes())),
                    &current,
                    &source.kind,
                )?
            }
            Some(current) => {
                counts.conflicts += 1;
                conflict_write(
                    source,
                    &relative,
                    Some(sha256_bytes(current.as_bytes())),
                    "migration target already contains different content",
                )
            }
            None => write_operation(
                source,
                &relative,
                LegacyMigrationAction::Create,
                None,
                desired,
            ),
        };
        write.public.item_count = portable_file_origin_count(&origins) as u32;
        writes.push(write);
    }
    Ok(writes)
}

pub(super) fn plan_database_writes(
    location: &ProjectLocation,
    databases: &[LegacyDatabase],
    migration_id: &str,
    has_repo_state: bool,
    counts: &mut LegacyMigrationCounts,
) -> Result<Vec<PlannedWrite>> {
    let mut writes = Vec::new();
    let logical_ids = databases
        .iter()
        .flat_map(|database| database.memories.iter())
        .map(|memory| {
            let record = &memory.record;
            (
                record.id.clone(),
                legacy_logical_id("memory", &location.project_id, &record.id),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let existing_memories = collect_memories(location)?
        .into_iter()
        .map(|memory| (memory.marker.record_id.clone(), memory))
        .collect::<BTreeMap<_, _>>();
    let existing_checkpoints = collect_checkpoints(location)?
        .into_iter()
        .map(|checkpoint| (checkpoint.marker.checkpoint_id.clone(), checkpoint))
        .collect::<BTreeMap<_, _>>();
    let mut memory_groups = BTreeMap::<String, Vec<(&LegacyDatabase, &LegacyMemory)>>::new();
    for database in databases {
        for memory in &database.memories {
            memory_groups
                .entry(memory.record.id.clone())
                .or_default()
                .push((database, memory));
        }
    }
    for (legacy_id, mut group) in memory_groups {
        group.sort_by(|(left_db, _), (right_db, _)| left_db.sha256.cmp(&right_db.sha256));
        let (database, memory) = group[0];
        let record = &memory.record;
        let logical_id = legacy_logical_id("memory", &location.project_id, &legacy_id);
        let relative = record_relative_path(record.kind, &logical_id, record.deleted_at.is_some())?;
        let equivalence = legacy_memory_equivalence_key(memory)?;
        let mut divergent = false;
        for (_, candidate) in group.iter().skip(1) {
            if legacy_memory_equivalence_key(candidate)? != equivalence {
                divergent = true;
                break;
            }
        }
        if divergent {
            counts.conflicts = counts.conflicts.saturating_add(group.len() as u32);
            writes.push(database_conflict(
                "sqlite-memory",
                &database.sha256,
                &relative,
                "the same legacy memory ID has divergent history across mapped workspaces",
            ));
            continue;
        }
        let mapped_links = record
            .links
            .iter()
            .map(|link| {
                let target_id = logical_ids.get(&link.target_id).ok_or_else(|| {
                    MemoryError::InvalidInput(format!(
                        "legacy memory link target is not eligible for migration: {}",
                        link.target_id
                    ))
                })?;
                Ok(super::super::MemoryLink {
                    target_id: target_id.clone(),
                    relation: link.relation.clone(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let input = NewMemory {
            workspace_id: database.workspace_id.clone(),
            kind: record.kind,
            title: record.title.clone(),
            body: record.body.clone(),
            source: record.source,
            source_client: record.source_client.clone(),
            session_id: record.session_id.clone(),
            pinned: record.pinned,
            idempotency_key: memory.idempotency_key.clone(),
            links: mapped_links.clone(),
        };
        super::super::super::validate_memory(&input, super::super::super::MEMORY_TITLE_LIMIT)?;
        validate_legacy_record_chronology(record)?;
        let mut origins = group
            .iter()
            .map(|(origin_database, origin_memory)| MigrationOrigin {
                source_kind: "sqlite-legacy-v1".into(),
                legacy_id: origin_memory.record.id.clone(),
                source_sha256: origin_database.sha256.clone(),
            })
            .collect::<Vec<_>>();
        let source_sha256 = merged_source_sha256(&origins)?;
        let mut marker = RecordMarker {
            schema: 1,
            record_id: logical_id.clone(),
            project_id: location.project_id.clone(),
            kind: record.kind,
            source: record.source,
            source_client: record.source_client.clone(),
            session_id: record.session_id.clone(),
            pinned: record.pinned,
            version: record.version,
            idempotency_key_hash: memory
                .idempotency_key
                .as_deref()
                .map(|key| sha256_bytes(key.as_bytes())),
            payload_hash: memory_payload_hash(&input)?,
            created_at: record.created_at,
            updated_at: record.updated_at,
            deleted_at: record.deleted_at,
            links: mapped_links,
            migration: None,
        };
        if let Some(existing) = existing_memories.get(&logical_id) {
            if !record_history_matches(&existing.marker, &marker) {
                counts.conflicts = counts.conflicts.saturating_add(1);
                writes.push(database_conflict(
                    "sqlite-memory",
                    &source_sha256,
                    &relative,
                    "canonical record ID already has different history",
                ));
                continue;
            }
            if let Some(provenance) = existing.marker.migration.as_ref() {
                origins.extend(provenance.origins.clone());
            }
        }
        normalize_origins(&mut origins)?;
        let origin_count = origins.len() as u32;
        marker.migration = Some(MigrationProvenance {
            migration_id: migration_id.into(),
            legacy_id,
            source_sha256: merged_source_sha256(&origins)?,
            origins,
        });
        let desired = render_memory_note(location, &marker, &record.title, &record.body)?;
        if let Some(existing) = existing_memories.get(&logical_id) {
            counts.duplicates = counts.duplicates.saturating_add(group.len() as u32);
            if desired
                == read_bounded_regular(
                    &location.project_root.join(&existing.relative_path),
                    "canonical memory",
                )?
            {
                let mut duplicate = LegacyMigrationOperation {
                    action: LegacyMigrationAction::SkipDuplicate,
                    source_kind: "sqlite-memory".into(),
                    source_relative_path: None,
                    source_sha256: source_sha256.clone(),
                    target_relative_path: existing.relative_path.clone(),
                    expected_target_sha256: Some(existing.sha256.clone()),
                    target_sha256: Some(existing.sha256.clone()),
                    item_count: origin_count,
                    conflict: None,
                }
                .into_planned(None);
                duplicate.evidence = vec![CutoverTarget {
                    source_kind: "sqlite-memory".into(),
                    artifact_kind: "canonical-memory".into(),
                    artifact_id: existing.marker.record_id.clone(),
                    relative_path: None,
                    lineage_sha256: None,
                    origin_source_sha256: existing
                        .marker
                        .migration
                        .as_ref()
                        .map(|migration| {
                            migration
                                .origins
                                .iter()
                                .map(|origin| origin.source_sha256.clone())
                                .collect::<BTreeSet<_>>()
                                .into_iter()
                                .collect()
                        })
                        .unwrap_or_default(),
                    origin_provenance_sha256: existing
                        .marker
                        .migration
                        .as_ref()
                        .map(|migration| migration_origins_sha256(&migration.origins))
                        .transpose()?,
                }];
                writes.push(duplicate);
            } else {
                writes.push(PlannedWrite {
                    public: LegacyMigrationOperation {
                        action: LegacyMigrationAction::Append,
                        source_kind: "sqlite-memory".into(),
                        source_relative_path: None,
                        source_sha256,
                        target_relative_path: existing.relative_path.clone(),
                        expected_target_sha256: Some(existing.sha256.clone()),
                        target_sha256: Some(sha256_bytes(desired.as_bytes())),
                        item_count: origin_count,
                        conflict: None,
                    },
                    contents: Some(desired),
                    evidence: Vec::new(),
                });
            }
        } else {
            if group.len() > 1 {
                counts.duplicates = counts.duplicates.saturating_add((group.len() - 1) as u32);
            }
            let target = location.project_root.join(&relative);
            match file_hash_optional(&target)? {
                None => writes.push(database_write(
                    "sqlite-memory",
                    &source_sha256,
                    &relative,
                    desired,
                )),
                Some(_) => {
                    counts.conflicts = counts.conflicts.saturating_add(1);
                    writes.push(database_conflict(
                        "sqlite-memory",
                        &source_sha256,
                        &relative,
                        "canonical record path is occupied",
                    ));
                }
            }
        }
    }

    let mut checkpoint_entries: BTreeMap<String, Vec<(CheckpointMarker, NewCheckpoint, String)>> =
        BTreeMap::new();
    let mut checkpoint_marker_merges =
        BTreeMap::<String, Vec<(CheckpointMarker, CheckpointMarker, String, u32)>>::new();
    let mut latest_state_checkpoint: Option<(CheckpointMarker, NewCheckpoint, String)> = None;
    let existing_checkpoint_equivalence = existing_checkpoints
        .values()
        .map(|checkpoint| (checkpoint_equivalence_key(&checkpoint.marker), checkpoint))
        .collect::<BTreeMap<_, _>>();
    let mut checkpoint_groups =
        BTreeMap::<String, Vec<(&LegacyDatabase, &LegacyCheckpoint)>>::new();
    let mut checkpoint_id_equivalence = BTreeMap::<String, String>::new();
    let mut divergent_checkpoint_ids = BTreeSet::new();
    for database in databases {
        for legacy_checkpoint in &database.checkpoints {
            let equivalence = legacy_checkpoint_equivalence_key(legacy_checkpoint)?;
            if checkpoint_id_equivalence
                .insert(legacy_checkpoint.checkpoint.id.clone(), equivalence.clone())
                .is_some_and(|previous| previous != equivalence)
            {
                divergent_checkpoint_ids.insert(legacy_checkpoint.checkpoint.id.clone());
            }
            checkpoint_groups
                .entry(equivalence)
                .or_default()
                .push((database, legacy_checkpoint));
        }
    }
    for (equivalence, mut group) in checkpoint_groups {
        group.sort_by(|(left_db, left), (right_db, right)| {
            (&left.checkpoint.id, &left.idempotency_key, &left_db.sha256).cmp(&(
                &right.checkpoint.id,
                &right.idempotency_key,
                &right_db.sha256,
            ))
        });
        let (database, legacy_checkpoint) = group[0];
        let checkpoint = &legacy_checkpoint.checkpoint;
        if group
            .iter()
            .any(|(_, checkpoint)| divergent_checkpoint_ids.contains(&checkpoint.checkpoint.id))
        {
            counts.conflicts = counts.conflicts.saturating_add(group.len() as u32);
            writes.push(database_conflict(
                "sqlite-checkpoint",
                &database.sha256,
                &checkpoint_worklog_relative(checkpoint.created_at)?,
                "the same legacy checkpoint ID has divergent history across mapped workspaces",
            ));
            continue;
        }
        if let Some(existing) = existing_checkpoint_equivalence.get(&equivalence) {
            counts.duplicates = counts.duplicates.saturating_add(group.len() as u32);
            let mut origins = group
                .iter()
                .map(|(origin_database, origin_checkpoint)| MigrationOrigin {
                    source_kind: "sqlite-legacy-v1".into(),
                    legacy_id: origin_checkpoint.checkpoint.id.clone(),
                    source_sha256: origin_database.sha256.clone(),
                })
                .collect::<Vec<_>>();
            if let Some(provenance) = existing.marker.migration.as_ref() {
                origins.extend(provenance.origins.clone());
            }
            normalize_origins(&mut origins)?;
            let origin_count = origins.len() as u32;
            let source_sha256 = merged_source_sha256(&origins)?;
            let mut marker = existing.marker.clone();
            marker.migration = Some(MigrationProvenance {
                migration_id: migration_id.into(),
                legacy_id: checkpoint.id.clone(),
                source_sha256: source_sha256.clone(),
                origins,
            });
            let mut merge_writes = plan_checkpoint_provenance_merge(
                location,
                existing,
                &marker,
                &source_sha256,
                origin_count,
            )?;
            // Worklog markers sharing a day are rewritten in one CAS
            // postimage below. Decision notes have unique canonical paths and
            // can be planned independently.
            merge_writes.retain(|write| write.public.source_kind != "sqlite-checkpoint");
            writes.extend(merge_writes);
            checkpoint_marker_merges
                .entry(existing.relative_path.clone())
                .or_default()
                .push((existing.marker.clone(), marker, source_sha256, origin_count));
            continue;
        }
        let logical_id =
            legacy_logical_id("checkpoint-equivalence", &location.project_id, &equivalence);
        let input = NewCheckpoint {
            workspace_id: database.workspace_id.clone(),
            summary: checkpoint.summary.clone(),
            decisions: checkpoint.decisions.clone(),
            next_actions: checkpoint.next_actions.clone(),
            changed_paths: checkpoint.changed_paths.clone(),
            source: checkpoint.source,
            source_client: checkpoint.source_client.clone(),
            session_id: checkpoint.session_id.clone(),
            idempotency_key: legacy_checkpoint.idempotency_key.clone(),
        };
        super::super::super::validate_checkpoint(&input)?;
        if checkpoint.created_at < 0 {
            return Err(MemoryError::InvalidInput(
                "legacy checkpoint timestamp is invalid".into(),
            ));
        }
        let mut origins = group
            .iter()
            .map(|(origin_database, origin_checkpoint)| MigrationOrigin {
                source_kind: "sqlite-legacy-v1".into(),
                legacy_id: origin_checkpoint.checkpoint.id.clone(),
                source_sha256: origin_database.sha256.clone(),
            })
            .collect::<Vec<_>>();
        normalize_origins(&mut origins)?;
        let origin_count = origins.len() as u32;
        let source_sha256 = merged_source_sha256(&origins)?;
        let marker = CheckpointMarker {
            schema: 1,
            checkpoint_id: logical_id.clone(),
            project_id: location.project_id.clone(),
            source: checkpoint.source,
            source_client: checkpoint.source_client.clone(),
            session_id: checkpoint.session_id.clone(),
            idempotency_key_hash: legacy_checkpoint
                .idempotency_key
                .as_deref()
                .map(|key| sha256_bytes(key.as_bytes())),
            payload_hash: checkpoint_payload_hash(&input, legacy_checkpoint.updates_state)?,
            created_at: checkpoint.created_at,
            updates_state: legacy_checkpoint.updates_state,
            summary: checkpoint.summary.clone(),
            decisions: checkpoint.decisions.clone(),
            next_actions: checkpoint.next_actions.clone(),
            changed_paths: checkpoint.changed_paths.clone(),
            migration: Some(MigrationProvenance {
                migration_id: migration_id.into(),
                legacy_id: checkpoint.id.clone(),
                source_sha256: source_sha256.clone(),
                origins,
            }),
        };
        if marker.updates_state
            && latest_state_checkpoint
                .as_ref()
                .is_none_or(|(latest, _, _)| {
                    (&marker.created_at, &marker.checkpoint_id)
                        > (&latest.created_at, &latest.checkpoint_id)
                })
        {
            latest_state_checkpoint = Some((marker.clone(), input.clone(), source_sha256.clone()));
        }
        if let Some(existing) = existing_checkpoints.get(&logical_id) {
            if existing.marker.payload_hash == marker.payload_hash {
                counts.duplicates += 1;
                let existing_sha =
                    file_hash_optional(&location.project_root.join(&existing.relative_path))?
                        .ok_or_else(|| {
                            MemoryError::InvalidInput(
                                "canonical checkpoint disappeared during migration preview".into(),
                            )
                        })?;
                let mut duplicate = LegacyMigrationOperation {
                    action: LegacyMigrationAction::SkipDuplicate,
                    source_kind: "sqlite-checkpoint".into(),
                    source_relative_path: None,
                    source_sha256: source_sha256.clone(),
                    target_relative_path: existing.relative_path.clone(),
                    expected_target_sha256: Some(existing_sha.clone()),
                    target_sha256: Some(existing_sha),
                    item_count: origin_count,
                    conflict: None,
                }
                .into_planned(None);
                duplicate.evidence =
                    vec![checkpoint_evidence("sqlite-checkpoint", &existing.marker)];
                writes.push(duplicate);
                writes.extend(existing_checkpoint_decision_evidence(
                    location,
                    existing,
                    &source_sha256,
                )?);
                continue;
            }
            counts.conflicts += 1;
            writes.push(database_conflict(
                "sqlite-checkpoint",
                &source_sha256,
                &existing.relative_path,
                "canonical checkpoint ID already has different history",
            ));
            continue;
        }
        let relative = checkpoint_worklog_relative(checkpoint.created_at)?;
        if origin_count > 1 {
            counts.duplicates = counts.duplicates.saturating_add((group.len() - 1) as u32);
            let existing_hash = file_hash_optional(&location.project_root.join(&relative))?;
            writes.push(
                LegacyMigrationOperation {
                    action: LegacyMigrationAction::SkipDuplicate,
                    source_kind: "sqlite-checkpoint".into(),
                    source_relative_path: None,
                    source_sha256: source_sha256.clone(),
                    target_relative_path: relative.clone(),
                    expected_target_sha256: existing_hash.clone(),
                    target_sha256: existing_hash,
                    item_count: origin_count - 1,
                    conflict: None,
                }
                .into_planned(None),
            );
        }
        checkpoint_entries
            .entry(relative)
            .or_default()
            .push((marker, input, source_sha256));
    }
    let checkpoint_paths = checkpoint_entries
        .keys()
        .chain(checkpoint_marker_merges.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for relative in checkpoint_paths {
        let mut entries = checkpoint_entries.remove(&relative).unwrap_or_default();
        entries.sort_by_key(|(marker, _, _)| (marker.created_at, marker.checkpoint_id.clone()));
        let mut marker_merges = checkpoint_marker_merges
            .remove(&relative)
            .unwrap_or_default();
        marker_merges.sort_by(|(left, _, _, _), (right, _, _, _)| {
            left.checkpoint_id.cmp(&right.checkpoint_id)
        });
        let path = location.project_root.join(&relative);
        let existing = read_optional_bounded_regular(&path, "canonical Worklog")?;
        let day = relative
            .trim_end_matches(".md")
            .rsplit('/')
            .next()
            .unwrap_or("1970-01-01");
        let mut desired = existing.clone().unwrap_or_else(|| {
            format!(
                "---\ntitle: \"{} — {}\"\ntype: worklog\ndate: {}\n---\n\n# {} — {}\n",
                location.project_display_name.replace('"', "\\\""),
                day,
                day,
                location.project_display_name,
                day
            )
        });
        let mut source_hashes = BTreeSet::new();
        let mut item_count = entries.len() as u32;
        for (old_marker, new_marker, source_hash, merged_items) in marker_merges {
            let old_line = format!(
                "<!-- kodmem-checkpoint {} -->",
                serde_json::to_string(&old_marker)?
            );
            let new_line = format!(
                "<!-- kodmem-checkpoint {} -->",
                serde_json::to_string(&new_marker)?
            );
            if desired.matches(&old_line).count() != 1 {
                return Err(MemoryError::InvalidInput(
                    "canonical checkpoint marker is not uniquely replaceable".into(),
                ));
            }
            desired = desired.replacen(&old_line, &new_line, 1);
            source_hashes.insert(source_hash);
            item_count = item_count.saturating_add(merged_items);
        }
        for (marker, input, entry_source_hash) in entries {
            if let Some(provenance) = marker.migration.as_ref() {
                source_hashes.insert(provenance.source_sha256.clone());
            }
            desired.push_str(&render_checkpoint_entry(&marker, &input)?);
            for (index, decision) in input.decisions.iter().enumerate() {
                let decision_relative = checkpoint_decision_relative(&marker.checkpoint_id, index)?;
                let decision_text = render_checkpoint_decision(location, &marker, index, decision)?;
                let decision_path = location.project_root.join(&decision_relative);
                match file_hash_optional(&decision_path)? {
                    None => writes.push(database_write(
                        "sqlite-checkpoint-decision",
                        &entry_source_hash,
                        &decision_relative,
                        decision_text,
                    )),
                    Some(hash) if hash == sha256_bytes(decision_text.as_bytes()) => {
                        counts.duplicates += 1
                    }
                    Some(_) => {
                        counts.conflicts += 1;
                        writes.push(database_conflict(
                            "sqlite-checkpoint-decision",
                            &entry_source_hash,
                            &decision_relative,
                            "checkpoint decision path is occupied",
                        ));
                    }
                }
            }
        }
        let source_hash = if source_hashes.len() == 1 {
            source_hashes.into_iter().next().unwrap_or_default()
        } else {
            sha256_bytes(&serde_json::to_vec(&source_hashes)?)
        };
        writes.push(PlannedWrite {
            public: LegacyMigrationOperation {
                action: if existing.is_some() {
                    LegacyMigrationAction::Append
                } else {
                    LegacyMigrationAction::Create
                },
                source_kind: "sqlite-checkpoint".into(),
                source_relative_path: None,
                source_sha256: source_hash,
                target_relative_path: relative,
                expected_target_sha256: existing
                    .as_deref()
                    .map(|text| sha256_bytes(text.as_bytes())),
                target_sha256: Some(sha256_bytes(desired.as_bytes())),
                item_count,
                conflict: None,
            },
            contents: Some(desired),
            evidence: Vec::new(),
        });
    }
    if !has_repo_state {
        if let Some((marker, input, source_hash)) = latest_state_checkpoint {
            let state_relative = state_relative_path()?;
            let target = location.project_root.join(&state_relative);
            let current = read_bounded_regular(&target, "projects-vault STATE.md")?;
            let current_hash = sha256_bytes(current.as_bytes());
            let provenance = marker.migration.as_ref().ok_or_else(|| {
                MemoryError::InvalidInput("migrated state checkpoint lacks provenance".into())
            })?;
            let lineage = state_lineage_token(&provenance.migration_id, &marker.checkpoint_id);
            let desired = render_state(location, &marker, &input, Some(&lineage));
            if current == desired {
                counts.duplicates += 1;
                writes.push(
                    LegacyMigrationOperation {
                        action: LegacyMigrationAction::SkipDuplicate,
                        source_kind: "sqlite-checkpoint-state".into(),
                        source_relative_path: None,
                        source_sha256: source_hash,
                        target_relative_path: state_relative.clone(),
                        expected_target_sha256: Some(current_hash.clone()),
                        target_sha256: Some(current_hash),
                        item_count: 1,
                        conflict: None,
                    }
                    .into_planned(None),
                );
            } else if is_scaffold_state_placeholder(location, &current)? {
                writes.push(
                    LegacyMigrationOperation {
                        action: LegacyMigrationAction::ReplacePlaceholder,
                        source_kind: "sqlite-checkpoint-state".into(),
                        source_relative_path: None,
                        source_sha256: source_hash,
                        target_relative_path: state_relative.clone(),
                        expected_target_sha256: Some(current_hash),
                        target_sha256: Some(sha256_bytes(desired.as_bytes())),
                        item_count: 1,
                        conflict: None,
                    }
                    .into_planned(Some(desired)),
                );
            } else {
                counts.conflicts += 1;
                writes.push(database_conflict_with_preimage(
                    "sqlite-checkpoint-state",
                    &source_hash,
                    &state_relative,
                    Some(current_hash),
                    "projects-vault STATE.md contains non-placeholder content",
                ));
            }
        }
    }
    Ok(writes)
}

impl LegacyMigrationOperation {
    fn into_planned(self, contents: Option<String>) -> PlannedWrite {
        PlannedWrite {
            public: self,
            contents,
            evidence: Vec::new(),
        }
    }
}

pub(super) fn write_operation(
    source: &LegacyFile,
    target: &str,
    action: LegacyMigrationAction,
    expected: Option<String>,
    contents: String,
) -> PlannedWrite {
    LegacyMigrationOperation {
        action,
        source_kind: source.kind.clone(),
        source_relative_path: Some(source.relative_path.clone()),
        source_sha256: source.sha256.clone(),
        target_relative_path: target.into(),
        expected_target_sha256: expected,
        target_sha256: Some(sha256_bytes(contents.as_bytes())),
        item_count: 1,
        conflict: None,
    }
    .into_planned(Some(contents))
}

pub(super) fn skip_write(
    source: &LegacyFile,
    target: &str,
    expected: Option<String>,
    evidence_text: &str,
    source_kind: &str,
) -> Result<PlannedWrite> {
    let mut write = write_operation(
        source,
        target,
        LegacyMigrationAction::SkipDuplicate,
        expected.clone(),
        String::new(),
    )
    .with_no_content();
    write.public.target_sha256 = expected;
    write.public.source_kind = source_kind.into();
    write.evidence = cutover_artifacts_from_text(evidence_text, source_kind, target, None)?;
    Ok(write)
}

impl PlannedWrite {
    fn with_no_content(mut self) -> Self {
        self.contents = None;
        self
    }
}

pub(super) fn conflict_write(
    source: &LegacyFile,
    target: &str,
    expected_target_sha256: Option<String>,
    reason: &str,
) -> PlannedWrite {
    LegacyMigrationOperation {
        action: LegacyMigrationAction::Create,
        source_kind: source.kind.clone(),
        source_relative_path: Some(source.relative_path.clone()),
        source_sha256: source.sha256.clone(),
        target_relative_path: target.into(),
        expected_target_sha256,
        target_sha256: None,
        item_count: 1,
        conflict: Some(reason.into()),
    }
    .into_planned(None)
}

pub(super) fn database_write(
    kind: &str,
    source_hash: &str,
    target: &str,
    contents: String,
) -> PlannedWrite {
    LegacyMigrationOperation {
        action: LegacyMigrationAction::Create,
        source_kind: kind.into(),
        source_relative_path: None,
        source_sha256: source_hash.into(),
        target_relative_path: target.into(),
        expected_target_sha256: None,
        target_sha256: Some(sha256_bytes(contents.as_bytes())),
        item_count: 1,
        conflict: None,
    }
    .into_planned(Some(contents))
}

pub(super) fn database_conflict(
    kind: &str,
    source_hash: &str,
    target: &str,
    reason: &str,
) -> PlannedWrite {
    database_conflict_with_preimage(kind, source_hash, target, None, reason)
}

pub(super) fn database_conflict_with_preimage(
    kind: &str,
    source_hash: &str,
    target: &str,
    expected_target_sha256: Option<String>,
    reason: &str,
) -> PlannedWrite {
    LegacyMigrationOperation {
        action: LegacyMigrationAction::Create,
        source_kind: kind.into(),
        source_relative_path: None,
        source_sha256: source_hash.into(),
        target_relative_path: target.into(),
        expected_target_sha256,
        target_sha256: None,
        item_count: 1,
        conflict: Some(reason.into()),
    }
    .into_planned(None)
}

pub(super) fn render_legacy_note(
    location: &ProjectLocation,
    source: &LegacyFile,
    origins: &[&LegacyFile],
    migration_id: &str,
    state_checkpoint_id: Option<&str>,
) -> Result<String> {
    let source_policy = repo_source_for_kind(&source.kind)?;
    let source_origins = origins
        .iter()
        .fold(BTreeMap::new(), |mut portable, origin| {
            let key = (
                origin.snapshot_sha256.clone(),
                origin.relative_path.clone(),
                origin.sha256.clone(),
            );
            portable
                .entry(key)
                // A byte-identical checkout can have an older filesystem
                // timestamp after clone/copy. The latest observation keeps a
                // second local registration from aging portable provenance.
                .and_modify(|modified_at: &mut i64| {
                    *modified_at = (*modified_at).max(origin.modified_at)
                })
                .or_insert(origin.modified_at);
            portable
        })
        .into_iter()
        .map(
            |((snapshot_sha256, relative_path, source_sha256), modified_at)| {
                serde_json::json!({
                    "sourceKind": "repo-readable-v1",
                    "sourceSnapshotSha256": snapshot_sha256,
                    "legacyIdentity": relative_path,
                    "sourceSha256": source_sha256,
                    "sourceModifiedAt": modified_at,
                })
            },
        )
        .collect::<Vec<_>>();
    let source_modified_at = source_origins
        .iter()
        .filter_map(|origin| {
            origin
                .get("sourceModifiedAt")
                .and_then(|value| value.as_i64())
        })
        .max()
        .unwrap_or(source.modified_at);
    let marker = serde_json::json!({
        "schema": 1,
        "migrationId": migration_id,
        "sourceSha256": source.sha256,
        "sourceSnapshotSha256": source.snapshot_sha256,
        "sourceOrigins": source_origins,
        "sourceModifiedAt": source_modified_at,
    });
    let state_marker = state_checkpoint_id
        .map(|checkpoint_id| {
            format!(
                "<!-- kodmem-state {{\"schema\":1,\"checkpointId\":{}}} -->\n",
                serde_json::to_string(checkpoint_id).expect("checkpoint ID serializes")
            )
        })
        .unwrap_or_default();
    let migration_marker = format!(
        "{MIGRATION_NOTE_PREFIX}{} -->",
        serde_json::to_string(&marker)?
    );
    render_template(
        &migration_policy()?.repo_note_template,
        &[
            (
                "title_json",
                serde_json::to_string(&format!("Legacy {}", source.kind))?,
            ),
            ("type", source_policy.note_type.clone()),
            ("status", source_policy.status.clone()),
            ("project_id", location.project_id.clone()),
            ("source_modified_at", source_modified_at.to_string()),
            ("state_marker", state_marker),
            ("migration_marker", migration_marker),
            ("kind", source.kind.clone()),
            ("source_text", source.text.trim_end().into()),
        ],
    )
}

pub(super) fn is_scaffold_state_placeholder(
    location: &ProjectLocation,
    text: &str,
) -> Result<bool> {
    Ok(text
        == super::super::super::scaffold::rendered_file_placeholder(
            &location.project_id,
            &location.project_display_name,
            &state_relative_path()?,
        )?)
}

pub(super) fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_') {
                value
            } else {
                '-'
            }
        })
        .collect()
}

pub(super) fn legacy_logical_id(scope: &str, project_id: &str, legacy_id: &str) -> String {
    let hash = sha256_bytes(format!("legacy-{scope}\0{project_id}\0{legacy_id}").as_bytes());
    format!("km_{}", &hash[..32])
}
