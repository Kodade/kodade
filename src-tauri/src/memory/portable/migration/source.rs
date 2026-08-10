use super::*;

pub(super) fn collect_legacy_snapshot(
    store: &MemoryStore,
    mappings: &[WorkspaceProjectMapping],
) -> Result<LegacySnapshot> {
    let policy = migration_policy()?;
    let mut files = Vec::new();
    let mut databases = Vec::new();
    let mut receipts = BTreeSet::new();
    let mut sources = Vec::new();
    let mut file_count = 0_usize;
    let mut byte_count = 0_usize;
    let mut entry_count = 0_usize;
    let mut database_records = 0_usize;
    let mut database_links = 0_usize;
    let mut database_bytes = 0_usize;
    if mappings.len() > policy.max_source_workspaces {
        return Err(MemoryError::InvalidInput(
            "logical project exceeds the migration workspace limit".into(),
        ));
    }
    for mapping in mappings {
        let root = Path::new(&mapping.workspace_root);
        let root_metadata = std::fs::symlink_metadata(root)?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err(MemoryError::InvalidInput(
                "registered workspace root must remain a regular directory during migration".into(),
            ));
        }
        let memory_root = root.join(".kodade/memory");
        match std::fs::symlink_metadata(&memory_root) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(MemoryError::InvalidInput(
                    "legacy memory root must be a regular directory, not a symlink".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut workspace_files = Vec::new();
        for source_policy in &policy.repo_sources {
            for name in &source_policy.exact_paths {
                collect_legacy_file(
                    root,
                    &memory_root.join(name),
                    &source_policy.kind,
                    mapping,
                    policy,
                    &mut workspace_files,
                    &mut file_count,
                    &mut byte_count,
                )?;
            }
        }
        let memory_entries = match std::fs::read_dir(&memory_root) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if let Some(entries) = memory_entries {
            for entry in entries {
                let entry = entry?;
                entry_count = entry_count.saturating_add(1);
                if entry_count > policy.max_source_files.saturating_mul(2) {
                    return Err(MemoryError::InvalidInput(
                        "legacy memory exceeds the migration entry limit".into(),
                    ));
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(source_policy) = policy.repo_sources.iter().find(|source| {
                    source
                        .root_prefix
                        .as_ref()
                        .is_some_and(|prefix| name.starts_with(prefix))
                        && source
                            .root_suffix
                            .as_ref()
                            .is_none_or(|suffix| name.ends_with(suffix))
                }) {
                    collect_legacy_file(
                        root,
                        &entry.path(),
                        &source_policy.kind,
                        mapping,
                        policy,
                        &mut workspace_files,
                        &mut file_count,
                        &mut byte_count,
                    )?;
                }
            }
        }
        for source_policy in policy
            .repo_sources
            .iter()
            .filter(|source| source.recursive_directory.is_some())
        {
            collect_plan_files(
                root,
                &memory_root.join(source_policy.recursive_directory.as_deref().unwrap()),
                &source_policy.kind,
                source_policy.recursive_extension.as_deref(),
                mapping,
                policy,
                &mut workspace_files,
                &mut file_count,
                &mut byte_count,
                &mut entry_count,
                0,
            )?;
        }
        workspace_files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        if !workspace_files.is_empty() {
            let digest = digest_repo_files(&workspace_files)?;
            for file in &mut workspace_files {
                file.snapshot_sha256 = digest.clone();
            }
            receipts.insert(SourceSnapshotReceipt {
                kind: "repo-readable-v1".into(),
                sha256: digest,
            });
        }
        files.extend(workspace_files);

        let database = collect_legacy_database(store, mapping)?;
        if !database.memories.is_empty() || !database.checkpoints.is_empty() {
            receipts.insert(SourceSnapshotReceipt {
                kind: "sqlite-legacy-v1".into(),
                sha256: database.sha256.clone(),
            });
            database_records = database_records
                .saturating_add(database.memories.len())
                .saturating_add(database.checkpoints.len());
            database_links = database_links.saturating_add(database.link_count);
            database_bytes = database_bytes.saturating_add(database.serialized_bytes);
            if database_records > policy.max_database_records
                || database_links > policy.max_database_links
                || database_bytes > policy.max_database_bytes
            {
                return Err(MemoryError::InvalidInput(
                    "logical project legacy SQLite data exceeds the aggregate migration limit"
                        .into(),
                ));
            }
            databases.push(database);
        }
        if receipts.len() > policy.max_source_receipts {
            return Err(MemoryError::InvalidInput(
                "logical project exceeds the migration source receipt limit".into(),
            ));
        }
        let snapshot_count = receipts_for_workspace(&files, &databases, &mapping.workspace_id);
        if snapshot_count > 0 {
            sources.push(LegacyMigrationSource {
                workspace_id: mapping.workspace_id.clone(),
                workspace_display_name: mapping.workspace_display_name.clone(),
                snapshot_count,
            });
        }
    }
    files.sort_by(|left, right| {
        (&left.workspace_id, &left.relative_path).cmp(&(&right.workspace_id, &right.relative_path))
    });
    databases.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    sources.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    Ok(LegacySnapshot {
        files,
        databases,
        receipts: receipts.into_iter().collect(),
        sources,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn collect_legacy_file(
    workspace_root: &Path,
    path: &Path,
    kind: &str,
    mapping: &WorkspaceProjectMapping,
    policy: &MigrationPolicy,
    output: &mut Vec<LegacyFile>,
    file_count: &mut usize,
    byte_count: &mut usize,
) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::InvalidInput(format!(
            "eligible legacy memory must be a regular file: {}",
            path.display()
        )));
    }
    let canonical_root = std::fs::canonicalize(workspace_root)?;
    let canonical = std::fs::canonicalize(path)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(MemoryError::InvalidInput(
            "legacy memory escapes its registered workspace".into(),
        ));
    }
    let mut file = File::open(&canonical)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.len() > policy.max_document_bytes {
        return Err(MemoryError::InvalidInput(format!(
            "eligible legacy memory exceeds the per-file limit: {}",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    (&mut file)
        .take(policy.max_document_bytes + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > policy.max_document_bytes {
        return Err(MemoryError::InvalidInput(format!(
            "eligible legacy memory grew beyond the per-file limit: {}",
            path.display()
        )));
    }
    let after = file.metadata()?;
    if after.len() != opened.len() || after.modified().ok() != opened.modified().ok() {
        return Err(MemoryError::InvalidInput(format!(
            "eligible legacy memory changed while it was read: {}",
            path.display()
        )));
    }
    *file_count += 1;
    *byte_count = byte_count.saturating_add(bytes.len());
    if *file_count > policy.max_source_files || *byte_count > policy.max_source_bytes {
        return Err(MemoryError::InvalidInput(
            "eligible legacy memory exceeds the bounded migration scan".into(),
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        MemoryError::InvalidInput(format!("legacy memory must be UTF-8: {}", path.display()))
    })?;
    if !is_substantive(kind, &text) {
        return Ok(());
    }
    validate_no_likely_credential("legacy memory", &text).map_err(|_| {
        MemoryError::InvalidInput(format!(
            "eligible legacy memory contains likely credentials: {}",
            path.display()
        ))
    })?;
    let relative_path = canonical
        .strip_prefix(&canonical_root)
        .map_err(|_| MemoryError::InvalidInput("legacy memory escapes its workspace".into()))?
        .to_string_lossy()
        .replace('\\', "/");
    let modified_at = portable_source_timestamp(&relative_path, &text);
    output.push(LegacyFile {
        workspace_id: mapping.workspace_id.clone(),
        relative_path,
        kind: kind.into(),
        sha256: sha256_bytes(text.as_bytes()),
        snapshot_sha256: String::new(),
        modified_at,
        text,
    });
    Ok(())
}

/// Canonical provenance cannot depend on checkout-local filesystem mtimes.
/// Preserve an explicit timestamp embedded in the source when available;
/// otherwise use the stable unknown value `0`.
fn portable_source_timestamp(relative_path: &str, text: &str) -> i64 {
    for line in text.lines().map(str::trim) {
        let value = ["Updated:", "updated_at:", "updatedAt:"]
            .into_iter()
            .find_map(|prefix| line.strip_prefix(prefix).map(str::trim));
        let Some(value) = value else { continue };
        if let Ok(timestamp) = value.parse::<i64>() {
            return timestamp.max(0);
        }
        if let Some(timestamp) = parse_utc_timestamp(value) {
            return timestamp;
        }
    }
    let name = Path::new(relative_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    name.strip_prefix("WORKLOG-")
        .and_then(|date| parse_utc_timestamp(&format!("{date}T00:00:00Z")))
        .unwrap_or(0)
}

fn parse_utc_timestamp(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    let (millis, separator) = match bytes.len() {
        20 if bytes[19] == b'Z' => (0, b':'),
        24 if bytes[19] == b'-' && bytes[23] == b'Z' => {
            (value.get(20..23)?.parse::<i64>().ok()?, b'-')
        }
        _ => return None,
    };
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != separator
        || bytes[16] != separator
    {
        return None;
    }
    let number = |start: usize, end: usize| value.get(start..end)?.parse::<i64>().ok();
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    let leap = year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0);
    let max_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return None,
    };
    if !(1..=max_day).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn collect_plan_files(
    workspace_root: &Path,
    directory: &Path,
    kind: &str,
    extension: Option<&str>,
    mapping: &WorkspaceProjectMapping,
    policy: &MigrationPolicy,
    output: &mut Vec<LegacyFile>,
    file_count: &mut usize,
    byte_count: &mut usize,
    entry_count: &mut usize,
    depth: usize,
) -> Result<()> {
    if depth > 8 {
        return Err(MemoryError::InvalidInput(
            "legacy plans exceed the migration directory depth limit".into(),
        ));
    }
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MemoryError::InvalidInput(format!(
            "legacy plans directory must be a regular directory: {}",
            directory.display()
        )));
    }
    let entries = std::fs::read_dir(directory)?;
    for entry in entries {
        let entry = entry?;
        *entry_count = (*entry_count).saturating_add(1);
        if *entry_count > policy.max_source_files.saturating_mul(2) {
            return Err(MemoryError::InvalidInput(
                "legacy plans exceed the migration entry limit".into(),
            ));
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(MemoryError::InvalidInput(format!(
                "legacy plans cannot contain symlinks: {}",
                entry.path().display()
            )));
        }
        if file_type.is_dir() {
            collect_plan_files(
                workspace_root,
                &entry.path(),
                kind,
                extension,
                mapping,
                policy,
                output,
                file_count,
                byte_count,
                entry_count,
                depth + 1,
            )?;
        } else if extension.is_none_or(|extension| {
            entry.path().extension().and_then(|value| value.to_str()) == Some(extension)
        }) {
            collect_legacy_file(
                workspace_root,
                &entry.path(),
                kind,
                mapping,
                policy,
                output,
                file_count,
                byte_count,
            )?;
        }
    }
    Ok(())
}

pub(super) fn collect_legacy_database(
    store: &MemoryStore,
    mapping: &WorkspaceProjectMapping,
) -> Result<LegacyDatabase> {
    store.run_with_recovery(|| {
        let mut connection = store.connection()?;
        let transaction = connection.transaction()?;
        let policy = migration_policy()?;
        let record_count: usize = transaction.query_row(
            "SELECT
                (SELECT COUNT(*) FROM memories WHERE workspace_id = ?1 AND canonical_project_id IS NULL)
                + (SELECT COUNT(*) FROM checkpoints WHERE workspace_id = ?1 AND canonical_project_id IS NULL)",
            [&mapping.workspace_id],
            |row| row.get(0),
        )?;
        if record_count > policy.max_database_records {
            return Err(MemoryError::InvalidInput(
                "legacy SQLite data exceeds the migration record limit".into(),
            ));
        }
        let link_count: usize = transaction.query_row(
            "SELECT COUNT(*) FROM memory_links links
             JOIN memories source ON source.id = links.source_id
             WHERE source.workspace_id = ?1 AND source.canonical_project_id IS NULL",
            [&mapping.workspace_id],
            |row| row.get(0),
        )?;
        if link_count > policy.max_database_links {
            return Err(MemoryError::InvalidInput(
                "legacy SQLite data exceeds the migration link limit".into(),
            ));
        }
        let field_limit = i64::try_from(policy.max_document_bytes).map_err(|_| {
            MemoryError::InvalidInput("legacy SQLite field limit is invalid".into())
        })?;
        let oversized_fields: bool = transaction.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM memories
                WHERE workspace_id = ?1 AND canonical_project_id IS NULL AND (
                    length(CAST(id AS BLOB)) > ?2 OR length(CAST(kind AS BLOB)) > ?2
                    OR length(CAST(title AS BLOB)) > ?2 OR length(CAST(body AS BLOB)) > ?2
                    OR length(CAST(source AS BLOB)) > ?2 OR length(CAST(source_client AS BLOB)) > ?2
                    OR length(CAST(COALESCE(session_id, '') AS BLOB)) > ?2
                    OR length(CAST(COALESCE(idempotency_key, '') AS BLOB)) > ?2
                )
                UNION ALL
                SELECT 1 FROM checkpoints
                WHERE workspace_id = ?1 AND canonical_project_id IS NULL AND (
                    length(CAST(id AS BLOB)) > ?2 OR length(CAST(summary AS BLOB)) > ?2
                    OR length(CAST(decisions_json AS BLOB)) > ?2
                    OR length(CAST(next_actions_json AS BLOB)) > ?2
                    OR length(CAST(changed_paths_json AS BLOB)) > ?2
                    OR length(CAST(source AS BLOB)) > ?2 OR length(CAST(source_client AS BLOB)) > ?2
                    OR length(CAST(COALESCE(session_id, '') AS BLOB)) > ?2
                    OR length(CAST(COALESCE(idempotency_key, '') AS BLOB)) > ?2
                )
                UNION ALL
                SELECT 1 FROM memory_links links
                JOIN memories source ON source.id = links.source_id
                WHERE source.workspace_id = ?1 AND source.canonical_project_id IS NULL AND (
                    length(CAST(links.source_id AS BLOB)) > ?2
                    OR length(CAST(links.target_id AS BLOB)) > ?2
                    OR length(CAST(links.relation AS BLOB)) > ?2
                )
            )",
            rusqlite::params![&mapping.workspace_id, field_limit],
            |row| row.get(0),
        )?;
        if oversized_fields {
            return Err(MemoryError::InvalidInput(
                "legacy SQLite data exceeds the per-field migration limit".into(),
            ));
        }
        let database_bytes: i64 = transaction.query_row(
            "SELECT
                COALESCE((SELECT SUM(
                    length(CAST(id AS BLOB)) + length(CAST(kind AS BLOB))
                    + length(CAST(title AS BLOB)) + length(CAST(body AS BLOB))
                    + length(CAST(source AS BLOB)) + length(CAST(source_client AS BLOB))
                    + length(CAST(COALESCE(session_id, '') AS BLOB))
                    + length(CAST(COALESCE(idempotency_key, '') AS BLOB))
                ) FROM memories WHERE workspace_id = ?1 AND canonical_project_id IS NULL), 0)
                + COALESCE((SELECT SUM(
                    length(CAST(id AS BLOB)) + length(CAST(summary AS BLOB))
                    + length(CAST(decisions_json AS BLOB)) + length(CAST(next_actions_json AS BLOB))
                    + length(CAST(changed_paths_json AS BLOB)) + length(CAST(source AS BLOB))
                    + length(CAST(source_client AS BLOB))
                    + length(CAST(COALESCE(session_id, '') AS BLOB))
                    + length(CAST(COALESCE(idempotency_key, '') AS BLOB))
                ) FROM checkpoints WHERE workspace_id = ?1 AND canonical_project_id IS NULL), 0)
                + COALESCE((SELECT SUM(
                    length(CAST(links.source_id AS BLOB)) + length(CAST(links.target_id AS BLOB))
                    + length(CAST(links.relation AS BLOB))
                ) FROM memory_links links JOIN memories source ON source.id = links.source_id
                  WHERE source.workspace_id = ?1 AND source.canonical_project_id IS NULL), 0)",
            [&mapping.workspace_id],
            |row| row.get(0),
        )?;
        if database_bytes < 0 || database_bytes as usize > policy.max_database_bytes {
            return Err(MemoryError::InvalidInput(
                "legacy SQLite data exceeds the migration byte limit".into(),
            ));
        }
        let mut memory_statement = transaction.prepare(
            "SELECT id FROM memories WHERE workspace_id = ?1 AND canonical_project_id IS NULL ORDER BY created_at, id",
        )?;
        let memory_ids = memory_statement.query_map([&mapping.workspace_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(memory_statement);
        let memories = memory_ids
            .iter()
            .map(|id| {
                let record = memory_with_connection(&transaction, id)?;
                let idempotency_key = transaction.query_row(
                    "SELECT idempotency_key FROM memories WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )?;
                Ok(LegacyMemory {
                    record,
                    idempotency_key,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut checkpoint_statement = transaction.prepare(
            "SELECT id FROM checkpoints WHERE workspace_id = ?1 AND canonical_project_id IS NULL ORDER BY created_at, id",
        )?;
        let checkpoint_ids = checkpoint_statement.query_map([&mapping.workspace_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(checkpoint_statement);
        let checkpoints = checkpoint_ids
            .iter()
            .map(|id| {
                let checkpoint = checkpoint_with_connection(&transaction, id)?;
                let (idempotency_key, updates_state) = transaction.query_row(
                    "SELECT idempotency_key, updates_state FROM checkpoints WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                Ok(LegacyCheckpoint {
                    checkpoint,
                    idempotency_key,
                    updates_state,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let memory_json = serde_json::to_string(&memories)?;
        let checkpoint_json = serde_json::to_string(&checkpoints)?;
        if memory_json.len().saturating_add(checkpoint_json.len()) > policy.max_database_bytes {
            return Err(MemoryError::InvalidInput(
                "legacy SQLite data exceeds the migration byte limit".into(),
            ));
        }
        validate_no_likely_credential(
            "legacy SQLite memories",
            &memory_json,
        )?;
        validate_no_likely_credential(
            "legacy SQLite checkpoints",
            &checkpoint_json,
        )?;
        let digest = sha256_bytes(&serde_json::to_vec(&(&memories, &checkpoints))?);
        Ok(LegacyDatabase {
            workspace_id: mapping.workspace_id.clone(),
            memories,
            checkpoints,
            serialized_bytes: memory_json.len().saturating_add(checkpoint_json.len()),
            link_count,
            sha256: digest,
        })
    })
}

pub(super) fn digest_repo_files(files: &[LegacyFile]) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(
        &files
            .iter()
            .map(|file| (&file.kind, &file.relative_path, &file.sha256))
            .collect::<Vec<_>>(),
    )?))
}

pub(super) fn uncovered_snapshot(
    snapshot: LegacySnapshot,
    cutover: Option<&CutoverMarker>,
) -> LegacySnapshot {
    let covered = cutover
        .into_iter()
        .flat_map(|marker| marker.migrations.iter())
        .flat_map(|migration| migration.source_snapshots.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    let imported_targets = cutover
        .into_iter()
        .flat_map(|marker| marker.migrations.iter())
        .flat_map(|migration| migration.targets.iter())
        .collect::<Vec<_>>();
    let uncovered_receipts = snapshot
        .receipts
        .iter()
        .filter(|receipt| !covered.contains(*receipt))
        .cloned()
        .collect::<BTreeSet<_>>();
    let files = snapshot
        .files
        .into_iter()
        .filter(|file| {
            let receipt = SourceSnapshotReceipt {
                kind: "repo-readable-v1".into(),
                sha256: file.snapshot_sha256.clone(),
            };
            uncovered_receipts.contains(&receipt)
                && !legacy_file_component_is_imported(file, &imported_targets)
        })
        .collect::<Vec<_>>();
    let databases = snapshot
        .databases
        .into_iter()
        .filter(|database| {
            uncovered_receipts.contains(&SourceSnapshotReceipt {
                kind: "sqlite-legacy-v1".into(),
                sha256: database.sha256.clone(),
            })
        })
        .collect::<Vec<_>>();
    let source_names = snapshot
        .sources
        .into_iter()
        .map(|source| (source.workspace_id, source.workspace_display_name))
        .collect::<BTreeMap<_, _>>();
    let mut sources = source_names
        .into_iter()
        .filter_map(|(workspace_id, workspace_display_name)| {
            let snapshot_count = receipts_for_workspace(&files, &databases, &workspace_id);
            (snapshot_count > 0).then_some(LegacyMigrationSource {
                workspace_id,
                workspace_display_name,
                snapshot_count,
            })
        })
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    LegacySnapshot {
        files,
        databases,
        receipts: uncovered_receipts.into_iter().collect(),
        sources,
    }
}

pub(super) fn legacy_file_component_is_imported(
    file: &LegacyFile,
    targets: &[&CutoverTarget],
) -> bool {
    if file.kind == "state" {
        return targets.iter().any(|target| {
            target.source_kind == "state"
                && target.artifact_kind == "state-lineage"
                && target.artifact_id == file.sha256
        });
    }
    let Ok(relative) = legacy_file_target_relative(file) else {
        return false;
    };
    targets.iter().any(|target| {
        target.source_kind == file.kind
            && target.artifact_kind == "legacy-wrapper"
            && target.artifact_id == file.sha256
            && target.relative_path.as_deref() == Some(relative.as_str())
    })
}

pub(super) fn legacy_file_target_relative(source: &LegacyFile) -> Result<String> {
    render_repo_target(repo_source_for_kind(&source.kind)?, source)
}

pub(super) fn render_legacy_database_export(database: &LegacyDatabase) -> String {
    let mut output = String::from("# Legacy KödMem durable export\n\n");
    for memory in &database.memories {
        let memory = &memory.record;
        output.push_str(&format!(
            "## {}\n\nLegacy ID: `{}`\n\n{}\n\n",
            memory.title,
            memory.id,
            memory.body.trim_end()
        ));
    }
    for checkpoint in &database.checkpoints {
        let checkpoint = &checkpoint.checkpoint;
        output.push_str(&format!(
            "## Checkpoint {}\n\n{}\n\n",
            checkpoint.id,
            checkpoint.summary.trim_end()
        ));
    }
    output
}
