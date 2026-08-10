use super::*;

pub(crate) fn migration_note_is_visible(
    project_text: &str,
    note_text: &str,
    project_id: &str,
) -> Result<bool> {
    if let Some(marker_line) = canonical_repo_migration_marker(note_text) {
        let marker = parse_repo_migration_marker(marker_line)?;
        let Some(cutover) = parse_cutover_marker(project_text, project_id)? else {
            return Ok(false);
        };
        return Ok(cutover
            .migrations
            .iter()
            .any(|migration| migration.migration_id == marker.migration_id));
    }
    let mut migration_ids = BTreeSet::new();
    let canonical_frontmatter_marker = first_marker_after_frontmatter(note_text);
    if frontmatter_declares_legacy_timestamp(note_text)
        && canonical_frontmatter_marker.is_none_or(|marker| {
            !marker.starts_with(MIGRATION_NOTE_PREFIX) && !marker.starts_with("<!-- kodmem-state ")
        })
    {
        return Err(MemoryError::InvalidInput(
            "migration-owned Markdown is missing its canonical provenance marker".into(),
        ));
    }
    let lines = note_text.lines().collect::<Vec<_>>();
    let mut fenced = false;
    let mut frontmatter_marker_consumed = false;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }

        let canonical_frontmatter_slot = !frontmatter_marker_consumed
            && canonical_frontmatter_marker.is_some_and(|marker| marker == trimmed);
        let canonical_state_migration_slot = !frontmatter_marker_consumed
            && index > 0
            && lines[index - 1].trim().starts_with("<!-- kodmem-state ")
            && canonical_frontmatter_marker.is_some_and(|marker| marker == lines[index - 1].trim());
        if trimmed.starts_with(MIGRATION_NOTE_PREFIX) {
            if !canonical_frontmatter_slot && !canonical_state_migration_slot {
                continue;
            }
            migration_ids.insert(parse_owned_migration_id(trimmed)?);
            frontmatter_marker_consumed = true;
            continue;
        }
        if trimmed.starts_with("<!-- kodmem-memory ") {
            if !canonical_frontmatter_slot {
                continue;
            }
            if let Some(migration_id) =
                migration_id_from_canonical_marker(trimmed, "<!-- kodmem-memory ")?
            {
                migration_ids.insert(migration_id);
                frontmatter_marker_consumed = true;
            }
            continue;
        }
        if trimmed.starts_with("<!-- kodmem-checkpoint ") {
            let canonical_checkpoint_slot = index > 0
                && lines[index - 1].is_empty()
                && lines
                    .get(index + 1)
                    .is_some_and(|next| next.starts_with("## "));
            if canonical_checkpoint_slot {
                if let Some(migration_id) =
                    migration_id_from_canonical_marker(trimmed, "<!-- kodmem-checkpoint ")?
                {
                    migration_ids.insert(migration_id);
                }
            }
            continue;
        }
        if trimmed.starts_with("<!-- kodmem-checkpoint-decision ") {
            if !canonical_frontmatter_slot {
                continue;
            }
            if let Some(migration_id) =
                migration_id_from_canonical_marker(trimmed, "<!-- kodmem-checkpoint-decision ")?
            {
                migration_ids.insert(migration_id);
                frontmatter_marker_consumed = true;
            }
        }
    }
    if migration_ids.is_empty() {
        return Ok(true);
    }
    let Some(cutover) = parse_cutover_marker(project_text, project_id)? else {
        return Ok(false);
    };
    let completed = cutover
        .migrations
        .iter()
        .map(|migration| migration.migration_id.as_str())
        .collect::<BTreeSet<_>>();
    Ok(migration_ids
        .iter()
        .all(|migration_id| completed.contains(migration_id.as_str())))
}

pub(super) fn frontmatter_declares_legacy_timestamp(text: &str) -> bool {
    let mut lines = text.lines();
    if lines.next().is_none_or(|line| line.trim() != "---") {
        return false;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if line.trim_start().starts_with("legacy_source_updated_at:") {
            return true;
        }
    }
    false
}

