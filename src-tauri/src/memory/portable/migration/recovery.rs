use super::*;

pub(super) fn empty_plan(
    workspace_id: &str,
    location: ProjectLocation,
    snapshot: LegacySnapshot,
    status: LegacyMigrationStatus,
    project_note_sha256: String,
) -> ComputedPlan {
    ComputedPlan {
        public: LegacyMigrationPlan {
            schema: 1,
            status,
            workspace_id: workspace_id.into(),
            project_id: location.project_id.clone(),
            project_display_name: location.project_display_name.clone(),
            fingerprint: sha256_bytes(format!("{}:{status:?}", location.project_id).as_bytes()),
            migration_id: None,
            manifest_sha256: None,
            sources: snapshot.sources.clone(),
            source_snapshots: snapshot.receipts.clone(),
            counts: LegacyMigrationCounts::default(),
            operations: Vec::new(),
            system_operations: Vec::new(),
            can_apply: false,
            source_retained: true,
            creates_local_recovery_backup: false,
            writes_cutover_last: false,
            recovery: None,
        },
        location,
        writes: Vec::new(),
        snapshot,
        project_note_sha256,
        recovery_backup: None,
    }
}

pub(super) fn backup_recovery(backup: &BackupManifest) -> Option<LegacyMigrationRecovery> {
    let phase = match backup.phase {
        BackupPhase::Prepared => LegacyMigrationRecoveryPhase::Prepared,
        BackupPhase::MarkdownWritten => LegacyMigrationRecoveryPhase::MarkdownWritten,
        BackupPhase::Cutover => LegacyMigrationRecoveryPhase::Cutover,
        BackupPhase::Complete => LegacyMigrationRecoveryPhase::Complete,
        BackupPhase::RollingBack => LegacyMigrationRecoveryPhase::RollingBack,
        BackupPhase::RolledBack => return None,
    };
    Some(LegacyMigrationRecovery {
        migration_id: backup.migration_id.clone(),
        manifest_sha256: backup.manifest_sha256.clone(),
        phase,
        can_retry: matches!(
            backup.phase,
            BackupPhase::Prepared | BackupPhase::MarkdownWritten | BackupPhase::Cutover
        ),
        can_rollback: true,
    })
}

pub(in crate::memory::portable) fn parse_cutover_marker(
    text: &str,
    expected_project_id: &str,
) -> Result<Option<CutoverMarker>> {
    let lines = text.lines().collect::<Vec<_>>();
    let project_index = exact_project_marker_index(&lines)?;
    let Some(line) = lines.get(project_index + 1) else {
        return Ok(None);
    };
    if line.starts_with(PENDING_PREFIX) || line.starts_with("<!-- kodmem-migration-pending") {
        let _ = parse_pending_marker(text, expected_project_id)?;
        return Err(MemoryError::InvalidInput(
            "projects-vault authority is blocked while migration-owned Markdown is pending cutover"
                .into(),
        ));
    }
    if !line.starts_with("<!-- kodmem-cutover") {
        return Ok(None);
    }
    let json = line
        .strip_prefix(CUTOVER_PREFIX)
        .and_then(|value| value.strip_suffix(CUTOVER_SUFFIX))
        .ok_or_else(|| {
            MemoryError::InvalidInput(
                "Project.md contains a malformed kodmem-cutover marker".into(),
            )
        })?;
    let marker: CutoverMarker = serde_json::from_str(json).map_err(|_| {
        MemoryError::InvalidInput("Project.md contains a malformed kodmem-cutover marker".into())
    })?;
    validate_cutover(&marker, expected_project_id)?;
    Ok(Some(marker))
}

pub(super) fn parse_cutover_preimage(
    text: &str,
    expected_project_id: &str,
) -> Result<Option<CutoverMarker>> {
    let authoritative =
        super::super::super::scaffold::with_authority_marker(text, expected_project_id)?;
    parse_cutover_marker(&authoritative, expected_project_id)
}

pub(super) fn parse_pending_marker(
    text: &str,
    expected_project_id: &str,
) -> Result<Option<PendingMarker>> {
    let lines = text.lines().collect::<Vec<_>>();
    let project_index = exact_project_marker_index(&lines)?;
    let Some(line) = lines.get(project_index + 1) else {
        return Ok(None);
    };
    if !line.starts_with("<!-- kodmem-migration-pending") {
        return Ok(None);
    }
    let json = line
        .strip_prefix(PENDING_PREFIX)
        .and_then(|value| value.strip_suffix(CUTOVER_SUFFIX))
        .ok_or_else(|| {
            MemoryError::InvalidInput(
                "Project.md contains a malformed migration-pending marker".into(),
            )
        })?;
    let marker: PendingMarker = serde_json::from_str(json).map_err(|_| {
        MemoryError::InvalidInput("Project.md contains a malformed migration-pending marker".into())
    })?;
    if marker.schema != 1 || marker.project_id != expected_project_id {
        return Err(MemoryError::InvalidInput(
            "Project.md migration-pending marker does not match this project".into(),
        ));
    }
    validate_migration_id(&marker.migration_id)?;
    validate_hash("pending migration manifest", &marker.manifest_sha256)?;
    validate_hash(
        "pending migration recovery anchor",
        &marker.recovery_anchor_sha256,
    )?;
    Ok(Some(marker))
}

