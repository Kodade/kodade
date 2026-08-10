use super::*;

pub(super) fn migration_policy() -> Result<&'static MigrationPolicy> {
    static POLICY: OnceLock<std::result::Result<MigrationPolicy, String>> = OnceLock::new();
    let portable = super::super::portable_policy()?;
    match POLICY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../resources/kodmem/legacy-migration.json"
        ))
        .map_err(|error| format!("invalid embedded legacy migration policy: {error}"))
    }) {
        Ok(policy)
            if policy.schema == 1
                && policy.max_source_files > 0
                && policy.max_target_scan_files >= policy.max_source_files
                && policy.max_source_workspaces > 0
                && policy.max_source_receipts > 0
                && policy.max_source_bytes > 0
                && policy.max_database_records > 0
                && policy.max_database_links > 0
                && policy.max_database_bytes > 0
                && policy.max_canonical_files > 0
                && policy.max_canonical_bytes > 0
                && policy.max_backup_bytes > 0
                && policy.max_cutover_bytes > 0
                && validate_repo_policy(policy)
                && policy.max_document_bytes == portable.max_document_bytes
                && policy.max_canonical_files == portable.max_scan_files
                && policy.max_canonical_bytes == portable.max_project_bytes =>
        {
            Ok(policy)
        }
        Ok(_) => Err(MemoryError::InvalidInput(
            "embedded legacy migration policy is invalid or diverges from portable authority"
                .into(),
        )),
        Err(error) => Err(MemoryError::InvalidInput(error.clone())),
    }
}

pub(super) fn repo_source_for_kind(kind: &str) -> Result<&'static RepoSourcePolicy> {
    migration_policy()?
        .repo_sources
        .iter()
        .find(|source| source.kind == kind)
        .ok_or_else(|| {
            MemoryError::InvalidInput("legacy migration source kind is unsupported".into())
        })
}

pub(super) fn repo_source_for_identity(identity: &str) -> Result<&'static RepoSourcePolicy> {
    let relative = identity.strip_prefix(".kodade/memory/").ok_or_else(|| {
        MemoryError::InvalidInput("legacy migration source identity is invalid".into())
    })?;
    migration_policy()?
        .repo_sources
        .iter()
        .find(|source| {
            source.exact_paths.iter().any(|path| path == relative)
                || source.root_prefix.as_ref().is_some_and(|prefix| {
                    !relative.contains('/')
                        && relative.starts_with(prefix)
                        && source
                            .root_suffix
                            .as_ref()
                            .is_none_or(|suffix| relative.ends_with(suffix))
                })
                || source
                    .recursive_directory
                    .as_ref()
                    .is_some_and(|directory| {
                        relative.starts_with(&format!("{directory}/"))
                            && source.recursive_extension.as_ref().is_none_or(|extension| {
                                relative.ends_with(&format!(".{extension}"))
                            })
                    })
        })
        .ok_or_else(|| {
            MemoryError::InvalidInput("legacy migration source identity is unsupported".into())
        })
}

pub(super) fn render_repo_target(policy: &RepoSourcePolicy, source: &LegacyFile) -> Result<String> {
    render_repo_pattern(&policy.target_pattern, source)
}

pub(super) fn render_repo_history_target(
    policy: &RepoSourcePolicy,
    source: &LegacyFile,
) -> Result<Option<String>> {
    policy
        .history_pattern
        .as_deref()
        .map(|pattern| render_repo_pattern(pattern, source))
        .transpose()
}

pub(super) fn repo_target_matches_operation(operation: &LegacyMigrationOperation) -> bool {
    let kind = if operation.source_kind == "state-history" {
        "state"
    } else {
        operation.source_kind.as_str()
    };
    let Ok(policy) = repo_source_for_kind(kind) else {
        return false;
    };
    if let Some(identity) = operation.source_relative_path.as_deref() {
        let Ok(identity_policy) = repo_source_for_identity(identity) else {
            return false;
        };
        if identity_policy.kind != kind {
            return false;
        }
        let file = LegacyFile {
            workspace_id: String::new(),
            relative_path: identity.into(),
            kind: kind.into(),
            text: String::new(),
            sha256: operation.source_sha256.clone(),
            snapshot_sha256: String::new(),
            modified_at: 0,
        };
        let expected = if operation.source_kind == "state-history" {
            render_repo_history_target(policy, &file).ok().flatten()
        } else {
            render_repo_target(policy, &file).ok()
        };
        return expected.as_deref() == Some(operation.target_relative_path.as_str())
            && (kind != "state"
                || operation.source_kind == "state-history"
                || operation.action == LegacyMigrationAction::ReplacePlaceholder);
    }
    false
}