pub(in crate::memory::portable) fn migration_artifacts_authorized(
    location: &ProjectLocation,
    project_text: &str,
) -> Result<bool> {
    let policy = migration_policy()?;
    let cutover = parse_cutover_marker(project_text, &location.project_id)?;
    let paths = scaffold_markdown_paths(location, policy.max_target_scan_files)?;
    let mut scanned_bytes = 0_usize;
    for path in paths {
        let Some(text) = read_optional_bounded_regular(&path, "migration-owned project note")?
        else {
            continue;
        };
        scanned_bytes = scanned_bytes.saturating_add(text.len());
        if scanned_bytes > policy.max_canonical_bytes {
            return Err(MemoryError::InvalidInput(
                "mapped project exceeds the migration authority byte limit".into(),
            ));
        }
        if !migration_note_is_visible(project_text, &text, &location.project_id)? {
            return Ok(false);
        }
        let Some(cutover) = cutover.as_ref() else {
            continue;
        };
        let relative = path
            .strip_prefix(&location.project_root)
            .map_err(|_| MemoryError::InvalidInput("migration scan path escaped".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        if let Some(marker_line) = canonical_repo_migration_marker(&text) {
            let marker = parse_repo_migration_marker(marker_line)?;
            let artifact_kind = if relative == state_relative_path()? {
                "state-lineage"
            } else {
                "legacy-wrapper"
            };
            let named = cutover.migrations.iter().any(|migration| {
                migration.migration_id == marker.migration_id
                    && migration.targets.iter().any(|target| {
                        target.artifact_kind == artifact_kind
                            && target.artifact_id == marker.source_sha256
                            && (artifact_kind == "state-lineage"
                                || target.relative_path.as_deref() == Some(relative.as_str()))
                    })
            });
            if !named {
                return Ok(false);
            }
        } else if first_marker_after_frontmatter(&text)
            .is_some_and(|line| line.starts_with("<!-- kodmem-checkpoint-decision "))
        {
            let marker: CheckpointDecisionMarker = parse_canonical_marker(
                first_marker_after_frontmatter(&text).expect("marker checked above"),
                "<!-- kodmem-checkpoint-decision ",
            )?;
            if let Some(provenance) = marker.migration.as_ref() {
                let artifact_id = format!("{}:{}", marker.checkpoint_id, marker.index);
                let named = cutover.migrations.iter().any(|migration| {
                    migration.migration_id == provenance.migration_id
                        && migration.targets.iter().any(|target| {
                            target.artifact_kind == "checkpoint-decision"
                                && target.artifact_id == artifact_id
                                && target.relative_path.as_deref() == Some(relative.as_str())
                        })
                });
                if !named {
                    return Ok(false);
                }
            }
        }
    }
    if let Some(cutover) = cutover {
        let memories = collect_memories(location)?;
        let checkpoints = collect_checkpoints(location)?;
        let imported_databases = cutover
            .migrations
            .iter()
            .flat_map(|migration| migration.source_snapshots.iter())
            .filter(|receipt| receipt.kind == "sqlite-legacy-v1")
            .map(|receipt| receipt.sha256.as_str())
            .collect::<BTreeSet<_>>();
        for memory in memories
            .iter()
            .filter(|memory| memory.marker.migration.is_some())
        {
            if !cutover.migrations.iter().any(|migration| {
                migration.targets.iter().any(|target| {
                    target.artifact_kind == "canonical-memory"
                        && target.artifact_id == memory.marker.record_id
                        && canonical_provenance_satisfies(
                            memory.marker.migration.as_ref(),
                            target,
                            &cutover,
                            &imported_databases,
                        )
                        .unwrap_or(false)
                })
            }) {
                return Ok(false);
            }
        }
        for checkpoint in checkpoints
            .iter()
            .filter(|checkpoint| checkpoint.marker.migration.is_some())
        {
            if !cutover.migrations.iter().any(|migration| {
                migration.targets.iter().any(|target| {
                    target.artifact_kind == "canonical-checkpoint"
                        && target.artifact_id == checkpoint.marker.checkpoint_id
                        && canonical_provenance_satisfies(
                            checkpoint.marker.migration.as_ref(),
                            target,
                            &cutover,
                            &imported_databases,
                        )
                        .unwrap_or(false)
                })
            }) {
                return Ok(false);
            }
        }
        for migration in &cutover.migrations {
            for target in &migration.targets {
                match target.artifact_kind.as_str() {
                    "canonical-memory" => {
                        let Some(memory) = memories
                            .iter()
                            .find(|memory| memory.marker.record_id == target.artifact_id)
                        else {
                            return Ok(false);
                        };
                        if !canonical_provenance_satisfies(
                            memory.marker.migration.as_ref(),
                            target,
                            &cutover,
                            &imported_databases,
                        )? {
                            return Ok(false);
                        }
                    }
                    "canonical-checkpoint" => {
                        let Some(checkpoint) = checkpoints.iter().find(|checkpoint| {
                            checkpoint.marker.checkpoint_id == target.artifact_id
                        }) else {
                            return Ok(false);
                        };
                        if !canonical_provenance_satisfies(
                            checkpoint.marker.migration.as_ref(),
                            target,
                            &cutover,
                            &imported_databases,
                        )? {
                            return Ok(false);
                        }
                    }
                    "state-lineage" => {
                        let Some(text) = read_optional_bounded_regular(
                            &location.project_root.join(state_relative_path()?),
                            "migration state lineage",
                        )?
                        else {
                            return Ok(false);
                        };
                        if !migration_note_is_visible(project_text, &text, &location.project_id)? {
                            return Ok(false);
                        }
                        let lineage_matches = state_lineage_sha256(&text)?
                            .as_ref()
                            .is_some_and(|lineage| target.lineage_sha256.as_ref() == Some(lineage));
                        let valid_state_checkpoint = state_checkpoint_id(&text)?.is_none_or(|id| {
                            checkpoints
                                .iter()
                                .any(|checkpoint| checkpoint.marker.checkpoint_id == id)
                        });
                        let expected_lineage =
                            state_lineage_token(&migration.migration_id, &target.artifact_id);
                        let target_is_bound = if target.source_kind == "state" {
                            target.lineage_sha256.as_deref() == Some(expected_lineage.as_str())
                        } else if target.source_kind == "sqlite-checkpoint-state" {
                            checkpoints.iter().any(|checkpoint| {
                                checkpoint.marker.checkpoint_id == target.artifact_id
                                    && cutover.migrations.iter().any(|owner| {
                                        owner.targets.iter().any(|candidate| {
                                            candidate.artifact_kind == "canonical-checkpoint"
                                                && candidate.artifact_id == target.artifact_id
                                                && canonical_provenance_satisfies(
                                                    checkpoint.marker.migration.as_ref(),
                                                    candidate,
                                                    &cutover,
                                                    &imported_databases,
                                                )
                                                .unwrap_or(false)
                                        })
                                    })
                                    && target.lineage_sha256.as_deref()
                                        == Some(expected_lineage.as_str())
                            })
                        } else {
                            false
                        };
                        if !target_is_bound || !lineage_matches || !valid_state_checkpoint {
                            return Ok(false);
                        }
                    }
                    "legacy-wrapper" | "checkpoint-decision" => {
                        let relative = target.relative_path.as_deref().ok_or_else(|| {
                            MemoryError::InvalidInput(
                                "Project.md cutover target path is missing".into(),
                            )
                        })?;
                        let path = confined_target(location, relative)?;
                        let Some(text) =
                            read_optional_bounded_regular(&path, "migration cutover target")?
                        else {
                            return Ok(false);
                        };
                        if !migration_note_is_visible(project_text, &text, &location.project_id)? {
                            return Ok(false);
                        }
                        if target.artifact_kind == "legacy-wrapper" {
                            let Some(marker_line) = canonical_repo_migration_marker(&text) else {
                                return Ok(false);
                            };
                            let marker = parse_repo_migration_marker(marker_line)?;
                            let imported_repo_snapshots = migration
                                .source_snapshots
                                .iter()
                                .filter(|receipt| receipt.kind == "repo-readable-v1")
                                .map(|receipt| receipt.sha256.as_str())
                                .collect::<BTreeSet<_>>();
                            if marker.migration_id != migration.migration_id
                                || marker.source_sha256 != target.artifact_id
                                || marker.source_origins.iter().any(|origin| {
                                    !imported_repo_snapshots
                                        .contains(origin.source_snapshot_sha256.as_str())
                                        || origin.source_sha256 != target.artifact_id
                                        || !repo_origin_matches_target(
                                            origin,
                                            &target.source_kind,
                                            relative,
                                        )
                                })
                            {
                                return Ok(false);
                            }
                            if !cutover_artifacts_from_text(
                                &text,
                                &target.source_kind,
                                relative,
                                Some(&migration.migration_id),
                            )?
                            .iter()
                            .any(|candidate| {
                                candidate.artifact_kind == target.artifact_kind
                                    && candidate.artifact_id == target.artifact_id
                                    && candidate.origin_provenance_sha256
                                        == target.origin_provenance_sha256
                            }) {
                                return Ok(false);
                            }
                        } else {
                            let Some(marker_line) = first_marker_after_frontmatter(&text) else {
                                return Ok(false);
                            };
                            let marker: CheckpointDecisionMarker = parse_canonical_marker(
                                marker_line,
                                "<!-- kodmem-checkpoint-decision ",
                            )?;
                            if !canonical_provenance_satisfies(
                                marker.migration.as_ref(),
                                target,
                                &cutover,
                                &imported_databases,
                            )? {
                                return Ok(false);
                            }
                        }
                    }
                    _ => {
                        return Err(MemoryError::InvalidInput(
                            "Project.md cutover target kind is unsupported".into(),
                        ));
                    }
                }
            }
        }
    }
    Ok(true)
}

pub(super) fn repo_origin_matches_target(
    origin: &RepoMigrationOrigin,
    target_source_kind: &str,
    target_relative: &str,
) -> bool {
    let Ok(source_policy) = repo_source_for_identity(&origin.legacy_identity) else {
        return false;
    };
    let source_kind = source_policy.kind.as_str();
    let expected_source_kind = if target_source_kind == "state-history" {
        "state"
    } else {
        target_source_kind
    };
    if source_kind != expected_source_kind {
        return false;
    }
    let file = LegacyFile {
        workspace_id: String::new(),
        relative_path: origin.legacy_identity.clone(),
        kind: source_kind.into(),
        text: String::new(),
        sha256: origin.source_sha256.clone(),
        snapshot_sha256: origin.source_snapshot_sha256.clone(),
        modified_at: origin.source_modified_at,
    };
    if target_source_kind == "state-history" {
        return render_repo_history_target(source_policy, &file)
            .is_ok_and(|expected| expected.as_deref() == Some(target_relative));
    }
    render_repo_target(source_policy, &file).is_ok_and(|expected| expected == target_relative)
}

pub(super) fn canonical_provenance_satisfies(
    provenance: Option<&MigrationProvenance>,
    target: &CutoverTarget,
    cutover: &CutoverMarker,
    imported_databases: &BTreeSet<&str>,
) -> Result<bool> {
    let Some(provenance) = provenance else {
        return Ok(false);
    };
    if provenance.origins.is_empty()
        || !provenance
            .origins
            .iter()
            .any(|origin| origin.legacy_id == provenance.legacy_id)
        || merged_source_sha256(&provenance.origins)? != provenance.source_sha256
    {
        return Ok(false);
    }
    let current = provenance
        .origins
        .iter()
        .map(|origin| origin.source_sha256.as_str())
        .collect::<BTreeSet<_>>();
    let origin_provenance_sha256 = migration_origins_sha256(&provenance.origins)?;
    let chain_valid = canonical_origin_chain_satisfies(
        cutover,
        &target.artifact_kind,
        &target.artifact_id,
        &provenance.migration_id,
        &origin_provenance_sha256,
        &provenance.origins,
        &current,
    )?;
    Ok(chain_valid
        && !target.origin_source_sha256.is_empty()
        && target.origin_provenance_sha256.is_some()
        && target
            .origin_source_sha256
            .iter()
            .all(|source| current.contains(source.as_str()))
        && current
            .iter()
            .all(|source| imported_databases.contains(source)))
}

pub(super) fn canonical_origin_chain_satisfies(
    cutover: &CutoverMarker,
    artifact_kind: &str,
    artifact_id: &str,
    current_migration_id: &str,
    current_provenance_sha256: &str,
    current_origins: &[MigrationOrigin],
    current: &BTreeSet<&str>,
) -> Result<bool> {
    let nodes = cutover
        .migrations
        .iter()
        .flat_map(|migration| {
            migration
                .targets
                .iter()
                .filter(move |target| {
                    target.artifact_kind == artifact_kind && target.artifact_id == artifact_id
                })
                .map(move |target| {
                    (
                        migration,
                        target,
                        target
                            .origin_source_sha256
                            .iter()
                            .map(String::as_str)
                            .collect::<BTreeSet<_>>(),
                    )
                })
        })
        .collect::<Vec<_>>();
    let current_owners = nodes
        .iter()
        .filter(|(migration, target, origins)| {
            migration.migration_id == current_migration_id
                && target.origin_provenance_sha256.as_deref() == Some(current_provenance_sha256)
                && origins == current
        })
        .count();
    if current_owners != 1 || nodes.is_empty() {
        return Ok(false);
    }
    for (index, (_, _, origins)) in nodes.iter().enumerate() {
        if origins.is_empty() || !origins.is_subset(current) {
            return Ok(false);
        }
        for (_, _, peer) in nodes.iter().skip(index + 1) {
            if origins == peer || (!origins.is_subset(peer) && !peer.is_subset(origins)) {
                return Ok(false);
            }
        }
    }
    for (migration, target, origins) in &nodes {
        let node_origins = current_origins
            .iter()
            .filter(|origin| origins.contains(origin.source_sha256.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let node_sources = node_origins
            .iter()
            .map(|origin| origin.source_sha256.as_str())
            .collect::<BTreeSet<_>>();
        if node_sources != *origins
            || target.origin_provenance_sha256.as_deref()
                != Some(migration_origins_sha256(&node_origins)?.as_str())
        {
            return Ok(false);
        }
        let inherited = nodes
            .iter()
            .filter(|(_, _, candidate)| {
                candidate.len() < origins.len() && candidate.is_subset(origins)
            })
            .flat_map(|(_, _, candidate)| candidate.iter().copied())
            .collect::<BTreeSet<_>>();
        let delta = origins
            .difference(&inherited)
            .copied()
            .collect::<BTreeSet<_>>();
        let owned_receipts = migration
            .source_snapshots
            .iter()
            .filter(|receipt| receipt.kind == "sqlite-legacy-v1")
            .map(|receipt| receipt.sha256.as_str())
            .collect::<BTreeSet<_>>();
        if delta.is_empty() || !delta.is_subset(&owned_receipts) {
            return Ok(false);
        }
    }
    let maximal = nodes
        .iter()
        .filter(|(_, _, origins)| {
            !nodes.iter().any(|(_, _, candidate)| {
                origins.len() < candidate.len() && origins.is_subset(candidate)
            })
        })
        .collect::<Vec<_>>();
    Ok(maximal.len() == 1
        && maximal[0].0.migration_id == current_migration_id
        && &maximal[0].2 == current)
}

pub(super) fn cutover_artifacts_from_text(
    text: &str,
    source_kind: &str,
    relative_path: &str,
    migration_id: Option<&str>,
) -> Result<Vec<CutoverTarget>> {
    if let Some(line) = canonical_repo_migration_marker(text) {
        let marker = parse_repo_migration_marker(line)?;
        if migration_id.is_some_and(|expected| expected != marker.migration_id) {
            return Ok(Vec::new());
        }
        let origin_provenance_sha256 = sha256_bytes(&serde_json::to_vec(&marker.source_origins)?);
        return Ok(vec![CutoverTarget {
            source_kind: source_kind.into(),
            artifact_kind: if source_kind == "state" {
                "state-lineage".into()
            } else {
                "legacy-wrapper".into()
            },
            artifact_id: marker.source_sha256.clone(),
            relative_path: (source_kind != "state").then(|| relative_path.into()),
            lineage_sha256: (source_kind == "state")
                .then(|| state_lineage_token(&marker.migration_id, &marker.source_sha256)),
            origin_source_sha256: Vec::new(),
            origin_provenance_sha256: (source_kind != "state").then_some(origin_provenance_sha256),
        }]);
    }
    let mut artifacts = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        if trimmed.starts_with(MIGRATION_NOTE_PREFIX) {
            // A generated repository wrapper was handled from its exact
            // canonical slot above. Historical marker examples in imported
            // Markdown are inert user content.
            continue;
        } else if trimmed.starts_with("<!-- kodmem-memory ") {
            let marker: RecordMarker = parse_canonical_marker(trimmed, "<!-- kodmem-memory ")?;
            if migration_id.is_none_or(|expected| {
                marker
                    .migration
                    .as_ref()
                    .is_some_and(|migration| migration.migration_id == expected)
            }) {
                artifacts.push(CutoverTarget {
                    source_kind: source_kind.into(),
                    artifact_kind: "canonical-memory".into(),
                    artifact_id: marker.record_id,
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
                        .transpose()?,
                });
            }
        } else if trimmed.starts_with("<!-- kodmem-checkpoint ") {
            let marker: CheckpointMarker =
                parse_canonical_marker(trimmed, "<!-- kodmem-checkpoint ")?;
            if migration_id.is_none_or(|expected| {
                marker
                    .migration
                    .as_ref()
                    .is_some_and(|migration| migration.migration_id == expected)
            }) {
                artifacts.push(CutoverTarget {
                    source_kind: source_kind.into(),
                    artifact_kind: "canonical-checkpoint".into(),
                    artifact_id: marker.checkpoint_id,
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
                        .transpose()?,
                });
            }
        } else if trimmed.starts_with("<!-- kodmem-checkpoint-decision ") {
            let marker: CheckpointDecisionMarker =
                parse_canonical_marker(trimmed, "<!-- kodmem-checkpoint-decision ")?;
            if migration_id.is_none_or(|expected| {
                marker
                    .migration
                    .as_ref()
                    .is_some_and(|migration| migration.migration_id == expected)
            }) {
                artifacts.push(CutoverTarget {
                    source_kind: source_kind.into(),
                    artifact_kind: "checkpoint-decision".into(),
                    artifact_id: format!("{}:{}", marker.checkpoint_id, marker.index),
                    relative_path: Some(relative_path.into()),
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
                        .transpose()?,
                });
            }
        }
    }
    if source_kind == "sqlite-checkpoint-state" {
        if let Some(checkpoint_id) = state_checkpoint_id(text)? {
            artifacts.push(CutoverTarget {
                source_kind: source_kind.into(),
                artifact_kind: "state-lineage".into(),
                artifact_id: checkpoint_id,
                relative_path: None,
                lineage_sha256: state_lineage_sha256(text)?,
                origin_source_sha256: Vec::new(),
                origin_provenance_sha256: None,
            });
        }
    }
    Ok(artifacts)
}

pub(super) fn state_checkpoint_id(text: &str) -> Result<Option<String>> {
    let Some(marker) = first_marker_after_frontmatter(text) else {
        return Ok(None);
    };
    if !marker.starts_with("<!-- kodmem-state ") {
        return Ok(None);
    }
    let marker: StateMarker = parse_canonical_marker(marker, "<!-- kodmem-state ")?;
    if marker.schema != 1 || marker.checkpoint_id.is_empty() {
        return Err(MemoryError::InvalidInput(
            "canonical state marker is invalid".into(),
        ));
    }
    Ok(Some(marker.checkpoint_id))
}

pub(super) fn state_lineage_token(migration_id: &str, artifact_id: &str) -> String {
    sha256_bytes(format!("kodmem-state-lineage-v1\0{migration_id}\0{artifact_id}").as_bytes())
}

pub(crate) fn state_lineage_sha256(text: &str) -> Result<Option<String>> {
    let Some(first) = first_marker_after_frontmatter(text) else {
        return Ok(None);
    };
    if first.starts_with("<!-- kodmem-state ") {
        let marker: StateMarker = parse_canonical_marker(first, "<!-- kodmem-state ")?;
        if let Some(lineage) = marker.lineage_sha256 {
            validate_hash("canonical state lineage", &lineage)?;
            return Ok(Some(lineage));
        }
    }
    let marker = if first.starts_with(MIGRATION_NOTE_PREFIX) {
        Some(first)
    } else if first.starts_with("<!-- kodmem-state ") {
        let mut saw_state = false;
        text.lines().map(str::trim).find(|line| {
            if !saw_state {
                saw_state = *line == first;
                return false;
            }
            !line.is_empty()
        })
    } else {
        None
    };
    let Some(marker) = marker.filter(|line| line.starts_with(MIGRATION_NOTE_PREFIX)) else {
        return Ok(None);
    };
    let json = marker
        .strip_prefix(MIGRATION_NOTE_PREFIX)
        .and_then(|value| value.strip_suffix(CUTOVER_SUFFIX))
        .ok_or_else(|| MemoryError::InvalidInput("migration state marker is malformed".into()))?;
    let value: serde_json::Value = serde_json::from_str(json)?;
    let (migration_id, _) = parse_owned_migration_marker(marker)?;
    let source = value
        .get("sourceSha256")
        .and_then(|value| value.as_str())
        .ok_or_else(|| MemoryError::InvalidInput("migration state source is missing".into()))?;
    validate_hash("migration state source", source)?;
    Ok(Some(state_lineage_token(&migration_id, source)))
}

pub(super) fn parse_canonical_marker<T: for<'de> Deserialize<'de>>(
    line: &str,
    prefix: &str,
) -> Result<T> {
    let json = line
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(CUTOVER_SUFFIX))
        .ok_or_else(|| {
            MemoryError::InvalidInput("canonical migration marker is malformed".into())
        })?;
    serde_json::from_str(json)
        .map_err(|_| MemoryError::InvalidInput("canonical migration marker is malformed".into()))
}

pub(super) fn cutover_targets(
    writes: &[PlannedWrite],
    migration_id: &str,
) -> Result<Vec<CutoverTarget>> {
    let mut targets = Vec::new();
    for write in writes {
        if write.public.conflict.is_some() {
            continue;
        }
        let mut artifacts = if let Some(contents) = write.contents.as_deref() {
            cutover_artifacts_from_text(
                contents,
                &write.public.source_kind,
                &write.public.target_relative_path,
                Some(migration_id),
            )?
        } else {
            write.evidence.clone()
        };
        if artifacts.is_empty() {
            // Coalesced duplicates are satisfied by the primary write to the
            // same target and intentionally add no second receipt.
            if write.public.action == LegacyMigrationAction::SkipDuplicate
                && writes.iter().any(|peer| {
                    peer.contents.is_some()
                        && peer.public.target_relative_path == write.public.target_relative_path
                })
            {
                continue;
            }
            return Err(MemoryError::InvalidInput(format!(
                "migration target is missing bounded provenance: {}",
                write.public.target_relative_path
            )));
        }
        targets.append(&mut artifacts);
    }
    targets.sort();
    targets.dedup();
    if targets.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(MemoryError::InvalidInput(
            "migration cutover targets must be unique".into(),
        ));
    }
    Ok(targets)
}

pub(super) fn first_marker_after_frontmatter(text: &str) -> Option<&str> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in &mut lines {
        if line.trim() == "---" {
            return lines
                .find(|candidate| !candidate.trim().is_empty())
                .map(str::trim);
        }
    }
    None
}

