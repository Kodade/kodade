use super::*;

impl MemoryStore {
    /// Produce a complete, bounded plan without changing SQLite or either tree.
    pub fn preview_legacy_migration(&self, workspace_id: &str) -> Result<LegacyMigrationPlan> {
        Ok(self.compute_legacy_migration(workspace_id)?.public)
    }

    /// Apply exactly the state observed by a preview, retaining all legacy data.
    pub fn apply_legacy_migration(
        &self,
        workspace_id: &str,
        expected_fingerprint: &str,
    ) -> Result<LegacyMigrationApply> {
        self.require_migration_write_access()?;
        validate_hash("migration fingerprint", expected_fingerprint)?;
        let location = self.project_location(workspace_id)?.ok_or_else(|| {
            MemoryError::InvalidInput("map this workspace before migrating legacy memory".into())
        })?;
        let _lock = self.lock_portable_project(&location)?;
        self.require_same_project_mapping(workspace_id, &location)?;
        super::super::validate_project_root(&location)?;
        reconcile_migration_runtime_temporaries(self, &location)?;
        reconcile_kodmem_temporaries(&location.project_root)?;
        self.recover_completed_migration(&location, workspace_id)?;
        let plan = self.compute_legacy_migration_at(workspace_id, location.clone())?;
        self.require_same_project_mapping(workspace_id, &location)?;
        if plan.public.status == LegacyMigrationStatus::Complete {
            let project_text = read_bounded_regular(
                &plan
                    .location
                    .project_root
                    .join(project_note_relative_path()?),
                "Project.md",
            )?;
            let cutover = parse_cutover_marker(&project_text, &plan.location.project_id)?
                .ok_or_else(|| {
                    MemoryError::InvalidInput("completed migration receipt is unavailable".into())
                })?;
            for migration in cutover.migrations.iter().rev() {
                let path =
                    migration_backup_path(self, &plan.location, &migration.migration_id, false)?;
                let backup = match read_backup(&path) {
                    Ok(backup) => backup,
                    Err(MemoryError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                        continue
                    }
                    Err(error) => return Err(error),
                };
                validate_backup_at(
                    &path,
                    &backup,
                    &plan.location,
                    &migration.migration_id,
                    &migration.manifest_sha256,
                )?;
                if backup.preview_fingerprint == expected_fingerprint
                    && backup.phase == BackupPhase::Complete
                {
                    return Ok(LegacyMigrationApply {
                        project_id: plan.location.project_id,
                        migration_id: migration.migration_id.clone(),
                        manifest_sha256: migration.manifest_sha256.clone(),
                        written: 0,
                        skipped: backup.targets.len() as u32,
                        backup_path: path.to_string_lossy().into_owned(),
                        source_retained: true,
                    });
                }
            }
        }
        if plan.public.fingerprint != expected_fingerprint {
            return Err(MemoryError::InvalidInput(
                "legacy memory changed after preview; refresh the migration preview".into(),
            ));
        }
        if !plan.public.can_apply {
            return Err(MemoryError::InvalidInput(
                "legacy migration cannot apply until every reported conflict is resolved".into(),
            ));
        }
        let migration_id = plan.public.migration_id.clone().ok_or_else(|| {
            MemoryError::InvalidInput("there is no eligible legacy memory to migrate".into())
        })?;
        let manifest_sha256 = plan.public.manifest_sha256.clone().ok_or_else(|| {
            MemoryError::InvalidInput("legacy migration manifest is unavailable".into())
        })?;
        let backup_path = migration_backup_path(self, &location, &migration_id, false)?;
        super::super::validate_project_root(&location)?;
        let mut backup = if let Some(backup) = plan.recovery_backup.clone() {
            validate_backup_source_binding(self, &location, &backup, &plan.snapshot)?;
            backup
        } else {
            let backup = self.prepare_backup(&plan, &migration_id, &manifest_sha256)?;
            // Validate the complete source/export/preimage envelope and every
            // preview CAS before creating the durable recovery namespace.
            validate_backup(&backup, &location, &migration_id, &manifest_sha256)?;
            let created_path = migration_backup_path(self, &location, &migration_id, true)?;
            if created_path != backup_path {
                return Err(MemoryError::InvalidInput(
                    "migration recovery namespace changed during apply".into(),
                ));
            }
            ensure_migration_anchor(&backup_path, &backup)?;
            write_backup(&backup_path, &backup)?;
            validate_backup_at(
                &backup_path,
                &backup,
                &location,
                &migration_id,
                &manifest_sha256,
            )?;
            migration_failpoint("backup")?;
            backup
        };

        let project_preimage = String::from_utf8(decode_backup_bytes(&backup.project_note_base64)?)
            .map_err(|_| {
                MemoryError::InvalidInput("migration Project.md preimage is not UTF-8".into())
            })?;
        let pending_marker = PendingMarker {
            schema: 1,
            project_id: location.project_id.clone(),
            migration_id: migration_id.clone(),
            manifest_sha256: manifest_sha256.clone(),
            recovery_anchor_sha256: migration_anchor_sha256(&anchor_for_backup(&backup))?,
            phase: PendingPhase::Applying,
        };
        let pending_project = with_pending_marker(&project_preimage, &pending_marker)?;
        let project_path = plan
            .location
            .project_root
            .join(project_note_relative_path()?);
        super::super::validate_project_root(&location)?;
        let current_project = read_bounded_regular(&project_path, "Project.md")?;
        if current_project == project_preimage {
            reconcile_kodmem_temporaries(&plan.location.project_root)?;
            super::super::validate_project_root(&location)?;
            atomic_write(&project_path, &pending_project)?;
            migration_failpoint("pending")?;
        } else if current_project != pending_project {
            return Err(MemoryError::ContentConflict {
                expected: sha256_bytes(project_preimage.as_bytes()),
                actual: sha256_bytes(current_project.as_bytes()),
            });
        }

        let mut written = 0;
        let mut skipped = 0;
        for (index, write) in plan.writes.iter().enumerate() {
            super::super::validate_project_root(&location)?;
            if write.public.action == LegacyMigrationAction::SkipDuplicate {
                skipped += 1;
                continue;
            }
            let target = confined_target(&plan.location, &write.public.target_relative_path)?;
            reconcile_kodmem_temporaries(target.parent().ok_or_else(|| {
                MemoryError::InvalidInput("migration target has no parent".into())
            })?)?;
            let current = file_hash_optional(&target)?;
            let desired = write.contents.as_deref().ok_or_else(|| {
                MemoryError::InvalidInput("migration write is missing generated content".into())
            })?;
            let desired_hash = sha256_bytes(desired.as_bytes());
            if current.as_deref() == Some(&desired_hash) {
                skipped += 1;
                continue;
            }
            if current != write.public.expected_target_sha256 {
                return Err(MemoryError::ContentConflict {
                    expected: write
                        .public
                        .expected_target_sha256
                        .clone()
                        .unwrap_or_else(|| "missing".into()),
                    actual: current.unwrap_or_else(|| "missing".into()),
                });
            }
            ensure_parent_directories(&plan.location, &target)?;
            atomic_write(&target, desired)?;
            written += 1;
            migration_failpoint(&format!("markdown-{}", index + 1))?;
        }
        backup.phase = BackupPhase::MarkdownWritten;
        write_backup(&backup_path, &backup)?;

        validate_written_plan(&plan)?;
        super::super::validate_project_root(&location)?;
        // Structured canonical records must parse before authority can change.
        let _ = collect_memories(&plan.location)?;
        let _ = collect_checkpoints(&plan.location)?;
        migration_failpoint("validation")?;

        let mut cutover = parse_cutover_marker(&project_preimage, &plan.location.project_id)?
            .unwrap_or_else(|| CutoverMarker {
                schema: 1,
                project_id: plan.location.project_id.clone(),
                authority: "projects-vault".into(),
                migrations: Vec::new(),
            });
        merge_cutover(
            &mut cutover,
            CutoverMigration {
                migration_id: migration_id.clone(),
                manifest_sha256: manifest_sha256.clone(),
                recovery_anchor_sha256: migration_anchor_sha256(&anchor_for_backup(&backup))?,
                source_snapshots: plan.snapshot.receipts.clone(),
                targets: cutover_targets(&plan.writes, &migration_id)?,
            },
        )?;
        let project_note = with_cutover_marker(&project_preimage, &cutover)?;
        if project_note.len() > migration_policy()?.max_cutover_bytes {
            return Err(MemoryError::InvalidInput(
                "Project.md cutover receipts exceed the bounded authority file limit".into(),
            ));
        }

        // Build the derived projection while migration-owned notes are still
        // hidden. The staged knowledge index uses the prospective authority
        // bytes so it is complete before the final vault write.
        self.project_canonical_notes(&plan.location, workspace_id, None)?;
        self.stage_project_knowledge(workspace_id, &project_note)?;
        migration_failpoint("projection")?;

        self.require_same_project_mapping(workspace_id, &location)?;
        super::super::validate_project_root(&location)?;
        let current_project = read_bounded_regular(&project_path, "Project.md")?;
        if current_project != pending_project {
            return Err(MemoryError::ContentConflict {
                expected: sha256_bytes(pending_project.as_bytes()),
                actual: sha256_bytes(current_project.as_bytes()),
            });
        }
        reconcile_kodmem_temporaries(&plan.location.project_root)?;
        super::super::validate_project_root(&location)?;
        atomic_write(&project_path, &project_note)?;
        migration_failpoint("cutover-receipt")?;
        backup.phase = BackupPhase::Cutover;
        write_backup(&backup_path, &backup)?;
        migration_failpoint("cutover")?;
        backup.phase = BackupPhase::Complete;
        write_backup(&backup_path, &backup)?;

        Ok(LegacyMigrationApply {
            project_id: plan.location.project_id,
            migration_id,
            manifest_sha256,
            written,
            skipped,
            backup_path: backup_path.to_string_lossy().into_owned(),
            source_retained: true,
        })
    }