pub(super) fn validate_cutover(marker: &CutoverMarker, expected_project_id: &str) -> Result<()> {
    if marker.schema != 1
        || marker.project_id != expected_project_id
        || marker.authority != "projects-vault"
    {
        return Err(MemoryError::InvalidInput(
            "Project.md kodmem-cutover marker does not match this project".into(),
        ));
    }
    if marker.migrations.len() > 128 {
        return Err(MemoryError::InvalidInput(
            "Project.md kodmem-cutover marker exceeds the migration receipt limit".into(),
        ));
    }
    let mut previous = None;
    for migration in &marker.migrations {
        validate_migration_id(&migration.migration_id)?;
        validate_hash("cutover manifest", &migration.manifest_sha256)?;
        validate_hash("cutover recovery anchor", &migration.recovery_anchor_sha256)?;
        if previous
            .as_ref()
            .is_some_and(|value: &String| value >= &migration.migration_id)
        {
            return Err(MemoryError::InvalidInput(
                "Project.md cutover migrations must be sorted and unique".into(),
            ));
        }
        previous = Some(migration.migration_id.clone());
        if migration.source_snapshots.is_empty() || migration.source_snapshots.len() > 512 {
            return Err(MemoryError::InvalidInput(
                "Project.md cutover source snapshots are invalid".into(),
            ));
        }
        let mut prior = None;
        for receipt in &migration.source_snapshots {
            if !matches!(
                receipt.kind.as_str(),
                "repo-readable-v1" | "sqlite-legacy-v1"
            ) {
                return Err(MemoryError::InvalidInput(
                    "Project.md cutover source kind is unsupported".into(),
                ));
            }
            validate_hash("cutover source snapshot", &receipt.sha256)?;
            if prior
                .as_ref()
                .is_some_and(|value: &SourceSnapshotReceipt| value >= receipt)
            {
                return Err(MemoryError::InvalidInput(
                    "Project.md cutover source snapshots must be sorted and unique".into(),
                ));
            }
            prior = Some(receipt.clone());
        }
        if migration.targets.len() > migration_policy()?.max_canonical_files {
            return Err(MemoryError::InvalidInput(
                "Project.md cutover targets exceed the canonical file limit".into(),
            ));
        }
        let mut previous_target = None;
        for target in &migration.targets {
            if let Some(lineage) = target.lineage_sha256.as_deref() {
                validate_hash("cutover state lineage", lineage)?;
            }
            let mut previous_origin = None;
            for origin in &target.origin_source_sha256 {
                validate_hash("cutover target origin", origin)?;
                if previous_origin
                    .as_ref()
                    .is_some_and(|value: &String| value >= origin)
                {
                    return Err(MemoryError::InvalidInput(
                        "Project.md cutover target origins must be sorted and unique".into(),
                    ));
                }
                previous_origin = Some(origin.clone());
            }
            if let Some(origin_provenance) = target.origin_provenance_sha256.as_deref() {
                validate_hash("cutover target origin provenance", origin_provenance)?;
            }
            if target.artifact_id.is_empty()
                || !matches!(
                    target.artifact_kind.as_str(),
                    "legacy-wrapper"
                        | "canonical-memory"
                        | "canonical-checkpoint"
                        | "checkpoint-decision"
                        | "state-lineage"
                )
                || matches!(
                    target.artifact_kind.as_str(),
                    "legacy-wrapper" | "checkpoint-decision"
                ) != target.relative_path.is_some()
                || (target.artifact_kind == "state-lineage" && target.relative_path.is_some())
                || (target.artifact_kind == "state-lineage" && target.lineage_sha256.is_none())
                || (target.artifact_kind != "state-lineage"
                    && target.artifact_kind != "canonical-checkpoint"
                    && target.lineage_sha256.is_some())
                || matches!(
                    target.artifact_kind.as_str(),
                    "canonical-memory" | "canonical-checkpoint" | "checkpoint-decision"
                ) && target.origin_source_sha256.is_empty()
                || matches!(
                    target.artifact_kind.as_str(),
                    "legacy-wrapper"
                        | "canonical-memory"
                        | "canonical-checkpoint"
                        | "checkpoint-decision"
                ) && target.origin_provenance_sha256.is_none()
                || !matches!(
                    target.artifact_kind.as_str(),
                    "canonical-memory" | "canonical-checkpoint" | "checkpoint-decision"
                ) && !target.origin_source_sha256.is_empty()
                || !matches!(
                    target.artifact_kind.as_str(),
                    "legacy-wrapper"
                        | "canonical-memory"
                        | "canonical-checkpoint"
                        | "checkpoint-decision"
                ) && target.origin_provenance_sha256.is_some()
            {
                return Err(MemoryError::InvalidInput(
                    "Project.md cutover target is invalid".into(),
                ));
            }
            if let Some(relative) = target.relative_path.as_deref() {
                if !cutover_target_relative_is_valid(target, relative)? {
                    return Err(MemoryError::InvalidInput(
                        "Project.md cutover target path is invalid".into(),
                    ));
                }
            }
            if previous_target
                .as_ref()
                .is_some_and(|value: &CutoverTarget| value >= target)
            {
                return Err(MemoryError::InvalidInput(
                    "Project.md cutover targets must be sorted and unique".into(),
                ));
            }
            previous_target = Some(target.clone());
        }
    }
    Ok(())
}

pub(in crate::memory::portable) fn receipts_cover(
    marker: &CutoverMarker,
    local: &[SourceSnapshotReceipt],
) -> bool {
    let imported = marker
        .migrations
        .iter()
        .flat_map(|migration| migration.source_snapshots.iter())
        .collect::<BTreeSet<_>>();
    local.iter().all(|receipt| imported.contains(receipt))
}

pub(super) fn merge_cutover(marker: &mut CutoverMarker, migration: CutoverMigration) -> Result<()> {
    if let Some(existing) = marker
        .migrations
        .iter()
        .find(|entry| entry.migration_id == migration.migration_id)
    {
        if existing.manifest_sha256 != migration.manifest_sha256
            || existing.source_snapshots != migration.source_snapshots
            || existing.targets != migration.targets
        {
            return Err(MemoryError::InvalidInput(
                "migration ID already has a different cutover receipt".into(),
            ));
        }
        return Ok(());
    }
    marker.migrations.push(migration);
    marker
        .migrations
        .sort_by(|left, right| left.migration_id.cmp(&right.migration_id));
    validate_cutover(marker, &marker.project_id)
}

pub(super) fn with_cutover_marker(text: &str, marker: &CutoverMarker) -> Result<String> {
    with_optional_cutover_marker(text, Some(marker))
}

pub(super) fn with_pending_marker(text: &str, marker: &PendingMarker) -> Result<String> {
    let text = super::super::super::scaffold::with_authority_marker(text, &marker.project_id)?;
    replace_authority_operation_marker(
        &text,
        Some(format!(
            "{PENDING_PREFIX}{}{CUTOVER_SUFFIX}",
            serde_json::to_string(marker)?
        )),
    )
}

pub(super) fn with_optional_cutover_marker(
    text: &str,
    marker: Option<&CutoverMarker>,
) -> Result<String> {
    let owned;
    let text = if let Some(marker) = marker {
        owned = super::super::super::scaffold::with_authority_marker(text, &marker.project_id)?;
        owned.as_str()
    } else {
        text
    };
    let rendered = marker
        .map(|marker| {
            Ok::<String, MemoryError>(format!(
                "{CUTOVER_PREFIX}{}{CUTOVER_SUFFIX}",
                serde_json::to_string(marker)?
            ))
        })
        .transpose()?;
    replace_authority_operation_marker(text, rendered)
}