pub(super) fn parse_owned_migration_id(line: &str) -> Result<String> {
    Ok(parse_owned_migration_marker(line)?.0)
}

pub(super) fn canonical_repo_migration_marker(text: &str) -> Option<&str> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in &mut lines {
        if line.trim() == "---" {
            break;
        }
    }
    let first = lines.find(|line| !line.trim().is_empty())?.trim();
    if first.starts_with(MIGRATION_NOTE_PREFIX) {
        return Some(first);
    }
    if !first.starts_with("<!-- kodmem-state ") {
        return None;
    }
    lines
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .filter(|line| line.starts_with(MIGRATION_NOTE_PREFIX))
}

pub(super) fn parse_repo_migration_marker(line: &str) -> Result<RepoMigrationMarker> {
    let json = line
        .strip_prefix(MIGRATION_NOTE_PREFIX)
        .and_then(|value| value.strip_suffix(CUTOVER_SUFFIX))
        .ok_or_else(|| {
            MemoryError::InvalidInput("migration-owned Markdown marker is malformed".into())
        })?;
    let marker: RepoMigrationMarker = serde_json::from_str(json).map_err(|_| {
        MemoryError::InvalidInput("migration repo provenance schema is invalid".into())
    })?;
    if marker.schema != 1
        || marker.source_origins.is_empty()
        || marker.source_origins.len() > 256
        || marker.source_modified_at < 0
    {
        return Err(MemoryError::InvalidInput(
            "migration repo provenance is invalid".into(),
        ));
    }
    validate_migration_id(&marker.migration_id)?;
    validate_hash("migration repo source", &marker.source_sha256)?;
    validate_hash("migration repo snapshot", &marker.source_snapshot_sha256)?;
    let mut normalized = marker.source_origins.clone();
    normalized.sort();
    normalized.dedup();
    if normalized != marker.source_origins {
        return Err(MemoryError::InvalidInput(
            "migration repo origins must be sorted and unique".into(),
        ));
    }
    for origin in &marker.source_origins {
        if origin.source_kind != "repo-readable-v1"
            || origin.source_modified_at < 0
            || !origin.legacy_identity.starts_with(".kodade/memory/")
            || origin
                .legacy_identity
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(MemoryError::InvalidInput(
                "migration repo origin identity is invalid".into(),
            ));
        }
        validate_hash(
            "migration repo origin snapshot",
            &origin.source_snapshot_sha256,
        )?;
        validate_hash("migration repo origin source", &origin.source_sha256)?;
    }
    if !marker.source_origins.iter().any(|origin| {
        origin.source_snapshot_sha256 == marker.source_snapshot_sha256
            && origin.source_sha256 == marker.source_sha256
    }) || marker.source_modified_at
        != marker
            .source_origins
            .iter()
            .map(|origin| origin.source_modified_at)
            .max()
            .unwrap_or_default()
    {
        return Err(MemoryError::InvalidInput(
            "migration repo top-level provenance is inconsistent".into(),
        ));
    }
    Ok(marker)
}