    /// Roll back only if every migration-owned target still matches its postimage.
    pub fn rollback_legacy_migration(
        &self,
        workspace_id: &str,
        migration_id: &str,
        expected_manifest_sha256: &str,
    ) -> Result<LegacyMigrationRollback> {
        self.require_migration_write_access()?;
        validate_migration_id(migration_id)?;
        validate_hash("migration manifest", expected_manifest_sha256)?;
        let location = self.project_location(workspace_id)?.ok_or_else(|| {
            MemoryError::InvalidInput("map this workspace before rolling back migration".into())
        })?;
        let _lock = self.lock_portable_project(&location)?;
        self.require_same_project_mapping(workspace_id, &location)?;
        super::super::validate_project_root(&location)?;
        reconcile_migration_runtime_temporaries(self, &location)?;
        reconcile_kodmem_temporaries(&location.project_root)?;
        let backup_path = migration_backup_path(self, &location, migration_id, false)?;
        let mut backup = read_backup(&backup_path)?;
        validate_backup_at(
            &backup_path,
            &backup,
            &location,
            migration_id,
            expected_manifest_sha256,
        )?;
        let project_path = location.project_root.join(project_note_relative_path()?);
        super::super::validate_project_root(&location)?;
        let project_preimage = String::from_utf8(decode_backup_bytes(&backup.project_note_base64)?)
            .map_err(|_| {
                MemoryError::InvalidInput("migration Project.md preimage is not UTF-8".into())
            })?;
        let project_text = read_bounded_regular(&project_path, "Project.md")?;
        let pending = parse_pending_marker(&project_text, &location.project_id)?;
        let cutover = if pending.is_none() {
            parse_cutover_marker(&project_text, &location.project_id)?
        } else {
            None
        };
        let matching_receipt = cutover.as_ref().is_some_and(|cutover| {
            cutover.migrations.iter().any(|entry| {
                entry.migration_id == migration_id
                    && entry.manifest_sha256 == expected_manifest_sha256
                    && entry.recovery_anchor_sha256
                        == migration_anchor_sha256(&anchor_for_backup(&backup)).unwrap_or_default()
            })
        });
        let pending_rolling = pending
            .as_ref()
            .is_some_and(|marker| marker.phase == PendingPhase::RollingBack);
        if matches!(backup.phase, BackupPhase::Cutover | BackupPhase::Complete)
            && !matching_receipt
            && !pending_rolling
        {
            return Err(MemoryError::InvalidInput(
                "migration cutover receipt no longer matches the backup".into(),
            ));
        }
        let applying_marker = PendingMarker {
            schema: 1,
            project_id: location.project_id.clone(),
            migration_id: migration_id.into(),
            manifest_sha256: expected_manifest_sha256.into(),
            recovery_anchor_sha256: migration_anchor_sha256(&anchor_for_backup(&backup))?,
            phase: PendingPhase::Applying,
        };
        let rolling_marker = PendingMarker {
            phase: PendingPhase::RollingBack,
            ..applying_marker.clone()
        };
        let applying_project = with_pending_marker(&project_preimage, &applying_marker)?;
        let rolling_project = with_pending_marker(&project_preimage, &rolling_marker)?;
        if backup.phase == BackupPhase::RolledBack {
            let fully_restored = backup.targets.iter().try_fold(true, |restored, target| {
                let current =
                    file_hash_optional(&confined_target(&location, &target.relative_path)?)?;
                Ok::<bool, MemoryError>(restored && current == target.before_sha256)
            })?;
            if !fully_restored {
                return Err(MemoryError::InvalidInput(
                    "migration rollback cannot finish before every target preimage is restored"
                        .into(),
                ));
            }
            if project_text == rolling_project {
                reconcile_kodmem_temporaries(&location.project_root)?;
                super::super::validate_project_root(&location)?;
                atomic_write(&project_path, &project_preimage)?;
            } else if project_text != project_preimage {
                return Err(MemoryError::InvalidInput(
                    "completed rollback Project.md receipt changed; preserve it and resolve manually"
                    .into(),
                ));
            }
            self.remove_project_projection(&location.project_id)?;
            self.refresh_project_knowledge(workspace_id)?;
            return Ok(LegacyMigrationRollback {
                project_id: location.project_id,
                migration_id: migration_id.into(),
                restored: 0,
                removed: 0,
                source_retained: true,
            });
        }
        if backup.phase == BackupPhase::RollingBack && project_text == project_preimage {
            let fully_restored = backup.targets.iter().try_fold(true, |restored, target| {
                let current =
                    file_hash_optional(&confined_target(&location, &target.relative_path)?)?;
                Ok::<bool, MemoryError>(restored && current == target.before_sha256)
            })?;
            if !fully_restored {
                return Err(MemoryError::InvalidInput(
                    "migration rollback lost its pending receipt before every target was restored"
                        .into(),
                ));
            }
            self.remove_project_projection(&location.project_id)?;
            self.refresh_project_knowledge(workspace_id)?;
            backup.phase = BackupPhase::RolledBack;
            write_backup(&backup_path, &backup)?;
            return Ok(LegacyMigrationRollback {
                project_id: location.project_id,
                migration_id: migration_id.into(),
                restored: 0,
                removed: 0,
                source_retained: true,
            });
        }
        match backup.phase {
            BackupPhase::Prepared | BackupPhase::MarkdownWritten => {
                if project_text != project_preimage && project_text != applying_project {
                    return Err(MemoryError::InvalidInput(
                        "migration rollback cannot verify its pending Project.md receipt".into(),
                    ));
                }
            }
            BackupPhase::RollingBack => {
                if project_text != rolling_project {
                    return Err(MemoryError::InvalidInput(
                        "migration rollback Project.md receipt changed; preserve it and resolve manually"
                            .into(),
                    ));
                }
            }
            BackupPhase::Cutover | BackupPhase::Complete => {
                if !matching_receipt && project_text != rolling_project {
                    return Err(MemoryError::InvalidInput(
                        "migration rollback cannot verify its cutover or rolling-back receipt"
                            .into(),
                    ));
                }
            }
            BackupPhase::RolledBack => unreachable!(),
        }
        for target in &backup.targets {
            super::super::validate_project_root(&location)?;
            let path = confined_target(&location, &target.relative_path)?;
            reconcile_kodmem_temporaries(path.parent().ok_or_else(|| {
                MemoryError::InvalidInput("migration rollback target has no parent".into())
            })?)?;
            let current = file_hash_optional(&path)?;
            if current.as_deref() != Some(&target.after_sha256) && current != target.before_sha256 {
                return Err(MemoryError::InvalidInput(format!(
                    "migration rollback would overwrite later edits at {}; preserve the file and resolve it manually",
                    target.relative_path
                )));
            }
        }

        self.require_same_project_mapping(workspace_id, &location)?;
        super::super::validate_project_root(&location)?;
        if let Some(remaining) = cutover.as_ref() {
            if matching_receipt {
                let prior_cutover = parse_cutover_marker(&project_preimage, &location.project_id)?;
                let prior_ids = prior_cutover
                    .as_ref()
                    .into_iter()
                    .flat_map(|marker| marker.migrations.iter())
                    .map(|entry| entry.migration_id.as_str())
                    .collect::<BTreeSet<_>>();
                if remaining.migrations.iter().any(|entry| {
                    entry.migration_id != migration_id
                        && !prior_ids.contains(entry.migration_id.as_str())
                }) {
                    return Err(MemoryError::InvalidInput(
                        "a later migration depends on this cutover; roll back migrations in reverse order"
                            .into(),
                    ));
                }
                let mut expected_cutover = prior_cutover.unwrap_or_else(|| CutoverMarker {
                    schema: 1,
                    project_id: location.project_id.clone(),
                    authority: "projects-vault".into(),
                    migrations: Vec::new(),
                });
                merge_cutover(
                    &mut expected_cutover,
                    CutoverMigration {
                        migration_id: migration_id.into(),
                        manifest_sha256: expected_manifest_sha256.into(),
                        recovery_anchor_sha256: migration_anchor_sha256(&anchor_for_backup(
                            &backup,
                        ))?,
                        source_snapshots: backup.source_snapshots.clone(),
                        targets: cutover_targets(&backup.writes, migration_id)?,
                    },
                )?;
                let expected_current = with_cutover_marker(&project_preimage, &expected_cutover)?;
                if project_text != expected_current {
                    return Err(MemoryError::InvalidInput(
                        "migration rollback would overwrite later Project.md edits; preserve the file and resolve it manually"
                            .into(),
                    ));
                }
            }
        }
        let current_project = read_bounded_regular(&project_path, "Project.md")?;
        if current_project != rolling_project {
            if current_project != project_text {
                return Err(MemoryError::ContentConflict {
                    expected: sha256_bytes(project_text.as_bytes()),
                    actual: sha256_bytes(current_project.as_bytes()),
                });
            }
            reconcile_kodmem_temporaries(&location.project_root)?;
            super::super::validate_project_root(&location)?;
            atomic_write(&project_path, &rolling_project)?;
            migration_failpoint("rollback-cutover")?;
        }
        if backup.phase != BackupPhase::RollingBack {
            backup.phase = BackupPhase::RollingBack;
            write_backup(&backup_path, &backup)?;
        }

        let mut restored = 0;
        let mut removed = 0;
        for (index, target) in backup.targets.iter().rev().enumerate() {
            super::super::validate_project_root(&location)?;
            let path = confined_target(&location, &target.relative_path)?;
            reconcile_kodmem_temporaries(path.parent().ok_or_else(|| {
                MemoryError::InvalidInput("migration rollback target has no parent".into())
            })?)?;
            migration_failpoint(&format!("rollback-before-target-{}", index + 1))?;
            let current = file_hash_optional(&path)?;
            if current == target.before_sha256 {
                continue;
            }
            if current.as_deref() != Some(target.after_sha256.as_str()) {
                return Err(MemoryError::InvalidInput(format!(
                    "migration rollback observed a concurrent edit at {}; preserve the file and resolve it manually",
                    target.relative_path
                )));
            }
            match target.before_base64.as_deref() {
                Some(encoded) => {
                    let bytes = decode_backup_bytes(encoded)?;
                    let text = String::from_utf8(bytes).map_err(|_| {
                        MemoryError::InvalidInput(
                            "migration backup contains non-UTF-8 Markdown".into(),
                        )
                    })?;
                    atomic_write(&path, &text)?;
                    restored += 1;
                }
                None => {
                    if path.exists() {
                        super::super::remove_durable(&path)?;
                        removed += 1;
                    }
                }
            }
            migration_failpoint(&format!("rollback-target-{}", index + 1))?;
        }
        self.remove_project_projection(&location.project_id)?;
        self.require_same_project_mapping(workspace_id, &location)?;
        super::super::validate_project_root(&location)?;
        let current_project = read_bounded_regular(&project_path, "Project.md")?;
        if current_project != rolling_project {
            return Err(MemoryError::ContentConflict {
                expected: sha256_bytes(rolling_project.as_bytes()),
                actual: sha256_bytes(current_project.as_bytes()),
            });
        }
        backup.phase = BackupPhase::RolledBack;
        write_backup(&backup_path, &backup)?;
        migration_failpoint("rollback-finalized")?;
        reconcile_kodmem_temporaries(&location.project_root)?;
        super::super::validate_project_root(&location)?;
        atomic_write(&project_path, &project_preimage)?;
        migration_failpoint("rollback-project-restored")?;
        self.refresh_project_knowledge(workspace_id)?;
        Ok(LegacyMigrationRollback {
            project_id: location.project_id,
            migration_id: migration_id.into(),
            restored,
            removed,
            source_retained: true,
        })
    }