pub(super) fn replace_authority_operation_marker(
    text: &str,
    rendered: Option<String>,
) -> Result<String> {
    let logical = text.lines().collect::<Vec<_>>();
    let project_index = exact_project_marker_index(&logical)?;
    let physical = text.split_inclusive('\n').collect::<Vec<_>>();
    let project_line = physical.get(project_index).ok_or_else(|| {
        MemoryError::InvalidInput("Project.md authority marker span is unavailable".into())
    })?;
    let project_start = physical[..project_index]
        .iter()
        .map(|line| line.len())
        .sum::<usize>();
    let project_end = project_start + project_line.len();
    let existing = physical.get(project_index + 1).filter(|line| {
        let line = line.trim_end_matches(['\r', '\n']);
        line.starts_with("<!-- kodmem-cutover") || line.starts_with("<!-- kodmem-migration-pending")
    });
    let existing_end = project_end + existing.map_or(0, |line| line.len());
    let line_ending = if project_line.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let replacement = match rendered {
        Some(rendered) => {
            if existing.is_some() {
                let ending = existing
                    .filter(|line| line.ends_with('\n'))
                    .map(|line| if line.ends_with("\r\n") { "\r\n" } else { "\n" })
                    .unwrap_or("");
                format!("{rendered}{ending}")
            } else if project_line.ends_with('\n') {
                format!("{rendered}{line_ending}")
            } else {
                format!("{line_ending}{rendered}")
            }
        }
        None => String::new(),
    };
    let mut output = String::with_capacity(text.len() + replacement.len());
    output.push_str(&text[..project_end]);
    output.push_str(&replacement);
    output.push_str(&text[existing_end..]);
    Ok(output)
}

pub(super) fn exact_project_marker_index(lines: &[&str]) -> Result<usize> {
    super::super::super::scaffold::authority_marker_line_index(lines)?.ok_or_else(|| {
        MemoryError::InvalidInput(
            "Project.md exact authority marker is unavailable for cutover".into(),
        )
    })
}

pub(super) fn confined_target(location: &ProjectLocation, relative: &str) -> Result<PathBuf> {
    if relative.is_empty()
        || Path::new(relative).is_absolute()
        || relative
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(MemoryError::InvalidInput(
            "migration target must be a confined relative path".into(),
        ));
    }
    let target = location.project_root.join(relative);
    let mut ancestor = target.parent();
    while let Some(path) = ancestor {
        if path == location.project_root {
            break;
        }
        if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(MemoryError::InvalidInput(format!(
                "migration target parent cannot be a symlink: {relative}"
            )));
        }
        ancestor = path.parent();
    }
    if !target.starts_with(&location.project_root) {
        return Err(MemoryError::InvalidInput(
            "migration target escapes the project".into(),
        ));
    }
    Ok(target)
}

pub(super) fn ensure_parent_directories(location: &ProjectLocation, target: &Path) -> Result<()> {
    let relative = target
        .strip_prefix(&location.project_root)
        .map_err(|_| MemoryError::InvalidInput("migration target escapes project".into()))?;
    let relative = relative.to_str().ok_or_else(|| {
        MemoryError::InvalidInput("migration target path must be valid UTF-8".into())
    })?;
    let durable_target = confined_path(location, relative)?;
    if durable_target != target {
        return Err(MemoryError::InvalidInput(
            "migration target confinement changed".into(),
        ));
    }
    Ok(())
}

pub(super) fn read_bounded_regular(path: &Path, label: &str) -> Result<String> {
    read_optional_bounded_regular(path, label)?
        .ok_or_else(|| MemoryError::InvalidInput(format!("{label} is unavailable")))
}

pub(super) fn read_optional_bounded_regular(path: &Path, label: &str) -> Result<Option<String>> {
    let Some(bytes) = read_optional_bounded_bytes(path, label)? else {
        return Ok(None);
    };
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| MemoryError::InvalidInput(format!("{label} must be valid UTF-8")))
}