pub(crate) fn migration_source_modified_at(note_text: &str) -> Result<Option<i64>> {
    let Some(mut line) = first_marker_after_frontmatter(note_text) else {
        return Ok(None);
    };
    if line.starts_with("<!-- kodmem-state ") {
        let mut found_state = false;
        for candidate in note_text.lines() {
            let candidate = candidate.trim();
            if !found_state {
                found_state = candidate == line;
                continue;
            }
            if !candidate.is_empty() {
                line = candidate;
                break;
            }
        }
    }
    if !line.starts_with(MIGRATION_NOTE_PREFIX) {
        return Ok(None);
    }
    Ok(parse_owned_migration_marker(line)?.1)
}

pub(super) fn parse_owned_migration_marker(line: &str) -> Result<(String, Option<i64>)> {
    let json = line
        .strip_prefix(MIGRATION_NOTE_PREFIX)
        .and_then(|value| value.strip_suffix(CUTOVER_SUFFIX))
        .ok_or_else(|| {
            MemoryError::InvalidInput("migration-owned Markdown marker is malformed".into())
        })?;
    let value: serde_json::Value = serde_json::from_str(json).map_err(|_| {
        MemoryError::InvalidInput("migration-owned Markdown marker is malformed".into())
    })?;
    let object = value.as_object().ok_or_else(|| {
        MemoryError::InvalidInput("migration-owned Markdown marker must be an object".into())
    })?;
    if object.contains_key("sourceOrigins") {
        let marker = parse_repo_migration_marker(line)?;
        return Ok((marker.migration_id, Some(marker.source_modified_at)));
    }
    if object.len() != 4
        || object.get("schema").and_then(|value| value.as_u64()) != Some(1)
        || !object.contains_key("legacyId")
        || !object.contains_key("migrationId")
        || !object.contains_key("sourceSha256")
    {
        return Err(MemoryError::InvalidInput(
            "migration-owned Markdown marker schema is invalid".into(),
        ));
    }
    let legacy_id = object
        .get("legacyId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| MemoryError::InvalidInput("migration legacy ID is invalid".into()))?;
    let _ = legacy_id;
    let source_hash = object
        .get("sourceSha256")
        .and_then(|value| value.as_str())
        .ok_or_else(|| MemoryError::InvalidInput("migration source hash is missing".into()))?;
    validate_hash("migration source", source_hash)?;
    let migration_id = object
        .get("migrationId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| MemoryError::InvalidInput("migration ID is missing".into()))?;
    validate_migration_id(migration_id)?;
    Ok((migration_id.into(), None))
}

pub(super) fn migration_id_from_canonical_marker(
    line: &str,
    prefix: &str,
) -> Result<Option<String>> {
    let json = line
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(CUTOVER_SUFFIX))
        .ok_or_else(|| {
            MemoryError::InvalidInput("canonical migration marker is malformed".into())
        })?;
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| MemoryError::InvalidInput("canonical migration marker is malformed".into()))?;
    let Some(migration) = value.get("migration") else {
        return Ok(None);
    };
    let provenance: MigrationProvenance =
        serde_json::from_value(migration.clone()).map_err(|_| {
            MemoryError::InvalidInput("canonical migration provenance schema is invalid".into())
        })?;
    validate_migration_id(&provenance.migration_id)?;
    validate_hash("canonical migration source", &provenance.source_sha256)?;
    if provenance.legacy_id.is_empty() || provenance.origins.len() > 256 {
        return Err(MemoryError::InvalidInput(
            "canonical migration provenance is invalid".into(),
        ));
    }
    for origin in &provenance.origins {
        if origin.source_kind != "sqlite-legacy-v1" {
            return Err(MemoryError::InvalidInput(
                "canonical migration origin source kind is invalid".into(),
            ));
        }
        validate_hash("canonical migration origin", &origin.source_sha256)?;
        if origin.legacy_id.is_empty() {
            return Err(MemoryError::InvalidInput(
                "canonical migration origin ID is invalid".into(),
            ));
        }
    }
    let mut normalized = provenance.origins.clone();
    normalize_origins(&mut normalized)?;
    if normalized != provenance.origins
        || merged_source_sha256(&normalized)? != provenance.source_sha256
        || !normalized
            .iter()
            .any(|origin| origin.legacy_id == provenance.legacy_id)
    {
        return Err(MemoryError::InvalidInput(
            "canonical migration provenance is not normalized".into(),
        ));
    }
    Ok(Some(provenance.migration_id))
}

