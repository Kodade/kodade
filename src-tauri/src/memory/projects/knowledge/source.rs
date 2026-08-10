use std::fs::File;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use super::super::super::{validate_no_likely_credential, MemoryError, Result};
use super::super::{validate_projects_vault_root, ProjectLocation};
use super::{
    IndexedProjectDocument, ProjectKnowledgeContext, ProjectKnowledgeKind, ProjectKnowledgeSource,
    ProjectKnowledgeSync, ProjectKnowledgeSyncStatus,
};

const PROJECT_FILE: &str = "Project.md";
const STATE_FILE: &str = "STATE.md";
const INDEXED_WORKLOG_DAYS: usize = 14;
const CONTEXT_WORKLOG_DAYS: usize = 3;
const CONTEXT_DECISIONS: usize = 5;
const CONTEXT_KNOWLEDGE: usize = 5;
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024;
const MAX_PROJECT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SCAN_FILES: usize = 512;
const MAX_CONTEXT_SOURCE_CHARS: usize = 4_000;
const MAX_CONTEXT_CHARS: usize = 24_000;
const MAX_CONTEXT_TITLE_CHARS: usize = 200;
// KödMCP runs without the frontend, so its mapped Markdown projection owns a
// native serialized-size ceiling that includes metadata and JSON escaping.
const MAX_CONTEXT_JSON_BYTES: usize = 32 * 1024;

pub(super) fn collect_project_documents(
    location: &ProjectLocation,
) -> Result<Vec<IndexedProjectDocument>> {
    validate_projects_vault_root(&location.vault_root)?;
    require_confined_directory(
        &location.vault_root,
        &location.project_root,
        "mapped project",
    )?;
    let mut documents = vec![
        read_project_document(location, PROJECT_FILE, ProjectKnowledgeKind::Project)?,
        read_project_document(location, STATE_FILE, ProjectKnowledgeKind::State)?,
    ];

    let mut worklogs = collect_markdown_paths(
        &location.project_root,
        &location.project_root.join("Worklog"),
        true,
    )?;
    worklogs.retain(|(_, relative_path)| is_daily_worklog_path(relative_path));
    worklogs.sort_by(|left, right| right.1.cmp(&left.1));
    worklogs.truncate(INDEXED_WORKLOG_DAYS);
    for (path, relative_path) in worklogs {
        documents.push(read_document(
            location,
            &path,
            relative_path,
            ProjectKnowledgeKind::Worklog,
        )?);
    }

    let mut decisions = collect_markdown_paths(
        &location.project_root,
        &location.project_root.join("Decisions"),
        false,
    )?;
    decisions.sort_by(|left, right| left.1.cmp(&right.1));
    for (path, relative_path) in decisions {
        let document = read_document(
            location,
            &path,
            relative_path,
            ProjectKnowledgeKind::Decision,
        )?;
        if frontmatter_value(&document.body, "status").as_deref() == Some("accepted")
            || frontmatter_bool(&document.body, "agent_context")
        {
            documents.push(document);
        }
    }

    let mut knowledge = collect_markdown_paths(
        &location.project_root,
        &location.project_root.join("Knowledge"),
        false,
    )?;
    knowledge.sort_by(|left, right| left.1.cmp(&right.1));
    for (path, relative_path) in knowledge {
        let document = read_document(
            location,
            &path,
            relative_path,
            ProjectKnowledgeKind::Knowledge,
        )?;
        if frontmatter_value(&document.body, "status").as_deref() == Some("approved") {
            documents.push(document);
        }
    }

    if documents.len() > MAX_SCAN_FILES {
        return Err(MemoryError::InvalidInput(format!(
            "mapped project contains more than {MAX_SCAN_FILES} indexable Markdown files"
        )));
    }
    let bytes = documents
        .iter()
        .map(|document| document.body.len())
        .sum::<usize>();
    if bytes > MAX_PROJECT_BYTES {
        return Err(MemoryError::InvalidInput(format!(
            "mapped project knowledge exceeds the {} MiB index limit",
            MAX_PROJECT_BYTES / (1024 * 1024)
        )));
    }
    Ok(documents)
}