pub(super) fn read_optional_bounded_bytes(path: &Path, label: &str) -> Result<Option<Vec<u8>>> {
    let policy = migration_policy()?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::InvalidInput(format!(
            "{label} must be a regular file"
        )));
    }
    if metadata.len() > policy.max_document_bytes {
        return Err(MemoryError::InvalidInput(format!(
            "{label} exceeds the migration document limit"
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(policy.max_document_bytes + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > policy.max_document_bytes {
        return Err(MemoryError::InvalidInput(format!(
            "{label} grew beyond the migration document limit while reading"
        )));
    }
    Ok(Some(bytes))
}

pub(super) fn migration_runtime_root(store: &MemoryStore, create: bool) -> Result<PathBuf> {
    let parent = &store.migration_recovery_root;
    let metadata = std::fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MemoryError::InvalidInput(
            "migration recovery root must remain a regular directory".into(),
        ));
    }
    if std::fs::canonicalize(parent)? != *parent {
        return Err(MemoryError::InvalidInput(
            "migration recovery root changed after it was registered".into(),
        ));
    }
    let path = parent.join(migration_policy()?.backup_namespace.as_str());
    ensure_runtime_directory(&path, create, "migration runtime root")?;
    Ok(path)
}

pub(super) fn discover_nonterminal_backup(
    store: &MemoryStore,
    location: &ProjectLocation,
    pending_migration_id: Option<&str>,
) -> Result<Option<(PathBuf, BackupManifest)>> {
    let root =
        migration_runtime_root(store, false)?.join(super::super::portable_root_key(location)?);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut found = Vec::new();
    let mut count = 0_usize;
    for entry in entries {
        let entry = entry?;
        count = count.saturating_add(1);
        if count > 260 {
            return Err(MemoryError::InvalidInput(
                "migration recovery namespace exceeds its bounded entry limit".into(),
            ));
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(MemoryError::InvalidInput(
                "migration recovery namespace contains a non-regular entry".into(),
            ));
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(MemoryError::InvalidInput(
                "migration recovery filename is not valid UTF-8".into(),
            ));
        };
        if is_kodmem_temporary_name(name) {
            if file_type.is_symlink() || !file_type.is_file() {
                return Err(MemoryError::InvalidInput(
                    "migration recovery temporary entry is not a regular file".into(),
                ));
            }
            continue;
        }
        let Some(migration_id) = name.strip_suffix(".json") else {
            return Err(MemoryError::InvalidInput(
                "migration recovery namespace contains an unknown file".into(),
            ));
        };
        if migration_id.ends_with(".anchor") {
            continue;
        }
        validate_migration_id(migration_id)?;
        let path = entry.path();
        let backup = read_backup(&path)?;
        if backup.project_id != location.project_id || backup.migration_id != migration_id {
            return Err(MemoryError::InvalidInput(
                "migration recovery file belongs to a different project".into(),
            ));
        }
        if matches!(
            backup.phase,
            BackupPhase::Prepared
                | BackupPhase::MarkdownWritten
                | BackupPhase::Cutover
                | BackupPhase::RollingBack
        ) || pending_migration_id == Some(migration_id)
        {
            found.push((path, backup));
        }
    }
    if found.len() > 1 {
        return Err(MemoryError::InvalidInput(
            "more than one incomplete migration requires recovery for this project".into(),
        ));
    }
    Ok(found.pop())
}

pub(super) fn migration_backup_path(
    store: &MemoryStore,
    location: &ProjectLocation,
    migration_id: &str,
    create: bool,
) -> Result<PathBuf> {
    validate_migration_id(migration_id)?;
    let project_key = super::super::portable_root_key(location)?;
    let root = migration_runtime_root(store, create)?.join(project_key);
    ensure_runtime_directory(&root, create, "migration backup folder")?;
    Ok(root.join(format!("{migration_id}.json")))
}

pub(super) fn ensure_runtime_directory(path: &Path, create: bool, label: &str) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(MemoryError::InvalidInput(format!(
                "{label} must be a regular directory"
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            std::fs::create_dir(path)?;
            super::super::sync_parent_directory(
                path.parent()
                    .ok_or_else(|| MemoryError::InvalidInput(format!("{label} has no parent")))?,
            )?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub(super) fn write_backup(path: &Path, backup: &BackupManifest) -> Result<()> {
    reject_non_regular_existing(path, "migration backup")?;
    let mut durable = backup.clone();
    durable.integrity_sha256 = backup_integrity_sha256(&durable)?;
    let content = serde_json::to_string_pretty(&durable)?;
    if content.len() > migration_policy()?.max_backup_bytes {
        return Err(MemoryError::InvalidInput(
            "migration backup exceeds the recovery size limit".into(),
        ));
    }
    atomic_write(path, &content)
}

pub(super) fn migration_anchor_path(backup_path: &Path) -> Result<PathBuf> {
    let stem = backup_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| MemoryError::InvalidInput("migration backup filename is invalid".into()))?;
    Ok(backup_path.with_file_name(format!("{stem}.anchor.json")))
}

pub(super) fn anchor_for_backup(backup: &BackupManifest) -> MigrationAnchor {
    MigrationAnchor {
        schema: 1,
        project_id: backup.project_id.clone(),
        migration_id: backup.migration_id.clone(),
        manifest_sha256: backup.manifest_sha256.clone(),
        preview_fingerprint: backup.preview_fingerprint.clone(),
        project_note_sha256: backup.project_note_sha256.clone(),
        source_snapshots: backup.source_snapshots.clone(),
    }
}

pub(super) fn migration_anchor_sha256(anchor: &MigrationAnchor) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(&(
        anchor.schema,
        &anchor.project_id,
        &anchor.migration_id,
        &anchor.manifest_sha256,
        &anchor.project_note_sha256,
        &anchor.source_snapshots,
    ))?))
}

pub(super) fn ensure_migration_anchor(backup_path: &Path, backup: &BackupManifest) -> Result<()> {
    let path = migration_anchor_path(backup_path)?;
    reject_non_regular_existing(&path, "migration anchor")?;
    let expected = anchor_for_backup(backup);
    match read_migration_anchor(&path) {
        Ok(current) if current == expected => return Ok(()),
        Ok(_) => {
            return Err(MemoryError::InvalidInput(
                "migration recovery anchor does not match the original preview".into(),
            ));
        }
        Err(MemoryError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) if !backup_path.exists() => {
            std::fs::remove_file(&path)?;
            super::super::sync_parent_directory(path.parent().ok_or_else(|| {
                MemoryError::InvalidInput("migration anchor has no parent".into())
            })?)?;
            let _ = error;
        }
        Err(error) => return Err(error),
    }
    write_new_migration_anchor(&path, &expected)
}

pub(super) fn write_new_migration_anchor(path: &Path, anchor: &MigrationAnchor) -> Result<()> {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let contents = serde_json::to_vec_pretty(anchor)?;
    let parent = path
        .parent()
        .ok_or_else(|| MemoryError::InvalidInput("migration anchor has no parent".into()))?;
    let temporary = parent.join(format!(
        ".kodmem-anchor-{}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(&contents)?;
    file.sync_all()?;
    drop(file);
    let result = std::fs::hard_link(&temporary, path)
        .and_then(|_| std::fs::File::open(path)?.sync_all())
        .and_then(|_| std::fs::remove_file(&temporary))
        .and_then(|_| std::fs::File::open(parent)?.sync_all());
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(Into::into)
}

fn is_kodmem_temporary_name(name: &str) -> bool {
    let body = name
        .strip_prefix(".kodmem-write-")
        .or_else(|| name.strip_prefix(".kodmem-anchor-"))
        .and_then(|name| name.strip_suffix(".tmp"));
    body.is_some_and(|body| {
        let mut parts = body.split('-');
        matches!((parts.next(), parts.next(), parts.next()), (Some(pid), Some(sequence), None)
            if !pid.is_empty()
                && !sequence.is_empty()
                && pid.bytes().all(|byte| byte.is_ascii_digit())
                && sequence.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

pub(super) fn reconcile_kodmem_temporaries(parent: &Path) -> Result<()> {
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let mut removed = false;
    let mut count = 0_usize;
    for entry in entries {
        let entry = entry?;
        count = count.saturating_add(1);
        if count > migration_policy()?.max_target_scan_files.saturating_add(64) {
            return Err(MemoryError::InvalidInput(
                "migration target directory exceeds its recovery scan limit".into(),
            ));
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_kodmem_temporary_name(&name) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(MemoryError::InvalidInput(
                "migration target temporary entry is not a regular file".into(),
            ));
        }
        std::fs::remove_file(entry.path())?;
        removed = true;
    }
    if removed {
        super::super::sync_parent_directory(parent)?;
    }
    Ok(())
}

pub(super) fn reconcile_migration_runtime_temporaries(
    store: &MemoryStore,
    location: &ProjectLocation,
) -> Result<()> {
    let parent =
        migration_runtime_root(store, false)?.join(super::super::portable_root_key(location)?);
    reconcile_kodmem_temporaries(&parent)
}

pub(super) fn read_migration_anchor(path: &Path) -> Result<MigrationAnchor> {
    reject_non_regular_existing(path, "migration anchor")?;
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > 64 * 1024 {
        return Err(MemoryError::InvalidInput(
            "migration recovery anchor exceeds its bounded size".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        return Err(MemoryError::InvalidInput(
            "migration recovery anchor grew beyond its bounded size".into(),
        ));
    }
    let anchor: MigrationAnchor = serde_json::from_slice(&bytes)?;
    validate_hash("anchor manifest", &anchor.manifest_sha256)?;
    validate_hash("anchor fingerprint", &anchor.preview_fingerprint)?;
    validate_hash("anchor Project.md", &anchor.project_note_sha256)?;
    validate_migration_id(&anchor.migration_id)?;
    for receipt in &anchor.source_snapshots {
        validate_hash("anchor source receipt", &receipt.sha256)?;
    }
    Ok(anchor)
}

pub(super) fn validate_backup_at(
    backup_path: &Path,
    backup: &BackupManifest,
    location: &ProjectLocation,
    migration_id: &str,
    manifest_sha256: &str,
) -> Result<()> {
    validate_backup(backup, location, migration_id, manifest_sha256)?;
    let anchor = read_migration_anchor(&migration_anchor_path(backup_path)?)?;
    if anchor != anchor_for_backup(backup) {
        return Err(MemoryError::InvalidInput(
            "migration backup no longer matches its immutable preview anchor".into(),
        ));
    }
    Ok(())
}

pub(super) fn read_backup(path: &Path) -> Result<BackupManifest> {
    reject_non_regular_existing(path, "migration backup")?;
    let max_backup_bytes = migration_policy()?.max_backup_bytes as u64;
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > max_backup_bytes {
        return Err(MemoryError::InvalidInput(
            "migration backup exceeds the recovery size limit".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(max_backup_bytes + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_backup_bytes {
        return Err(MemoryError::InvalidInput(
            "migration backup grew beyond the recovery size limit".into(),
        ));
    }
    let backup = serde_json::from_slice(&bytes)?;
    Ok(backup)
}

pub(super) fn reject_non_regular_existing(path: &Path, label: &str) -> Result<()> {
    if std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(MemoryError::InvalidInput(format!(
            "{label} must be a regular file"
        )));
    }
    Ok(())
}

pub(super) fn validate_backup(
    backup: &BackupManifest,
    location: &ProjectLocation,
    migration_id: &str,
    manifest_sha256: &str,
) -> Result<()> {
    let policy = migration_policy()?;
    if backup.schema != 1
        || backup.project_id != location.project_id
        || backup.migration_id != migration_id
        || backup.manifest_sha256 != manifest_sha256
    {
        return Err(MemoryError::InvalidInput(
            "migration backup does not match the requested project and manifest".into(),
        ));
    }
    validate_hash("backup preview fingerprint", &backup.preview_fingerprint)?;
    validate_hash("backup project note", &backup.project_note_sha256)?;
    validate_hash("backup integrity", &backup.integrity_sha256)?;
    if backup_integrity_sha256(backup)? != backup.integrity_sha256 {
        return Err(MemoryError::InvalidInput(
            "migration backup integrity check failed".into(),
        ));
    }
    let project_preimage = decode_backup_bytes(&backup.project_note_base64)?;
    if sha256_bytes(&project_preimage) != backup.project_note_sha256
        || project_preimage.len() as u64 > policy.max_document_bytes
    {
        return Err(MemoryError::InvalidInput(
            "migration Project.md backup preimage is invalid".into(),
        ));
    }
    let project_text = std::str::from_utf8(&project_preimage).map_err(|_| {
        MemoryError::InvalidInput("migration Project.md backup preimage is invalid".into())
    })?;
    validate_no_likely_credential("migration Project.md backup preimage", project_text)?;
    super::super::super::scaffold::validate_project_identity(
        &project_preimage,
        &location.project_id,
    )?;
    let authoritative_project =
        super::super::super::scaffold::with_authority_marker(project_text, &location.project_id)?;
    if parse_pending_marker(&authoritative_project, &location.project_id)?.is_some() {
        return Err(MemoryError::InvalidInput(
            "migration Project.md backup preimage cannot contain a pending receipt".into(),
        ));
    }
    let _ = parse_cutover_marker(&authoritative_project, &location.project_id)?;
    let expected_manifest = sha256_bytes(&serde_json::to_vec(&(
        1_u8,
        &backup.project_id,
        &backup.migration_id,
        &backup.source_snapshots,
        backup
            .writes
            .iter()
            .map(|write| &write.public)
            .collect::<Vec<_>>(),
        cutover_targets(&backup.writes, &backup.migration_id)?,
    ))?);
    if expected_manifest != backup.manifest_sha256
        || backup.plan.manifest_sha256.as_deref() != Some(expected_manifest.as_str())
        || backup.plan.fingerprint != backup.preview_fingerprint
    {
        return Err(MemoryError::InvalidInput(
            "migration backup manifest topology is invalid".into(),
        ));
    }
    let expected_fingerprint = sha256_bytes(&serde_json::to_vec(&(
        &backup.manifest_sha256,
        &backup.project_note_sha256,
        &backup.plan.counts,
    ))?);
    let public_operations = backup
        .writes
        .iter()
        .map(|write| write.public.clone())
        .collect::<Vec<_>>();
    if backup.preview_fingerprint != expected_fingerprint
        || backup.plan.operations != public_operations
        || backup.plan.source_snapshots != backup.source_snapshots
        || backup.plan.counts.operations as usize != backup.writes.len()
        || backup.plan.status != LegacyMigrationStatus::Ready
        || !backup.plan.can_apply
        || backup.plan.counts.conflicts != 0
    {
        return Err(MemoryError::InvalidInput(
            "migration backup plan is internally inconsistent".into(),
        ));
    }
    for write in &backup.writes {
        validate_hash("migration operation source", &write.public.source_sha256)?;
        if let Some(hash) = write.public.expected_target_sha256.as_deref() {
            validate_hash("migration operation preimage", hash)?;
        }
        if let Some(hash) = write.public.target_sha256.as_deref() {
            validate_hash("migration operation postimage", hash)?;
        }
        if write.public.action == LegacyMigrationAction::SkipDuplicate {
            let coalesced = backup.writes.iter().any(|peer| {
                peer.public.action != LegacyMigrationAction::SkipDuplicate
                    && peer.public.target_relative_path == write.public.target_relative_path
                    && peer.public.target_sha256 == write.public.target_sha256
                    && peer.public.expected_target_sha256 == write.public.expected_target_sha256
            });
            if write.contents.is_some()
                || (!coalesced && write.public.target_sha256 != write.public.expected_target_sha256)
            {
                return Err(MemoryError::InvalidInput(
                    "migration duplicate operation is malformed".into(),
                ));
            }
        } else if !migration_write_route_is_exact(write)? || write.contents.is_none() {
            return Err(MemoryError::InvalidInput(
                "migration backup contains an unsupported operation".into(),
            ));
        }
    }
    let planned_targets = backup
        .writes
        .iter()
        .filter(|write| write.public.action != LegacyMigrationAction::SkipDuplicate)
        .map(|write| write.public.target_relative_path.as_str())
        .collect::<BTreeSet<_>>();
    if planned_targets.len() != backup.targets.len() {
        return Err(MemoryError::InvalidInput(
            "migration backup targets are duplicated or incomplete".into(),
        ));
    }
    let mut seen_targets = BTreeSet::new();
    let mut decoded_backup_bytes = project_preimage.len();
    for target in &backup.targets {
        if target.relative_path == project_note_relative_path()?
            || !planned_targets.contains(target.relative_path.as_str())
            || !seen_targets.insert(target.relative_path.as_str())
        {
            return Err(MemoryError::InvalidInput(
                "migration backup contains an unauthorized rollback target".into(),
            ));
        }
        let _ = confined_target(location, &target.relative_path)?;
        let before = target
            .before_base64
            .as_deref()
            .map(decode_backup_bytes)
            .transpose()?;
        if before
            .as_ref()
            .is_some_and(|bytes| bytes.len() as u64 > policy.max_document_bytes)
        {
            return Err(MemoryError::InvalidInput(
                "migration backup target preimage exceeds the document limit".into(),
            ));
        }
        if before.as_deref().map(sha256_bytes) != target.before_sha256 {
            return Err(MemoryError::InvalidInput(
                "migration backup target preimage checksum failed".into(),
            ));
        }
        if let Some(before) = before.as_deref() {
            let text = std::str::from_utf8(before).map_err(|_| {
                MemoryError::InvalidInput(
                    "migration backup target preimage must be UTF-8 Markdown".into(),
                )
            })?;
            validate_no_likely_credential("migration backup target preimage", text)?;
            decoded_backup_bytes = decoded_backup_bytes.saturating_add(before.len());
        }
        let write = backup
            .writes
            .iter()
            .find(|write| write.public.target_relative_path == target.relative_path)
            .expect("target membership checked above");
        if write.public.conflict.is_some()
            || !migration_write_route_is_exact(write)?
            || write.public.target_sha256.as_deref() != Some(target.after_sha256.as_str())
            || write.public.expected_target_sha256 != target.before_sha256
        {
            return Err(MemoryError::InvalidInput(
                "migration backup target does not match its allowed operation".into(),
            ));
        }
        if write
            .contents
            .as_deref()
            .map(|contents| sha256_bytes(contents.as_bytes()))
            .as_deref()
            != Some(target.after_sha256.as_str())
        {
            return Err(MemoryError::InvalidInput(
                "migration backup target postimage checksum failed".into(),
            ));
        }
        validate_no_likely_credential(
            "migration recovery content",
            write.contents.as_deref().unwrap_or_default(),
        )?;
    }
    if backup.source_files.len() > policy.max_source_files {
        return Err(MemoryError::InvalidInput(
            "migration backup has too many source files".into(),
        ));
    }
    let mut source_bytes = 0_usize;
    for source in &backup.source_files {
        validate_hash("backup source", &source.sha256)?;
        validate_no_likely_credential("migration backup source workspace", &source.workspace_id)?;
        let _ = repo_source_for_identity(&source.relative_path)?;
        let bytes = decode_backup_bytes(&source.bytes_base64)?;
        source_bytes = source_bytes.saturating_add(bytes.len());
        if bytes.len() as u64 > policy.max_document_bytes
            || source_bytes > policy.max_source_bytes
            || sha256_bytes(&bytes) != source.sha256
        {
            return Err(MemoryError::InvalidInput(
                "migration backup source checksum failed".into(),
            ));
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            MemoryError::InvalidInput("migration backup source must be UTF-8 Markdown".into())
        })?;
        validate_no_likely_credential("migration backup source", text)?;
        decoded_backup_bytes = decoded_backup_bytes.saturating_add(bytes.len());
    }
    if backup.exports.len() > policy.max_source_workspaces {
        return Err(MemoryError::InvalidInput(
            "migration backup has too many database exports".into(),
        ));
    }
    let mut export_workspaces = BTreeSet::new();
    for export in &backup.exports {
        if !export_workspaces.insert(export.workspace_id.as_str())
            || export.json.len().saturating_add(export.markdown.len())
                > policy.max_database_bytes.saturating_mul(2)
        {
            return Err(MemoryError::InvalidInput(
                "migration backup database exports are duplicated or oversized".into(),
            ));
        }
        validate_no_likely_credential("migration backup export workspace", &export.workspace_id)?;
        validate_no_likely_credential("migration backup JSON export", &export.json)?;
        validate_no_likely_credential("migration backup Markdown export", &export.markdown)?;
        let value: serde_json::Value = serde_json::from_str(&export.json)?;
        let object = value.as_object().ok_or_else(|| {
            MemoryError::InvalidInput("migration backup JSON export must be an object".into())
        })?;
        let keys = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
        if keys != BTreeSet::from(["checkpoints", "memories", "schema", "workspaceId"])
            || object.get("schema").and_then(|value| value.as_u64()) != Some(1)
            || object.get("workspaceId").and_then(|value| value.as_str())
                != Some(export.workspace_id.as_str())
            || !object.get("memories").is_some_and(|value| value.is_array())
            || !object
                .get("checkpoints")
                .is_some_and(|value| value.is_array())
        {
            return Err(MemoryError::InvalidInput(
                "migration backup JSON export schema is invalid".into(),
            ));
        }
        decoded_backup_bytes = decoded_backup_bytes
            .saturating_add(export.json.len())
            .saturating_add(export.markdown.len());
    }
    if decoded_backup_bytes > policy.max_backup_bytes {
        return Err(MemoryError::InvalidInput(
            "migration backup decoded payload exceeds its bounded size".into(),
        ));
    }
    Ok(())
}

/// Rebuild the exact pre-migration plan from the retained source snapshot and
/// the journaled target preimages. Backup and adjacent app-data metadata are
/// therefore never their own trust anchor for retrying generated writes.
pub(super) fn validate_backup_source_binding(
    store: &MemoryStore,
    location: &ProjectLocation,
    backup: &BackupManifest,
    snapshot: &LegacySnapshot,
) -> Result<()> {
    if snapshot.receipts != backup.source_snapshots {
        return Err(MemoryError::InvalidInput(
            "migration recovery sources no longer match the prepared snapshot".into(),
        ));
    }
    let staging = tempfile::Builder::new()
        .prefix("kodade-migration-validate-")
        .tempdir()?;
    let staged_root = staging.path().join("project");
    std::fs::create_dir(&staged_root)?;
    let staged = ProjectLocation {
        project_id: location.project_id.clone(),
        project_display_name: location.project_display_name.clone(),
        vault_root: staging.path().to_path_buf(),
        project_root: staged_root,
    };
    stage_backup_preimage(location, &staged, backup)?;

    let seed = serde_json::to_vec(&(
        1_u8,
        &location.project_id,
        canonical_project_snapshot_sha256(&staged)?,
        &snapshot.receipts,
    ))?;
    let expected_migration_id = format!("kmig_{}", &sha256_bytes(&seed)[..32]);
    if expected_migration_id != backup.migration_id {
        return Err(MemoryError::InvalidInput(
            "migration recovery ID is not bound to the retained source and project preimage".into(),
        ));
    }

    let mut counts = LegacyMigrationCounts {
        source_files: portable_snapshot_file_count(&snapshot.files) as u32,
        memories: snapshot
            .databases
            .iter()
            .map(|database| database.memories.len() as u32)
            .sum(),
        checkpoints: snapshot
            .databases
            .iter()
            .map(|database| database.checkpoints.len() as u32)
            .sum(),
        ..LegacyMigrationCounts::default()
    };
    let latest_state_checkpoint_id =
        latest_state_checkpoint_logical_id(&snapshot.databases, &location.project_id)?;
    let has_repo_state = snapshot.files.iter().any(|file| file.kind == "state");
    let mut writes = plan_file_writes(
        &staged,
        &snapshot.files,
        &backup.migration_id,
        latest_state_checkpoint_id.as_deref(),
        &mut counts,
    )?;
    writes.extend(plan_database_writes(
        &staged,
        &snapshot.databases,
        &backup.migration_id,
        has_repo_state,
        &mut counts,
    )?);
    writes.sort_by(|left, right| {
        left.public
            .target_relative_path
            .cmp(&right.public.target_relative_path)
    });
    normalize_planned_targets(&mut writes, &mut counts);
    counts.operations = writes.len() as u32;
    if writes != backup.writes || counts != backup.plan.counts {
        return Err(MemoryError::InvalidInput(
            "migration recovery operations no longer match the retained source snapshot".into(),
        ));
    }
    let expected_manifest = sha256_bytes(&serde_json::to_vec(&(
        1_u8,
        &location.project_id,
        &backup.migration_id,
        &snapshot.receipts,
        writes.iter().map(|write| &write.public).collect::<Vec<_>>(),
        cutover_targets(&writes, &backup.migration_id)?,
    ))?);
    if expected_manifest != backup.manifest_sha256 {
        return Err(MemoryError::InvalidInput(
            "migration recovery manifest is not derivable from retained sources".into(),
        ));
    }
    let staged_plan = ComputedPlan {
        public: backup.plan.clone(),
        location: staged,
        writes,
        snapshot: snapshot.clone(),
        project_note_sha256: backup.project_note_sha256.clone(),
        recovery_backup: None,
    };
    let expected =
        store.prepare_backup(&staged_plan, &backup.migration_id, &backup.manifest_sha256)?;
    if expected.source_files != backup.source_files
        || expected.exports != backup.exports
        || expected.targets != backup.targets
        || expected.project_note_base64 != backup.project_note_base64
    {
        return Err(MemoryError::InvalidInput(
            "migration recovery envelope is not the exact retained-source preimage".into(),
        ));
    }
    Ok(())
}

pub(super) fn stage_backup_preimage(
    live: &ProjectLocation,
    staged: &ProjectLocation,
    backup: &BackupManifest,
) -> Result<()> {
    let mut target_preimages = backup
        .targets
        .iter()
        .map(|target| {
            Ok((
                target.relative_path.clone(),
                target
                    .before_base64
                    .as_deref()
                    .map(decode_backup_bytes)
                    .transpose()?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    let project_preimage = decode_backup_bytes(&backup.project_note_base64)?;
    target_preimages.insert(project_note_relative_path()?, Some(project_preimage));

    let policy = migration_policy()?;
    let paths = scaffold_markdown_paths(live, policy.max_canonical_files)?;
    let mut total = 0_usize;
    for path in paths {
        let relative = path
            .strip_prefix(&live.project_root)
            .map_err(|_| MemoryError::InvalidInput("migration staging path escaped".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = match target_preimages.remove(&relative) {
            Some(bytes) => bytes,
            None => read_optional_bounded_bytes(&path, "migration staging source")?,
        };
        let Some(bytes) = bytes else { continue };
        total = total.saturating_add(bytes.len());
        if total > policy.max_canonical_bytes {
            return Err(MemoryError::InvalidInput(
                "migration recovery staging exceeds the canonical byte limit".into(),
            ));
        }
        write_staged_file(staged, &relative, &bytes)?;
    }
    for (relative, bytes) in target_preimages {
        if let Some(bytes) = bytes {
            total = total.saturating_add(bytes.len());
            if total > policy.max_canonical_bytes {
                return Err(MemoryError::InvalidInput(
                    "migration recovery staging exceeds the canonical byte limit".into(),
                ));
            }
            write_staged_file(staged, &relative, &bytes)?;
        }
    }
    Ok(())
}

pub(super) fn write_staged_file(
    location: &ProjectLocation,
    relative: &str,
    bytes: &[u8],
) -> Result<()> {
    let path = confined_target(location, relative)?;
    ensure_parent_directories(location, &path)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

fn cutover_target_relative_is_valid(target: &CutoverTarget, relative: &str) -> Result<bool> {
    match target.artifact_kind.as_str() {
        "legacy-wrapper" => Ok(repo_target_shape_matches(&target.source_kind, relative)),
        "checkpoint-decision" => {
            let Some((checkpoint_id, index)) = target.artifact_id.rsplit_once(':') else {
                return Ok(false);
            };
            let Ok(index) = index.parse::<usize>() else {
                return Ok(false);
            };
            Ok(relative == checkpoint_decision_relative(checkpoint_id, index)?)
        }
        _ => Ok(false),
    }
}

/// Bind recovery mutations to the identity encoded by their exact generated
/// postimage. Lane-prefix checks alone are insufficient for an untrusted
/// recovery envelope because they can redirect rollback within an allowed lane.
fn migration_write_route_is_exact(write: &PlannedWrite) -> Result<bool> {
    let operation = &write.public;
    let Some(contents) = write.contents.as_deref() else {
        return Ok(false);
    };
    match operation.source_kind.as_str() {
        "state" | "state-history" | "worklog" | "decisions" | "plan" | "imported-records" => {
            Ok(operation.source_relative_path.is_some()
                && repo_target_matches_operation(operation)
                && canonical_repo_migration_marker(contents)
                    .map(parse_repo_migration_marker)
                    .transpose()?
                    .is_some_and(|marker| {
                        marker.source_sha256 == operation.source_sha256
                            && marker.source_origins.iter().any(|origin| {
                                operation.source_relative_path.as_deref()
                                    == Some(origin.legacy_identity.as_str())
                            })
                    }))
        }
        "sqlite-memory" => {
            let Some(line) = first_marker_after_frontmatter(contents) else {
                return Ok(false);
            };
            let marker: RecordMarker = parse_canonical_marker(line, "<!-- kodmem-memory ")?;
            let expected =
                record_relative_path(marker.kind, &marker.record_id, marker.deleted_at.is_some())?;
            Ok(expected == operation.target_relative_path
                && marker
                    .migration
                    .as_ref()
                    .is_some_and(|migration| migration.source_sha256 == operation.source_sha256))
        }
        "sqlite-checkpoint" => {
            let mut found = false;
            for line in contents.lines().map(str::trim) {
                if !line.starts_with("<!-- kodmem-checkpoint ") {
                    continue;
                }
                let marker: CheckpointMarker =
                    parse_canonical_marker(line, "<!-- kodmem-checkpoint ")?;
                if operation.target_relative_path != checkpoint_worklog_relative(marker.created_at)?
                {
                    return Ok(false);
                }
                found |= marker.migration.is_some();
            }
            Ok(found)
        }
        "sqlite-checkpoint-decision" => {
            let Some(line) = first_marker_after_frontmatter(contents) else {
                return Ok(false);
            };
            let marker: CheckpointDecisionMarker =
                parse_canonical_marker(line, "<!-- kodmem-checkpoint-decision ")?;
            Ok(operation.target_relative_path
                == checkpoint_decision_relative(&marker.checkpoint_id, marker.index)?
                && marker.migration.is_some())
        }
        "sqlite-checkpoint-state" => Ok(operation.target_relative_path == state_relative_path()?
            && operation.action == LegacyMigrationAction::ReplacePlaceholder
            && state_checkpoint_id(contents)?.is_some()),
        _ => Ok(false),
    }
}

pub(super) fn backup_integrity_sha256(backup: &BackupManifest) -> Result<String> {
    let canonical = serde_json::to_value((
        backup.schema,
        &backup.project_id,
        &backup.migration_id,
        &backup.manifest_sha256,
        &backup.preview_fingerprint,
        &backup.project_note_sha256,
        &backup.project_note_base64,
        backup.phase,
        &backup.plan,
        &backup.writes,
        &backup.source_snapshots,
        &backup.source_files,
        &backup.exports,
        &backup.targets,
    ))?;
    Ok(sha256_bytes(&serde_json::to_vec(&canonical)?))
}

pub(super) fn decode_backup_bytes(encoded: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| MemoryError::InvalidInput("migration backup contains invalid base64".into()))
}

pub(super) fn validate_hash(label: &str, value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(MemoryError::InvalidInput(format!(
            "{label} must be 64 lowercase hexadecimal characters"
        )));
    }
    Ok(())
}

pub(super) fn validate_migration_id(value: &str) -> Result<()> {
    let suffix = value.strip_prefix("kmig_").unwrap_or_default();
    if suffix.len() != 32
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(MemoryError::InvalidInput(
            "migration ID is malformed".into(),
        ));
    }
    Ok(())
}

pub(super) fn migration_failpoint(stage: &str) -> Result<()> {
    if std::env::var("KODADE_KODMEM_MIGRATION_FAILPOINT")
        .ok()
        .as_deref()
        == Some(stage)
    {
        return Err(MemoryError::Io(std::io::Error::other(format!(
            "legacy migration failpoint: {stage}"
        ))));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_parent_creation_uses_durable_confined_portable_directories() {
        let root = tempfile::tempdir().expect("create migration directory fixture");
        let project_root = root.path().join("portable-project");
        std::fs::create_dir(&project_root).expect("create project root");
        let location = ProjectLocation {
            project_id: "portable-project".into(),
            project_display_name: "Portable project".into(),
            vault_root: root.path().into(),
            project_root: project_root.clone(),
        };

        for relative in ["Plans/Legacy/import.md", "Worklog/2026/2026-08-10.md"] {
            let target = project_root.join(relative);
            ensure_parent_directories(&location, &target).expect("create durable confined parents");
            assert!(target.parent().unwrap().is_dir());
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = root.path().join("outside");
            std::fs::create_dir(&outside).unwrap();
            let linked = project_root.join("Knowledge");
            symlink(&outside, &linked).unwrap();
            let error = ensure_parent_directories(
                &location,
                &project_root.join("Knowledge/Legacy/import.md"),
            )
            .expect_err("portable parent creation rejects a symlinked lane");
            assert!(error.to_string().contains("regular directory"));
        }
    }
}