    pub(in crate::memory::portable) fn local_legacy_snapshot(
        &self,
        project_id: &str,
    ) -> Result<LegacySnapshot> {
        let mappings = self.project_workspace_mappings(project_id)?;
        collect_legacy_snapshot(self, &mappings)
    }

    pub(super) fn recover_completed_migration(
        &self,
        location: &ProjectLocation,
        _workspace_id: &str,
    ) -> Result<()> {
        let project_text = match read_optional_bounded_regular(
            &location.project_root.join(project_note_relative_path()?),
            "Project.md",
        )? {
            Some(text) => text,
            None => return Ok(()),
        };
        if parse_pending_marker(&project_text, &location.project_id)?.is_some() {
            return Ok(());
        }
        let Some(cutover) = parse_cutover_marker(&project_text, &location.project_id)? else {
            return Ok(());
        };
        for migration in cutover.migrations {
            let path = migration_backup_path(self, location, &migration.migration_id, false)?;
            let mut backup = match read_backup(&path) {
                Ok(backup) => backup,
                Err(MemoryError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                    continue;
                }
                Err(error) => return Err(error),
            };
            validate_backup_at(
                &path,
                &backup,
                location,
                &migration.migration_id,
                &migration.manifest_sha256,
            )?;
            if matches!(
                backup.phase,
                BackupPhase::Prepared | BackupPhase::MarkdownWritten | BackupPhase::Cutover
            ) {
                for target in &backup.targets {
                    let current =
                        file_hash_optional(&confined_target(location, &target.relative_path)?)?;
                    if current.as_deref() != Some(target.after_sha256.as_str()) {
                        return Err(MemoryError::InvalidInput(format!(
                            "completed migration target no longer matches its postimage: {}",
                            target.relative_path
                        )));
                    }
                }
                // The cutover receipt is the final vault write, so a matching
                // receipt proves projection/validation already completed.
                backup.phase = BackupPhase::Complete;
                write_backup(&path, &backup)?;
            }
        }
        Ok(())
    }