fn is_daily_worklog_path(relative_path: &str) -> bool {
    let Some(path) = relative_path.strip_prefix("Worklog/") else {
        return false;
    };
    let mut parts = path.split('/');
    let (Some(year), Some(file), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let Some(date) = file.strip_suffix(".md") else {
        return false;
    };
    let date_bytes = date.as_bytes();
    year.len() == 4
        && year.bytes().all(|byte| byte.is_ascii_digit())
        && date_bytes.len() == 10
        && &date_bytes[..4] == year.as_bytes()
        && date_bytes[4] == b'-'
        && date_bytes[7] == b'-'
        && date
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn read_project_document(
    location: &ProjectLocation,
    relative_path: &str,
    kind: ProjectKnowledgeKind,
) -> Result<IndexedProjectDocument> {
    read_document(
        location,
        &location.project_root.join(relative_path),
        relative_path.into(),
        kind,
    )
}

fn read_document(
    location: &ProjectLocation,
    path: &Path,
    relative_path: String,
    kind: ProjectKnowledgeKind,
) -> Result<IndexedProjectDocument> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        MemoryError::InvalidInput(format!(
            "mapped project note is unavailable at {relative_path}: {error}"
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::InvalidInput(format!(
            "mapped project note must be a regular file, not a symlink: {relative_path}"
        )));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(MemoryError::InvalidInput(format!(
            "mapped project note exceeds the {} KiB limit: {relative_path}",
            MAX_DOCUMENT_BYTES / 1024
        )));
    }
    let canonical = std::fs::canonicalize(path)?;
    let canonical_root = std::fs::canonicalize(&location.project_root)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(MemoryError::InvalidInput(format!(
            "mapped project note escapes its project folder: {relative_path}"
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(&canonical)?
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(MemoryError::InvalidInput(format!(
            "mapped project note changed beyond the {} KiB limit while reading: {relative_path}",
            MAX_DOCUMENT_BYTES / 1024
        )));
    }
    let body = String::from_utf8(bytes.clone()).map_err(|_| {
        MemoryError::InvalidInput(format!(
            "mapped project note is not valid UTF-8: {relative_path}"
        ))
    })?;
    validate_no_likely_credential("mapped project note", &body).map_err(|_| {
        MemoryError::InvalidInput(format!(
            "mapped project note contains likely credentials and cannot enter agent context: {relative_path}"
        ))
    })?;
    let title = frontmatter_value(&body, "title")
        .or_else(|| heading_title(&body))
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Project knowledge")
                .to_string()
        });
    let title = bounded_chars(&title, MAX_CONTEXT_TITLE_CHARS).0;
    let modified_at = std::fs::metadata(&canonical)?
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let path_hash = format!("{:x}", Sha256::digest(relative_path.as_bytes()));
    Ok(IndexedProjectDocument {
        id: format!("project:{}:{}", location.project_id, &path_hash[..24]),
        project_id: location.project_id.clone(),
        relative_path,
        kind,
        title,
        body,
        sha256,
        modified_at,
    })
}

fn collect_markdown_paths(
    project_root: &Path,
    directory: &Path,
    nested: bool,
) -> Result<Vec<(PathBuf, String)>> {
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MemoryError::InvalidInput(format!(
            "mapped project knowledge directory must be a regular directory: {}",
            directory.display()
        )));
    }
    let mut paths = Vec::new();
    collect_markdown_level(project_root, directory, nested, &mut paths)?;
    if paths.len() > MAX_SCAN_FILES {
        return Err(MemoryError::InvalidInput(format!(
            "mapped project knowledge directory contains more than {MAX_SCAN_FILES} entries: {}",
            directory.display()
        )));
    }
    Ok(paths)
}

fn collect_markdown_level(
    project_root: &Path,
    directory: &Path,
    allow_directories: bool,
    paths: &mut Vec<(PathBuf, String)>,
) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(MemoryError::InvalidInput(format!(
                "mapped project knowledge cannot contain symlinks: {}",
                path.display()
            )));
        }
        if file_type.is_dir() && allow_directories {
            collect_markdown_level(project_root, &path, false, paths)?;
            continue;
        }
        if !file_type.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let relative_path = path
            .strip_prefix(project_root)
            .map_err(|_| {
                MemoryError::InvalidInput("mapped project note escaped its folder".into())
            })?
            .to_string_lossy()
            .replace('\\', "/");
        paths.push((path, relative_path));
    }
    Ok(())
}

fn require_confined_directory(vault_root: &Path, path: &Path, label: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        MemoryError::InvalidInput(format!("{label} folder is unavailable: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MemoryError::InvalidInput(format!(
            "{label} folder must be a regular directory, not a symlink"
        )));
    }
    let canonical_vault = std::fs::canonicalize(vault_root)?;
    let canonical_path = std::fs::canonicalize(path)?;
    if !canonical_path.starts_with(canonical_vault.join("10-Projects")) {
        return Err(MemoryError::InvalidInput(format!(
            "{label} folder escapes the registered projects vault"
        )));
    }
    Ok(())
}

fn frontmatter_value(body: &str, key: &str) -> Option<String> {
    let mut lines = body.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines.take(100) {
        if line.trim() == "---" {
            break;
        }
        let Some((candidate, value)) = line.split_once(':') else {
            continue;
        };
        if candidate.trim() == key {
            return Some(
                value
                    .trim()
                    .trim_matches(|ch| ch == '\'' || ch == '"')
                    .to_string(),
            );
        }
    }
    None
}

fn frontmatter_bool(body: &str, key: &str) -> bool {
    frontmatter_value(body, key)
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "true" | "yes"))
}