pub(super) fn validate_written_plan(plan: &ComputedPlan) -> Result<()> {
    for write in &plan.writes {
        if write.public.action == LegacyMigrationAction::SkipDuplicate
            || write.public.conflict.is_some()
        {
            continue;
        }
        let desired = write.contents.as_deref().ok_or_else(|| {
            MemoryError::InvalidInput("migration operation is missing content".into())
        })?;
        let actual = file_hash_optional(&confined_target(
            &plan.location,
            &write.public.target_relative_path,
        )?)?;
        if actual.as_deref() != Some(&sha256_bytes(desired.as_bytes())) {
            return Err(MemoryError::InvalidInput(format!(
                "migration validation failed for {}",
                write.public.target_relative_path
            )));
        }
    }
    Ok(())
}

pub(super) fn normalize_planned_targets(
    writes: &mut [PlannedWrite],
    counts: &mut LegacyMigrationCounts,
) {
    let mut first_by_target = BTreeMap::<String, usize>::new();
    for index in 0..writes.len() {
        if writes[index].public.action == LegacyMigrationAction::SkipDuplicate {
            continue;
        }
        let target = writes[index].public.target_relative_path.clone();
        let Some(first) = first_by_target.get(&target).copied() else {
            first_by_target.insert(target, index);
            continue;
        };
        if writes[first].contents == writes[index].contents
            && writes[first].public.expected_target_sha256
                == writes[index].public.expected_target_sha256
        {
            writes[index].public.action = LegacyMigrationAction::SkipDuplicate;
            writes[index].public.target_sha256 = writes[first].public.target_sha256.clone();
            writes[index].contents = None;
            counts.duplicates = counts.duplicates.saturating_add(1);
        } else {
            let reason = "multiple legacy sources map to the same target with different content";
            if writes[first].public.conflict.is_none() {
                writes[first].public.conflict = Some(reason.into());
                counts.conflicts = counts.conflicts.saturating_add(1);
            }
            writes[index].public.conflict = Some(reason.into());
            writes[index].contents = None;
            counts.conflicts = counts.conflicts.saturating_add(1);
        }
    }
}