pub(super) fn repo_target_shape_matches(source_kind: &str, target: &str) -> bool {
    let kind = if source_kind == "state-history" {
        "state"
    } else {
        source_kind
    };
    let Ok(policy) = repo_source_for_kind(kind) else {
        return false;
    };
    let pattern = if source_kind == "state-history" {
        let Some(pattern) = policy.history_pattern.as_deref() else {
            return false;
        };
        pattern
    } else {
        policy.target_pattern.as_str()
    };
    migration_pattern_matches(pattern, target)
}

fn migration_pattern_matches(pattern: &str, target: &str) -> bool {
    if !pattern.contains("{{") {
        return pattern == target;
    }
    let Some((prefix, remainder)) = pattern.split_once("{{sha12}}") else {
        return false;
    };
    let Some(after_prefix) = target.strip_prefix(prefix) else {
        return false;
    };
    let Some(hash) = after_prefix.get(..12) else {
        return false;
    };
    if !hash
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return false;
    }
    let after_hash = &after_prefix[12..];
    if let Some((middle, suffix)) = remainder.split_once("{{basename}}") {
        let Some(value) = after_hash.strip_prefix(middle) else {
            return false;
        };
        let Some(basename) = value.strip_suffix(suffix) else {
            return false;
        };
        !basename.is_empty() && !basename.contains('/') && basename != "." && basename != ".."
    } else {
        after_hash == remainder
    }
}

/// Collect the canonical project Markdown described by the shared scaffold.
/// Migration callers supply their own bound but do not redeclare product lanes.
pub(super) fn scaffold_markdown_paths(
    location: &ProjectLocation,
    max_files: usize,
) -> Result<Vec<PathBuf>> {
    let (files, directories) = super::super::super::scaffold::project_scaffold_paths()?;
    let mut paths = files
        .into_iter()
        .map(|relative| location.project_root.join(relative))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    for directory in directories {
        super::super::collect_markdown_recursive(
            &location.project_root.join(directory),
            &mut paths,
            0,
            max_files,
        )?;
    }
    paths.sort();
    paths.dedup();
    if paths.len() > max_files {
        return Err(MemoryError::InvalidInput(
            "mapped project exceeds the canonical Markdown scan limit".into(),
        ));
    }
    Ok(paths)
}

pub(super) fn project_note_relative_path() -> Result<String> {
    super::super::super::scaffold::project_note_relative_path()
}

fn render_repo_pattern(pattern: &str, source: &LegacyFile) -> Result<String> {
    let basename = Path::new(&source.relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_filename)
        .ok_or_else(|| MemoryError::InvalidInput("legacy source basename is invalid".into()))?;
    let rendered = pattern
        .replace("{{sha12}}", &source.sha256[..12])
        .replace("{{basename}}", &basename);
    if rendered.is_empty()
        || Path::new(&rendered).is_absolute()
        || rendered
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(MemoryError::InvalidInput(
            "embedded legacy migration target pattern is unsafe".into(),
        ));
    }
    Ok(rendered)
}

fn validate_repo_policy(policy: &MigrationPolicy) -> bool {
    let kinds = policy
        .repo_sources
        .iter()
        .map(|source| source.kind.as_str())
        .collect::<BTreeSet<_>>();
    kinds == BTreeSet::from(["decisions", "imported-records", "plan", "state", "worklog"])
        && policy
            .repo_note_template
            .iter()
            .any(|line| line.contains("{{migration_marker}}"))
        && policy
            .repo_note_template
            .iter()
            .any(|line| line.contains("{{source_text}}"))
        && policy.repo_sources.iter().all(|source| {
            !source.target_pattern.is_empty()
                && !source.note_type.is_empty()
                && !source.status.is_empty()
                && (source.kind == "state") == source.history_pattern.is_some()
        })
}