fn heading_title(body: &str) -> Option<String> {
    body.lines()
        .find_map(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
}

pub(super) fn project_context(
    location: &ProjectLocation,
    documents: &[IndexedProjectDocument],
    refreshed_at: i64,
) -> ProjectKnowledgeContext {
    let selected = documents
        .iter()
        .filter(|document| match document.kind {
            ProjectKnowledgeKind::Project | ProjectKnowledgeKind::State => true,
            ProjectKnowledgeKind::Worklog => documents
                .iter()
                .filter(|candidate| candidate.kind == ProjectKnowledgeKind::Worklog)
                .take(CONTEXT_WORKLOG_DAYS)
                .any(|candidate| candidate.id == document.id),
            ProjectKnowledgeKind::Decision => documents
                .iter()
                .filter(|candidate| candidate.kind == ProjectKnowledgeKind::Decision)
                .take(CONTEXT_DECISIONS)
                .any(|candidate| candidate.id == document.id),
            ProjectKnowledgeKind::Knowledge => documents
                .iter()
                .filter(|candidate| candidate.kind == ProjectKnowledgeKind::Knowledge)
                .take(CONTEXT_KNOWLEDGE)
                .any(|candidate| candidate.id == document.id),
        })
        .collect::<Vec<_>>();
    let mut index_hasher = Sha256::new();
    for document in documents {
        index_hasher.update(document.relative_path.as_bytes());
        index_hasher.update([0]);
        index_hasher.update(document.sha256.as_bytes());
        index_hasher.update([0]);
    }
    let (project_display_name, display_name_truncated) =
        bounded_chars(&location.project_display_name, MAX_CONTEXT_TITLE_CHARS);
    let mut context = ProjectKnowledgeContext {
        project_id: location.project_id.clone(),
        project_display_name,
        origin: location.project_root.to_string_lossy().into_owned(),
        sync: ProjectKnowledgeSync {
            status: ProjectKnowledgeSyncStatus::Current,
            refreshed_at,
            indexed_documents: documents.len() as u32,
            index_hash: Some(format!("{:x}", index_hasher.finalize())),
            truncated: selected.len() < documents.len() || display_name_truncated,
            error: None,
        },
        sources: Vec::new(),
    };
    let mut remaining = MAX_CONTEXT_CHARS;
    for document in selected {
        if remaining == 0 {
            context.sync.truncated = true;
            break;
        }
        let max_content_chars = remaining.min(MAX_CONTEXT_SOURCE_CHARS);
        let (title, title_truncated) = bounded_chars(&document.title, MAX_CONTEXT_TITLE_CHARS);
        let source = ProjectKnowledgeSource {
            kind: document.kind,
            relative_path: document.relative_path.clone(),
            title,
            content: String::new(),
            sha256: document.sha256.clone(),
            modified_at: document.modified_at,
            truncated: title_truncated,
        };
        let Some((source, serialized_truncated)) =
            fit_source_to_context_budget(&context, source, &document.body, max_content_chars)
        else {
            context.sync.truncated = true;
            break;
        };
        remaining = remaining.saturating_sub(source.content.chars().count());
        context.sync.truncated |= source.truncated;
        context.sources.push(source);
        if serialized_truncated {
            context.sync.truncated = true;
            break;
        }
    }
    debug_assert!(serialized_context_bytes(&context) <= MAX_CONTEXT_JSON_BYTES);
    context
}

fn fit_source_to_context_budget(
    context: &ProjectKnowledgeContext,
    source: ProjectKnowledgeSource,
    body: &str,
    max_content_chars: usize,
) -> Option<(ProjectKnowledgeSource, bool)> {
    let mut candidate = source.clone();
    let (content, body_truncated) = bounded_chars(body, max_content_chars);
    candidate.content = content;
    candidate.truncated |= body_truncated;
    if serialized_context_with_source_bytes(context, &candidate) <= MAX_CONTEXT_JSON_BYTES {
        return Some((candidate, false));
    }

    let mut low = 0_usize;
    let mut high = max_content_chars;
    let mut best = None;
    while low <= high {
        let midpoint = low + (high - low) / 2;
        let mut bounded = source.clone();
        bounded.content = bounded_chars(body, midpoint).0;
        bounded.truncated = true;
        if serialized_context_with_source_bytes(context, &bounded) <= MAX_CONTEXT_JSON_BYTES {
            best = Some(bounded);
            low = midpoint.saturating_add(1);
        } else if midpoint == 0 {
            break;
        } else {
            high = midpoint - 1;
        }
    }
    best.map(|bounded| (bounded, true))
}

fn serialized_context_with_source_bytes(
    context: &ProjectKnowledgeContext,
    source: &ProjectKnowledgeSource,
) -> usize {
    let mut candidate = context.clone();
    candidate.sources.push(source.clone());
    serialized_context_bytes(&candidate)
}

fn serialized_context_bytes(context: &ProjectKnowledgeContext) -> usize {
    serde_json::to_vec(context)
        .map(|serialized| serialized.len())
        .unwrap_or(usize::MAX)
}

pub(super) fn bounded_chars(value: &str, limit: usize) -> (String, bool) {
    if value.chars().count() <= limit {
        return (value.to_string(), false);
    }
    if limit == 0 {
        return (String::new(), true);
    }
    let mut bounded = value
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    bounded.push('…');
    (bounded, true)
}