pub(super) fn validate_planned_canonical_budget(
    location: &ProjectLocation,
    writes: &[PlannedWrite],
    prospective_project: &str,
) -> Result<()> {
    let policy = migration_policy()?;
    let paths = scaffold_markdown_paths(location, policy.max_canonical_files)?;
    let mut postimages = BTreeMap::<String, usize>::new();
    for path in paths {
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(MemoryError::InvalidInput(
                "canonical migration target tree must contain only regular Markdown files".into(),
            ));
        }
        if metadata.len() > policy.max_document_bytes {
            return Err(MemoryError::InvalidInput(
                "canonical migration target exceeds the per-file limit".into(),
            ));
        }
        let relative = path
            .strip_prefix(&location.project_root)
            .map_err(|_| MemoryError::InvalidInput("canonical target escapes its project".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        postimages.insert(relative, metadata.len() as usize);
    }
    for write in writes {
        if write.public.action == LegacyMigrationAction::SkipDuplicate
            || write.public.conflict.is_some()
        {
            continue;
        }
        let contents = write.contents.as_deref().ok_or_else(|| {
            MemoryError::InvalidInput("migration operation is missing generated content".into())
        })?;
        if contents.len() as u64 > policy.max_document_bytes {
            return Err(MemoryError::InvalidInput(format!(
                "generated migration target exceeds the per-file limit: {}",
                write.public.target_relative_path
            )));
        }
        postimages.insert(write.public.target_relative_path.clone(), contents.len());
    }
    if prospective_project.len() as u64 > policy.max_document_bytes
        || prospective_project.len() > policy.max_cutover_bytes
    {
        return Err(MemoryError::InvalidInput(
            "generated Project.md cutover exceeds the canonical file limit".into(),
        ));
    }
    let project_relative = project_note_relative_path()?;
    postimages.insert(project_relative, prospective_project.len());
    let total_bytes = postimages.values().copied().sum::<usize>();
    if postimages.len() > policy.max_canonical_files || total_bytes > policy.max_canonical_bytes {
        return Err(MemoryError::InvalidInput(
            "generated migration target tree exceeds the canonical project budget".into(),
        ));
    }
    Ok(())
}

pub(super) fn canonical_project_snapshot_sha256(location: &ProjectLocation) -> Result<String> {
    let policy = migration_policy()?;
    let paths = scaffold_markdown_paths(location, policy.max_canonical_files)?;
    let mut receipts = Vec::new();
    let mut total = 0_usize;
    for path in paths {
        let text = read_bounded_regular(&path, "canonical project snapshot")?;
        total = total.saturating_add(text.len());
        if total > policy.max_canonical_bytes {
            return Err(MemoryError::InvalidInput(
                "canonical project snapshot exceeds its byte limit".into(),
            ));
        }
        let relative = path
            .strip_prefix(&location.project_root)
            .map_err(|_| MemoryError::InvalidInput("canonical snapshot path escaped".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        receipts.push((relative, sha256_bytes(text.as_bytes())));
    }
    Ok(sha256_bytes(&serde_json::to_vec(&receipts)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> String {
        byte.to_string().repeat(64)
    }

    fn migration_id(byte: char) -> String {
        format!("kmig_{}", byte.to_string().repeat(32))
    }

    fn origin(byte: char) -> MigrationOrigin {
        MigrationOrigin {
            source_kind: "sqlite-legacy-v1".into(),
            legacy_id: format!("legacy-{byte}"),
            source_sha256: digest(byte),
        }
    }

    fn chain_target(
        artifact_kind: &str,
        artifact_id: &str,
        origins: &[MigrationOrigin],
    ) -> CutoverTarget {
        CutoverTarget {
            source_kind: if artifact_kind == "canonical-memory" {
                "sqlite-memory".into()
            } else {
                "sqlite-checkpoint".into()
            },
            artifact_kind: artifact_kind.into(),
            artifact_id: artifact_id.into(),
            relative_path: None,
            lineage_sha256: None,
            origin_source_sha256: origins
                .iter()
                .map(|origin| origin.source_sha256.clone())
                .collect(),
            origin_provenance_sha256: Some(migration_origins_sha256(origins).unwrap()),
        }
    }

    fn chain_migration(id: &str, receipt: &str, target: CutoverTarget) -> CutoverMigration {
        CutoverMigration {
            migration_id: id.into(),
            manifest_sha256: digest('d'),
            recovery_anchor_sha256: digest('e'),
            source_snapshots: vec![SourceSnapshotReceipt {
                kind: "sqlite-legacy-v1".into(),
                sha256: receipt.into(),
            }],
            targets: vec![target],
        }
    }

    fn valid_chain(artifact_kind: &str) -> (CutoverMarker, Vec<MigrationOrigin>, String) {
        let artifact_id = "km_artifact".to_string();
        let first = origin('a');
        let second = origin('b');
        let current = vec![first.clone(), second.clone()];
        let cutover = CutoverMarker {
            schema: 1,
            project_id: "example".into(),
            authority: "projects-vault".into(),
            migrations: vec![
                chain_migration(
                    &migration_id('a'),
                    &first.source_sha256,
                    chain_target(artifact_kind, &artifact_id, std::slice::from_ref(&first)),
                ),
                chain_migration(
                    &migration_id('b'),
                    &second.source_sha256,
                    chain_target(artifact_kind, &artifact_id, &current),
                ),
            ],
        };
        (cutover, current, artifact_id)
    }

    #[test]
    fn canonical_origin_chain_rejects_forged_historical_provenance_for_all_sqlite_artifacts() {
        for artifact_kind in [
            "canonical-memory",
            "canonical-checkpoint",
            "checkpoint-decision",
        ] {
            let (mut cutover, current_origins, artifact_id) = valid_chain(artifact_kind);
            let current_sources = current_origins
                .iter()
                .map(|origin| origin.source_sha256.as_str())
                .collect::<BTreeSet<_>>();
            let current_hash = migration_origins_sha256(&current_origins).unwrap();
            assert!(canonical_origin_chain_satisfies(
                &cutover,
                artifact_kind,
                &artifact_id,
                &migration_id('b'),
                &current_hash,
                &current_origins,
                &current_sources,
            )
            .unwrap());

            cutover.migrations[0].targets[0].origin_provenance_sha256 = Some(digest('f'));
            assert!(!canonical_origin_chain_satisfies(
                &cutover,
                artifact_kind,
                &artifact_id,
                &migration_id('b'),
                &current_hash,
                &current_origins,
                &current_sources,
            )
            .unwrap());
        }
    }

    #[test]
    fn canonical_origin_chain_rejects_incomparable_branches_before_a_forged_union() {
        let artifact_kind = "canonical-memory";
        let artifact_id = "km_artifact";
        let first = origin('a');
        let second = origin('b');
        let third = origin('c');
        let current_origins = vec![first.clone(), second.clone(), third.clone()];
        let current_sources = current_origins
            .iter()
            .map(|origin| origin.source_sha256.as_str())
            .collect::<BTreeSet<_>>();
        let cutover = CutoverMarker {
            schema: 1,
            project_id: "example".into(),
            authority: "projects-vault".into(),
            migrations: vec![
                chain_migration(
                    &migration_id('a'),
                    &first.source_sha256,
                    chain_target(artifact_kind, artifact_id, std::slice::from_ref(&first)),
                ),
                chain_migration(
                    &migration_id('b'),
                    &second.source_sha256,
                    chain_target(artifact_kind, artifact_id, std::slice::from_ref(&second)),
                ),
                chain_migration(
                    &migration_id('c'),
                    &third.source_sha256,
                    chain_target(artifact_kind, artifact_id, &current_origins),
                ),
            ],
        };
        assert!(!canonical_origin_chain_satisfies(
            &cutover,
            artifact_kind,
            artifact_id,
            &migration_id('c'),
            &migration_origins_sha256(&current_origins).unwrap(),
            &current_origins,
            &current_sources,
        )
        .unwrap());
    }

    #[test]
    fn state_wrapper_requires_the_migration_marker_in_the_adjacent_machine_slot() {
        let copied = concat!(
            "---\ntitle: State\n---\n",
            "<!-- kodmem-state {\"schema\":1,\"checkpointId\":\"km_state\"} -->\n",
            "# Current state\n\n",
            "<!-- kodmem-migration {\"schema\":1} -->\n",
        );
        assert!(canonical_repo_migration_marker(copied).is_none());
    }
}