    pub(super) fn compute_legacy_migration(&self, workspace_id: &str) -> Result<ComputedPlan> {
        let location = self.project_location(workspace_id)?.ok_or_else(|| {
            MemoryError::InvalidInput("map this workspace before migrating legacy memory".into())
        })?;
        self.compute_legacy_migration_at(workspace_id, location)
    }

    pub(super) fn compute_legacy_migration_at(
        &self,
        workspace_id: &str,
        location: ProjectLocation,
    ) -> Result<ComputedPlan> {
        super::super::validate_project_root(&location)?;
        let project_note = read_bounded_regular(
            &location.project_root.join(project_note_relative_path()?),
            "Project.md",
        )
        .map_err(|_| {
            MemoryError::InvalidInput(
                "create the projects-vault scaffold before previewing legacy migration".into(),
            )
        })?;
        validate_no_likely_credential("projects-vault Project.md", &project_note)?;
        let pending = parse_pending_marker(&project_note, &location.project_id)?;
        if pending.is_none() {
            self.validate_project_knowledge_sources(&location)?;
        }
        if !super::super::super::scaffold::validate_authority_marker(
            &project_note,
            &location.project_id,
        )? {
            return Err(MemoryError::InvalidInput(
                "Project.md needs the exact projects-vault authority marker before migration"
                    .into(),
            ));
        }
        let full_snapshot = self.local_legacy_snapshot(&location.project_id)?;
        let project_note_sha256 = sha256_bytes(project_note.as_bytes());
        let mut cutover = if pending.is_none() {
            parse_cutover_marker(&project_note, &location.project_id)?
        } else {
            None
        };
        if cutover.is_some() && !migration_artifacts_authorized(&location, &project_note)? {
            return Err(MemoryError::InvalidInput(
                "completed migration artifacts are missing or no longer match their cutover provenance"
                    .into(),
            ));
        }
        let covered = cutover
            .as_ref()
            .is_some_and(|marker| receipts_cover(marker, &full_snapshot.receipts));
        if let Some((backup_path, backup)) = discover_nonterminal_backup(
            self,
            &location,
            pending.as_ref().map(|marker| marker.migration_id.as_str()),
        )? {
            validate_backup_at(
                &backup_path,
                &backup,
                &location,
                &backup.migration_id,
                &backup.manifest_sha256,
            )?;
            if let Some(pending) = pending.as_ref() {
                let phase_matches = match pending.phase {
                    PendingPhase::RollingBack => true,
                    PendingPhase::Applying => backup.phase != BackupPhase::RollingBack,
                };
                if pending.migration_id != backup.migration_id
                    || pending.manifest_sha256 != backup.manifest_sha256
                    || pending.recovery_anchor_sha256
                        != migration_anchor_sha256(&anchor_for_backup(&backup))?
                    || !phase_matches
                {
                    return Err(MemoryError::InvalidInput(
                        "Project.md pending migration does not match durable recovery".into(),
                    ));
                }
                let project_preimage = String::from_utf8(decode_backup_bytes(
                    &backup.project_note_base64,
                )?)
                .map_err(|_| {
                    MemoryError::InvalidInput(
                        "migration Project.md backup preimage is not UTF-8".into(),
                    )
                })?;
                cutover = parse_cutover_marker(&project_preimage, &location.project_id)?;
            }
            let uncovered = uncovered_snapshot(full_snapshot.clone(), cutover.as_ref());
            let receipt_matches = backup.source_snapshots == uncovered.receipts;
            let cutover_matches = cutover.as_ref().is_some_and(|marker| {
                marker.migrations.iter().any(|migration| {
                    migration.migration_id == backup.migration_id
                        && migration.manifest_sha256 == backup.manifest_sha256
                })
            });
            let pending_rolling = pending
                .as_ref()
                .is_some_and(|marker| marker.phase == PendingPhase::RollingBack);
            let can_retry = receipt_matches
                && backup.phase != BackupPhase::RollingBack
                && !pending_rolling
                && (backup.phase != BackupPhase::Cutover || cutover_matches);
            if receipt_matches && backup.phase != BackupPhase::RollingBack {
                validate_backup_source_binding(self, &location, &backup, &uncovered)?;
            }
            let mut public = backup.plan.clone();
            public.recovery = if pending_rolling && backup.phase == BackupPhase::RolledBack {
                Some(LegacyMigrationRecovery {
                    migration_id: backup.migration_id.clone(),
                    manifest_sha256: backup.manifest_sha256.clone(),
                    phase: LegacyMigrationRecoveryPhase::RollingBack,
                    can_retry: false,
                    can_rollback: true,
                })
            } else {
                backup_recovery(&backup).map(|mut recovery| {
                    if pending_rolling {
                        recovery.phase = LegacyMigrationRecoveryPhase::RollingBack;
                    }
                    recovery.can_retry = can_retry;
                    recovery
                })
            };
            if !can_retry {
                public.status = LegacyMigrationStatus::Blocked;
                public.can_apply = false;
            }
            return Ok(ComputedPlan {
                public,
                location,
                writes: backup.writes.clone(),
                snapshot: uncovered,
                project_note_sha256: backup.project_note_sha256.clone(),
                recovery_backup: Some(backup),
            });
        }
        if pending.is_some() {
            return Err(MemoryError::InvalidInput(
                "Project.md reports an incomplete migration but this machine has no matching durable recovery backup"
                    .into(),
            ));
        }
        if full_snapshot.receipts.is_empty() {
            return Ok(empty_plan(
                workspace_id,
                location,
                full_snapshot,
                LegacyMigrationStatus::NoLegacy,
                project_note_sha256,
            ));
        }
        if covered {
            let mut complete = empty_plan(
                workspace_id,
                location,
                full_snapshot,
                LegacyMigrationStatus::Complete,
                project_note_sha256,
            );
            if let Some(cutover) = cutover.as_ref() {
                let mut rollback_leaf = None;
                for migration in &cutover.migrations {
                    let path = migration_backup_path(
                        self,
                        &complete.location,
                        &migration.migration_id,
                        false,
                    )?;
                    let backup = match read_backup(&path) {
                        Ok(backup) => backup,
                        Err(MemoryError::Io(error))
                            if error.kind() == std::io::ErrorKind::NotFound =>
                        {
                            continue
                        }
                        Err(error) => return Err(error),
                    };
                    validate_backup_at(
                        &path,
                        &backup,
                        &complete.location,
                        &migration.migration_id,
                        &migration.manifest_sha256,
                    )?;
                    if backup.phase != BackupPhase::Complete {
                        continue;
                    }
                    let project_preimage =
                        String::from_utf8(decode_backup_bytes(&backup.project_note_base64)?)
                            .map_err(|_| {
                                MemoryError::InvalidInput(
                                    "migration Project.md backup preimage is not UTF-8".into(),
                                )
                            })?;
                    let mut expected =
                        parse_cutover_marker(&project_preimage, &complete.location.project_id)?
                            .unwrap_or_else(|| CutoverMarker {
                                schema: 1,
                                project_id: complete.location.project_id.clone(),
                                authority: "projects-vault".into(),
                                migrations: Vec::new(),
                            });
                    merge_cutover(
                        &mut expected,
                        CutoverMigration {
                            migration_id: migration.migration_id.clone(),
                            manifest_sha256: migration.manifest_sha256.clone(),
                            recovery_anchor_sha256: migration_anchor_sha256(&anchor_for_backup(
                                &backup,
                            ))?,
                            source_snapshots: backup.source_snapshots.clone(),
                            targets: cutover_targets(&backup.writes, &migration.migration_id)?,
                        },
                    )?;
                    if with_cutover_marker(&project_preimage, &expected)? == project_note {
                        if rollback_leaf.is_some() {
                            return Err(MemoryError::InvalidInput(
                                "multiple migration backups claim the rollback leaf".into(),
                            ));
                        }
                        rollback_leaf = backup_recovery(&backup);
                    }
                }
                complete.public.recovery = rollback_leaf;
            }
            return Ok(complete);
        }

        // Existing cutover receipts authorize only the exact source components
        // they name. Incremental migration plans the uncovered components; it
        // must not re-render already imported notes under a new migration ID.
        let snapshot = uncovered_snapshot(full_snapshot, cutover.as_ref());

        let seed = serde_json::to_vec(&(
            1_u8,
            &location.project_id,
            canonical_project_snapshot_sha256(&location)?,
            &snapshot.receipts,
        ))?;
        let migration_id = format!("kmig_{}", &sha256_bytes(&seed)[..32]);
        let mut counts = LegacyMigrationCounts {
            source_files: portable_snapshot_file_count(&snapshot.files) as u32,
            memories: snapshot
                .databases
                .iter()
                .map(|db| db.memories.len() as u32)
                .sum(),
            checkpoints: snapshot
                .databases
                .iter()
                .map(|db| db.checkpoints.len() as u32)
                .sum(),
            ..LegacyMigrationCounts::default()
        };
        let latest_state_checkpoint_id =
            latest_state_checkpoint_logical_id(&snapshot.databases, &location.project_id)?;
        let has_repo_state = snapshot.files.iter().any(|file| file.kind == "state");
        let mut writes = plan_file_writes(
            &location,
            &snapshot.files,
            &migration_id,
            latest_state_checkpoint_id.as_deref(),
            &mut counts,
        )?;
        writes.extend(plan_database_writes(
            &location,
            &snapshot.databases,
            &migration_id,
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
        let planned_cutover_targets = cutover_targets(&writes, &migration_id)?;
        let manifest_bytes = serde_json::to_vec(&(
            1_u8,
            &location.project_id,
            &migration_id,
            &snapshot.receipts,
            writes.iter().map(|write| &write.public).collect::<Vec<_>>(),
            &planned_cutover_targets,
        ))?;
        let manifest_sha256 = sha256_bytes(&manifest_bytes);
        let fingerprint = sha256_bytes(&serde_json::to_vec(&(
            &manifest_sha256,
            sha256_bytes(project_note.as_bytes()),
            &counts,
        ))?);
        let recovery_anchor_sha256 = migration_anchor_sha256(&MigrationAnchor {
            schema: 1,
            project_id: location.project_id.clone(),
            migration_id: migration_id.clone(),
            manifest_sha256: manifest_sha256.clone(),
            preview_fingerprint: fingerprint.clone(),
            project_note_sha256: project_note_sha256.clone(),
            source_snapshots: snapshot.receipts.clone(),
        })?;
        let mut prospective_cutover = cutover.unwrap_or_else(|| CutoverMarker {
            schema: 1,
            project_id: location.project_id.clone(),
            authority: "projects-vault".into(),
            migrations: Vec::new(),
        });
        merge_cutover(
            &mut prospective_cutover,
            CutoverMigration {
                migration_id: migration_id.clone(),
                manifest_sha256: manifest_sha256.clone(),
                recovery_anchor_sha256,
                source_snapshots: snapshot.receipts.clone(),
                targets: planned_cutover_targets,
            },
        )?;
        let prospective_project = with_cutover_marker(&project_note, &prospective_cutover)?;
        validate_planned_canonical_budget(&location, &writes, &prospective_project)?;
        let operations = writes.iter().map(|write| write.public.clone()).collect();
        let can_apply = counts.conflicts == 0;
        Ok(ComputedPlan {
            public: LegacyMigrationPlan {
                schema: 1,
                status: if can_apply {
                    LegacyMigrationStatus::Ready
                } else {
                    LegacyMigrationStatus::Blocked
                },
                workspace_id: workspace_id.into(),
                project_id: location.project_id.clone(),
                project_display_name: location.project_display_name.clone(),
                fingerprint,
                migration_id: Some(migration_id),
                manifest_sha256: Some(manifest_sha256),
                sources: snapshot.sources.clone(),
                source_snapshots: snapshot.receipts.clone(),
                counts,
                operations,
                system_operations: vec![
                    LegacyMigrationSystemOperation {
                        sequence: 1,
                        kind: "createRecoveryBackup".into(),
                        target: "Ködade app data recovery journal".into(),
                        local_only: true,
                    },
                    LegacyMigrationSystemOperation {
                        sequence: 2,
                        kind: "writePendingAuthority".into(),
                        target: "Project.md migration-pending marker".into(),
                        local_only: false,
                    },
                    LegacyMigrationSystemOperation {
                        sequence: 3,
                        kind: "rebuildDerivedIndex".into(),
                        target: "Local KödMem derived index".into(),
                        local_only: true,
                    },
                    LegacyMigrationSystemOperation {
                        sequence: 4,
                        kind: "writeCutoverLast".into(),
                        target: "Project.md cutover receipt".into(),
                        local_only: false,
                    },
                ],
                can_apply,
                source_retained: true,
                creates_local_recovery_backup: true,
                writes_cutover_last: true,
                recovery: None,
            },
            location,
            writes,
            snapshot,
            project_note_sha256: sha256_bytes(project_note.as_bytes()),
            recovery_backup: None,
        })
    }

    pub(super) fn require_migration_write_access(&self) -> Result<()> {
        if matches!(self.access, StoreAccess::ReadOnly) {
            return Err(MemoryError::InvalidInput(
                "read-only KödMem cannot migrate legacy memory".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn require_same_project_mapping(
        &self,
        workspace_id: &str,
        expected: &ProjectLocation,
    ) -> Result<()> {
        let current = self.project_location(workspace_id)?.ok_or_else(|| {
            MemoryError::InvalidInput(
                "workspace project mapping disappeared while migration waited for its lock".into(),
            )
        })?;
        if current.project_id != expected.project_id
            || current.vault_root != expected.vault_root
            || current.project_root != expected.project_root
        {
            return Err(MemoryError::InvalidInput(
                "workspace project mapping changed while migration waited for its lock; refresh the preview"
                    .into(),
            ));
        }
        Ok(())
    }

    pub(super) fn prepare_backup(
        &self,
        plan: &ComputedPlan,
        migration_id: &str,
        manifest_sha256: &str,
    ) -> Result<BackupManifest> {
        let engine = base64::engine::general_purpose::STANDARD;
        let source_files: Vec<BackupSource> = plan
            .snapshot
            .files
            .iter()
            .map(|source| BackupSource {
                workspace_id: source.workspace_id.clone(),
                relative_path: source.relative_path.clone(),
                sha256: source.sha256.clone(),
                bytes_base64: engine.encode(source.text.as_bytes()),
            })
            .collect();
        let mut exports = Vec::new();
        let mut backup_bytes = source_files
            .iter()
            .map(|source: &BackupSource| source.bytes_base64.len())
            .sum::<usize>();
        for database in &plan.snapshot.databases {
            let json = serde_json::to_string_pretty(&serde_json::json!({
                "schema": 1,
                "workspaceId": database.workspace_id,
                "memories": database.memories,
                "checkpoints": database.checkpoints,
            }))?;
            let markdown = render_legacy_database_export(database);
            validate_no_likely_credential("migration JSON export", &json)?;
            validate_no_likely_credential("migration Markdown export", &markdown)?;
            backup_bytes = backup_bytes
                .saturating_add(json.len())
                .saturating_add(markdown.len());
            if backup_bytes > migration_policy()?.max_backup_bytes.saturating_mul(3) / 4 {
                return Err(MemoryError::InvalidInput(
                    "legacy migration backup exceeds the bounded export limit".into(),
                ));
            }
            exports.push(BackupExport {
                workspace_id: database.workspace_id.clone(),
                json,
                markdown,
            });
        }
        let mut targets = Vec::new();
        for write in &plan.writes {
            if write.public.action == LegacyMigrationAction::SkipDuplicate {
                continue;
            }
            let path = confined_target(&plan.location, &write.public.target_relative_path)?;
            let before = read_optional_bounded_bytes(&path, "migration target preimage")?;
            if let Some(before) = before.as_deref() {
                let text = std::str::from_utf8(before).map_err(|_| {
                    MemoryError::InvalidInput(
                        "migration target preimage must be UTF-8 Markdown".into(),
                    )
                })?;
                validate_no_likely_credential("migration target preimage", text)?;
            }
            let contents = write
                .contents
                .as_deref()
                .expect("non-skip writes have content");
            targets.push(BackupTarget {
                relative_path: write.public.target_relative_path.clone(),
                before_sha256: before.as_deref().map(sha256_bytes),
                before_base64: before.as_deref().map(|bytes| engine.encode(bytes)),
                after_sha256: sha256_bytes(contents.as_bytes()),
            });
        }
        let mut backup = BackupManifest {
            schema: 1,
            project_id: plan.location.project_id.clone(),
            migration_id: migration_id.into(),
            manifest_sha256: manifest_sha256.into(),
            preview_fingerprint: plan.public.fingerprint.clone(),
            project_note_sha256: plan.project_note_sha256.clone(),
            project_note_base64: engine.encode(read_bounded_regular(
                &plan
                    .location
                    .project_root
                    .join(project_note_relative_path()?),
                "Project.md backup preimage",
            )?),
            integrity_sha256: String::new(),
            phase: BackupPhase::Prepared,
            plan: plan.public.clone(),
            writes: plan.writes.clone(),
            source_snapshots: plan.snapshot.receipts.clone(),
            source_files,
            exports,
            targets,
        };
        backup.integrity_sha256 = backup_integrity_sha256(&backup)?;
        Ok(backup)
    }

    pub(super) fn remove_project_projection(&self, project_id: &str) -> Result<()> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection.execute(
                "DELETE FROM memories WHERE canonical_project_id = ?1",
                [project_id],
            )?;
            connection.execute(
                "DELETE FROM checkpoints WHERE canonical_project_id = ?1",
                [project_id],
            )?;
            Ok(())
        })
    }
}
