use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{MemoryError, MemoryStore, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScaffoldOperationKind {
    CreateDirectory,
    CreateFile,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldOperation {
    pub kind: ScaffoldOperationKind,
    pub relative_path: String,
    pub content: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldPlan {
    pub workspace_id: String,
    pub project_id: String,
    pub project_display_name: String,
    pub vault_root: String,
    pub fingerprint: String,
    pub operations: Vec<ScaffoldOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldApply {
    pub project_id: String,
    pub created: Vec<ScaffoldOperation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanFingerprint<'a> {
    schema: u8,
    workspace_id: &'a str,
    project_id: &'a str,
    project_display_name: &'a str,
    vault_root: &'a str,
    observations: &'a [PathObservation],
    operations: &'a [ScaffoldOperation],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathObservation {
    relative_path: String,
    state: String,
}

struct RequiredArtifact {
    suffix: String,
    kind: ScaffoldOperationKind,
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScaffoldPolicy {
    schema: u8,
    artifacts: Vec<ArtifactPolicy>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ArtifactPolicy {
    Directory { path: String },
    File { path: String, lines: Vec<String> },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectAuthorityMarker {
    schema: u8,
    project_id: String,
    authority: String,
}

impl MemoryStore {
    pub fn preview_project_scaffold(&self, workspace_id: &str) -> Result<ProjectScaffoldPlan> {
        let mapping = self
            .workspace_project_mapping(workspace_id)?
            .ok_or_else(|| {
                MemoryError::InvalidInput(
                    "map this workspace to a logical project before setting up project knowledge"
                        .into(),
                )
            })?;
        validate_project_display_name(&mapping.project_display_name)?;
        let vault = self.projects_vault()?.ok_or_else(|| {
            MemoryError::InvalidInput(
                "register an Obsidian projects vault before setting up project knowledge".into(),
            )
        })?;
        let project_relative = format!("10-Projects/{}", mapping.project_id);
        let project_root = Path::new(&vault.canonical_root)
            .join("10-Projects")
            .join(&mapping.project_id);
        let mut required = required_artifacts(&mapping.project_id, &mapping.project_display_name)?;
        required.insert(
            0,
            RequiredArtifact {
                suffix: String::new(),
                kind: ScaffoldOperationKind::CreateDirectory,
                content: None,
            },
        );

        let mut observations = Vec::with_capacity(required.len());
        let mut operations = Vec::new();
        for artifact in required {
            let path = artifact_path(&project_root, &artifact.suffix);
            let relative_path = if artifact.suffix.is_empty() {
                project_relative.clone()
            } else {
                format!("{project_relative}/{}", artifact.suffix)
            };
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(MemoryError::InvalidInput(format!(
                        "project knowledge path cannot be a symlink: {relative_path}"
                    )));
                }
                Ok(metadata)
                    if artifact.kind == ScaffoldOperationKind::CreateDirectory
                        && !metadata.is_dir() =>
                {
                    return Err(MemoryError::InvalidInput(format!(
                        "project knowledge folder collides with a file: {relative_path}"
                    )));
                }
                Ok(metadata)
                    if artifact.kind == ScaffoldOperationKind::CreateFile
                        && !metadata.is_file() =>
                {
                    return Err(MemoryError::InvalidInput(format!(
                        "project knowledge file collides with a folder: {relative_path}"
                    )));
                }
                Ok(metadata) if metadata.is_file() => {
                    let bytes = std::fs::read(&path).map_err(|error| {
                        MemoryError::InvalidInput(format!(
                            "project knowledge file is unreadable at {relative_path}: {error}"
                        ))
                    })?;
                    if artifact.suffix == "Project.md" {
                        validate_project_identity(&bytes, &mapping.project_id)?;
                    }
                    observations.push(PathObservation {
                        relative_path,
                        state: format!("file:{}", sha256_hex(&bytes)),
                    });
                }
                Ok(_) => observations.push(PathObservation {
                    relative_path,
                    state: "directory".into(),
                }),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let desired_state = artifact
                        .content
                        .as_deref()
                        .map(|content| format!("missing-file:{}", sha256_hex(content.as_bytes())))
                        .unwrap_or_else(|| "missing-directory".into());
                    observations.push(PathObservation {
                        relative_path: relative_path.clone(),
                        state: desired_state,
                    });
                    operations.push(ScaffoldOperation {
                        kind: artifact.kind,
                        relative_path,
                        content: artifact.content,
                    });
                }
                Err(error) => {
                    return Err(MemoryError::InvalidInput(format!(
                        "project knowledge path is inaccessible at {relative_path}: {error}"
                    )));
                }
            }
        }

        let fingerprint = serde_json::to_vec(&PlanFingerprint {
            schema: 1,
            workspace_id,
            project_id: &mapping.project_id,
            project_display_name: &mapping.project_display_name,
            vault_root: &vault.canonical_root,
            observations: &observations,
            operations: &operations,
        })?;
        Ok(ProjectScaffoldPlan {
            workspace_id: workspace_id.into(),
            project_id: mapping.project_id,
            project_display_name: mapping.project_display_name,
            vault_root: vault.canonical_root,
            fingerprint: sha256_hex(&fingerprint),
            operations,
        })
    }

    pub fn apply_project_scaffold(
        &self,
        workspace_id: &str,
        expected_fingerprint: &str,
    ) -> Result<ProjectScaffoldApply> {
        if expected_fingerprint.len() != 64
            || !expected_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(MemoryError::InvalidInput(
                "project scaffold fingerprint must be a 64-character SHA-256 value".into(),
            ));
        }
        let plan = self.preview_project_scaffold(workspace_id)?;
        if plan.fingerprint != expected_fingerprint {
            return Err(MemoryError::InvalidInput(
                "project knowledge changed after preview; refresh the preview before creating files"
                    .into(),
            ));
        }
        let created = apply_operations(Path::new(&plan.vault_root), &plan.operations)?;
        Ok(ProjectScaffoldApply {
            project_id: plan.project_id,
            created,
        })
    }

    pub fn project_obsidian_uri(&self, workspace_id: &str) -> Result<String> {
        let plan = self.preview_project_scaffold(workspace_id)?;
        let project_note_relative = format!("10-Projects/{}/Project.md", plan.project_id);
        if plan
            .operations
            .iter()
            .any(|operation| operation.relative_path == project_note_relative)
        {
            return Err(MemoryError::InvalidInput(
                "create or repair project knowledge before opening it in Obsidian".into(),
            ));
        }
        let project_note = Path::new(&plan.vault_root).join(project_note_relative);
        let project_note = project_note.to_str().ok_or_else(|| {
            MemoryError::InvalidInput(
                "project knowledge path must be valid UTF-8 to open it in Obsidian".into(),
            )
        })?;
        let mut uri = url::Url::parse("obsidian://open").map_err(|error| {
            MemoryError::InvalidInput(format!("cannot build Obsidian project link: {error}"))
        })?;
        uri.query_pairs_mut().append_pair("path", project_note);
        Ok(uri.into())
    }
}

fn apply_operations(
    vault_root: &Path,
    operations: &[ScaffoldOperation],
) -> Result<Vec<ScaffoldOperation>> {
    apply_operations_with_hook(vault_root, operations, |_, _| Ok(()))
}

fn apply_operations_with_hook<F>(
    vault_root: &Path,
    operations: &[ScaffoldOperation],
    mut before_create: F,
) -> Result<Vec<ScaffoldOperation>>
where
    F: FnMut(usize, &ScaffoldOperation) -> std::io::Result<()>,
{
    let mut created = Vec::<(PathBuf, ScaffoldOperation)>::new();
    for (index, operation) in operations.iter().enumerate() {
        let path = operation_path(vault_root, &operation.relative_path)?;
        if let Err(error) = before_create(index, operation) {
            return Err(apply_failure(operation, error, &created));
        }
        let result = match operation.kind {
            ScaffoldOperationKind::CreateDirectory => std::fs::create_dir(&path),
            ScaffoldOperationKind::CreateFile => {
                let open = OpenOptions::new().write(true).create_new(true).open(&path);
                match open {
                    Ok(mut file) => {
                        created.push((path.clone(), operation.clone()));
                        file.write_all(operation.content.as_deref().unwrap_or_default().as_bytes())
                            .and_then(|_| file.sync_all())
                    }
                    Err(error) => Err(error),
                }
            }
        };
        match result {
            Ok(()) => {
                if operation.kind == ScaffoldOperationKind::CreateDirectory {
                    created.push((path, operation.clone()));
                }
            }
            Err(error) => {
                return Err(apply_failure(operation, error, &created));
            }
        }
    }
    Ok(created
        .into_iter()
        .map(|(_, operation)| operation)
        .collect())
}

fn apply_failure(
    operation: &ScaffoldOperation,
    error: std::io::Error,
    created: &[(PathBuf, ScaffoldOperation)],
) -> MemoryError {
    let rollback_errors = rollback_created(created);
    let rollback = if rollback_errors.is_empty() {
        "newly created artifacts were rolled back".to_string()
    } else {
        format!("rollback could not remove: {}", rollback_errors.join(", "))
    };
    MemoryError::InvalidInput(format!(
        "cannot create {}: {error}; {rollback}",
        operation.relative_path
    ))
}

#[cfg(test)]
fn apply_operations_with_fault(
    vault_root: &Path,
    operations: &[ScaffoldOperation],
    fail_before_index: usize,
) -> Result<Vec<ScaffoldOperation>> {
    apply_operations_with_hook(vault_root, operations, |index, _| {
        if index == fail_before_index {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected scaffold write failure",
            ))
        } else {
            Ok(())
        }
    })
}

fn operation_path(vault_root: &Path, relative_path: &str) -> Result<PathBuf> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MemoryError::InvalidInput(
            "project scaffold contains an unsafe relative path".into(),
        ));
    }
    Ok(vault_root.join(relative))
}

fn rollback_created(created: &[(PathBuf, ScaffoldOperation)]) -> Vec<String> {
    let mut errors = Vec::new();
    for (path, operation) in created.iter().rev() {
        let result = match operation.kind {
            ScaffoldOperationKind::CreateDirectory => std::fs::remove_dir(path),
            ScaffoldOperationKind::CreateFile => std::fs::remove_file(path),
        };
        if let Err(error) = result {
            errors.push(format!("{} ({error})", operation.relative_path));
        }
    }
    errors
}

fn artifact_path(project_root: &Path, suffix: &str) -> PathBuf {
    if suffix.is_empty() {
        project_root.to_path_buf()
    } else {
        project_root.join(suffix)
    }
}

fn validate_project_display_name(project_name: &str) -> Result<()> {
    if project_name.chars().count() > 200
        || project_name
            .chars()
            .any(|character| character == '\n' || character == '\r' || character.is_control())
    {
        return Err(MemoryError::InvalidInput(
            "project display name must be one line of at most 200 characters".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_project_identity(bytes: &[u8], expected_project_id: &str) -> Result<()> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        MemoryError::InvalidInput("Project.md must be UTF-8 text with a readable project_id".into())
    })?;
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return Err(MemoryError::InvalidInput(
            "Project.md must start with YAML frontmatter containing project_id".into(),
        ));
    }
    let mut project_ids = Vec::new();
    let mut closed = false;
    for line in &mut lines {
        if line == "---" {
            closed = true;
            break;
        }
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() == "project_id" {
            project_ids.push(parse_project_id_scalar(value.trim())?);
        }
    }
    if !closed {
        return Err(MemoryError::InvalidInput(
            "Project.md YAML frontmatter is not closed".into(),
        ));
    }
    let actual = match project_ids.as_slice() {
        [project_id] => project_id,
        [] => {
            return Err(MemoryError::InvalidInput(
                "Project.md YAML frontmatter must contain project_id".into(),
            ));
        }
        _ => {
            return Err(MemoryError::InvalidInput(
                "Project.md YAML frontmatter must contain exactly one project_id".into(),
            ));
        }
    };
    if actual != expected_project_id {
        return Err(MemoryError::InvalidInput(format!(
            "Project.md project_id is {actual}, but this workspace maps to {expected_project_id}"
        )));
    }
    validate_authority_marker(text, expected_project_id).map(|_| ())
}

fn parse_project_id_scalar(value: &str) -> Result<String> {
    if value.is_empty() {
        return Err(MemoryError::InvalidInput(
            "Project.md project_id cannot be empty".into(),
        ));
    }
    if value.starts_with('"') {
        return serde_json::from_str::<String>(value).map_err(|_| {
            MemoryError::InvalidInput("Project.md project_id has invalid quoting".into())
        });
    }
    if value.starts_with('\'') {
        if value.len() >= 2 && value.ends_with('\'') {
            return Ok(value[1..value.len() - 1].replace("''", "'"));
        }
        return Err(MemoryError::InvalidInput(
            "Project.md project_id has invalid quoting".into(),
        ));
    }
    Ok(value.into())
}

pub(super) fn validate_authority_marker(text: &str, expected_project_id: &str) -> Result<bool> {
    let lines = text.lines().collect::<Vec<_>>();
    let Some(index) = authority_marker_line_index(&lines)? else {
        return Ok(false);
    };
    let marker = lines[index];
    let json = marker
        .strip_prefix("<!-- kodmem-project ")
        .and_then(|value| value.strip_suffix(" -->"))
        .ok_or_else(|| {
            MemoryError::InvalidInput(
                "Project.md contains a malformed kodmem-project authority marker".into(),
            )
        })?;
    let marker: ProjectAuthorityMarker = serde_json::from_str(json).map_err(|_| {
        MemoryError::InvalidInput(
            "Project.md contains a malformed kodmem-project authority marker".into(),
        )
    })?;
    if marker.schema != 1
        || marker.project_id != expected_project_id
        || marker.authority != "projects-vault"
    {
        return Err(MemoryError::InvalidInput(
            "Project.md kodmem-project authority marker does not match this project".into(),
        ));
    }
    Ok(true)
}

pub(super) fn with_authority_marker(text: &str, expected_project_id: &str) -> Result<String> {
    validate_project_identity(text.as_bytes(), expected_project_id)?;
    if validate_authority_marker(text, expected_project_id)? {
        return Ok(text.into());
    }
    let logical = text.lines().collect::<Vec<_>>();
    let frontmatter_end = logical
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| (*line == "---").then_some(index))
        .ok_or_else(|| MemoryError::InvalidInput("Project.md frontmatter is not closed".into()))?;
    let physical = text.split_inclusive('\n').collect::<Vec<_>>();
    let closing = physical.get(frontmatter_end).ok_or_else(|| {
        MemoryError::InvalidInput("Project.md frontmatter span is unavailable".into())
    })?;
    let insertion = physical[..=frontmatter_end]
        .iter()
        .map(|line| line.len())
        .sum::<usize>();
    let line_ending = if closing.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let marker = serde_json::to_string(&ProjectAuthorityMarker {
        schema: 1,
        project_id: expected_project_id.into(),
        authority: "projects-vault".into(),
    })?;
    let mut output = String::with_capacity(text.len() + marker.len() + 32);
    output.push_str(&text[..insertion]);
    if !closing.ends_with('\n') {
        output.push_str(line_ending);
    }
    output.push_str("<!-- kodmem-project ");
    output.push_str(&marker);
    output.push_str(" -->");
    output.push_str(line_ending);
    output.push_str(&text[insertion..]);
    if !validate_authority_marker(&output, expected_project_id)? {
        return Err(MemoryError::InvalidInput(
            "Project.md authority marker could not be inserted safely".into(),
        ));
    }
    Ok(output)
}

pub(super) fn authority_marker_line_index(lines: &[&str]) -> Result<Option<usize>> {
    if lines.first().copied() != Some("---") {
        return Ok(None);
    }
    let Some(frontmatter_end) = lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| (*line == "---").then_some(index))
    else {
        return Err(MemoryError::InvalidInput(
            "Project.md frontmatter is not closed".into(),
        ));
    };
    let Some(index) = ((frontmatter_end + 1)..lines.len()).find(|index| !lines[*index].is_empty())
    else {
        return Ok(None);
    };
    if !lines[index].starts_with("<!-- kodmem-project") {
        return Ok(None);
    }
    if !lines[index].starts_with("<!-- kodmem-project ") || !lines[index].ends_with(" -->") {
        return Err(MemoryError::InvalidInput(
            "Project.md contains a malformed kodmem-project authority marker".into(),
        ));
    }
    Ok(Some(index))
}

fn required_artifacts(project_id: &str, project_name: &str) -> Result<Vec<RequiredArtifact>> {
    let policy = scaffold_policy()?;
    let mut seen = HashSet::new();
    policy
        .artifacts
        .into_iter()
        .map(|artifact| {
            let (suffix, kind, content) = match artifact {
                ArtifactPolicy::Directory { path } => {
                    (path, ScaffoldOperationKind::CreateDirectory, None)
                }
                ArtifactPolicy::File { path, lines } => (
                    path,
                    ScaffoldOperationKind::CreateFile,
                    Some(render_template(&lines.join("\n"), project_id, project_name)? + "\n"),
                ),
            };
            validate_policy_path(&suffix)?;
            if !seen.insert(suffix.clone()) {
                return Err(MemoryError::InvalidInput(format!(
                    "project scaffold policy repeats path: {suffix}"
                )));
            }
            Ok(RequiredArtifact {
                suffix,
                kind,
                content,
            })
        })
        .collect()
}

fn scaffold_policy() -> Result<ScaffoldPolicy> {
    let policy: ScaffoldPolicy = serde_json::from_str(include_str!(
        "../../../resources/kodmem/project-scaffold.json"
    ))?;
    if policy.schema != 1 {
        return Err(MemoryError::InvalidInput(
            "project scaffold policy uses an unsupported schema".into(),
        ));
    }
    Ok(policy)
}

/// Return the declarative scaffold paths used by portable project scanners.
pub(super) fn project_scaffold_paths() -> Result<(Vec<String>, Vec<String>)> {
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut seen = HashSet::new();
    for artifact in scaffold_policy()?.artifacts {
        let (path, is_directory) = match artifact {
            ArtifactPolicy::Directory { path } => (path, true),
            ArtifactPolicy::File { path, .. } => (path, false),
        };
        validate_policy_path(&path)?;
        if !seen.insert(path.clone()) {
            return Err(MemoryError::InvalidInput(format!(
                "project scaffold policy repeats path: {path}"
            )));
        }
        if is_directory {
            directories.push(path);
        } else {
            files.push(path);
        }
    }
    files.sort();
    directories.sort();
    Ok((files, directories))
}

pub(super) fn project_note_relative_path() -> Result<String> {
    scaffold_policy()?
        .artifacts
        .into_iter()
        .find_map(|artifact| match artifact {
            ArtifactPolicy::File { path, lines }
                if lines.iter().any(|line| line.contains("kodmem-project")) =>
            {
                Some(path)
            }
            _ => None,
        })
        .ok_or_else(|| {
            MemoryError::InvalidInput(
                "project scaffold policy is missing its authority note".into(),
            )
        })
}

pub(super) fn rendered_file_placeholder(
    project_id: &str,
    project_name: &str,
    relative_path: &str,
) -> Result<String> {
    required_artifacts(project_id, project_name)?
        .into_iter()
        .find(|artifact| artifact.suffix == relative_path)
        .and_then(|artifact| artifact.content)
        .ok_or_else(|| {
            MemoryError::InvalidInput(format!(
                "project scaffold policy is missing required file: {relative_path}"
            ))
        })
}

fn validate_policy_path(path: &str) -> Result<()> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MemoryError::InvalidInput(
            "project scaffold policy contains an unsafe relative path".into(),
        ));
    }
    Ok(())
}

fn render_template(lines: &str, project_id: &str, project_name: &str) -> Result<String> {
    let project_name_markdown = markdown_text(project_name);
    let mut rendered = String::with_capacity(lines.len());
    let mut remainder = lines;
    while let Some(start) = remainder.find("{{") {
        rendered.push_str(&remainder[..start]);
        remainder = &remainder[start + 2..];
        let end = remainder.find("}}").ok_or_else(|| {
            MemoryError::InvalidInput("project scaffold policy has an unclosed token".into())
        })?;
        let token = &remainder[..end];
        let value = match token {
            "project_id" => project_id.to_string(),
            "project_name_markdown" => project_name_markdown.clone(),
            "project_name_yaml" => serde_json::to_string(project_name)?,
            _ if token.starts_with("project_name_yaml:") => {
                let suffix = &token["project_name_yaml:".len()..];
                serde_json::to_string(&format!("{project_name}{suffix}"))?
            }
            _ => {
                return Err(MemoryError::InvalidInput(format!(
                    "project scaffold policy has an unknown token: {token}"
                )));
            }
        };
        rendered.push_str(&value);
        remainder = &remainder[end + 2..];
    }
    rendered.push_str(remainder);
    Ok(rendered)
}

fn markdown_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::{apply_operations_with_fault, ScaffoldOperation, ScaffoldOperationKind};

    #[test]
    fn a_mid_apply_failure_rolls_back_only_new_scaffold_artifacts() {
        let vault = tempfile::tempdir().expect("create temporary vault");
        let project = vault.path().join("10-Projects/portable-project");
        std::fs::create_dir_all(&project).expect("create existing project folder");
        std::fs::write(project.join("human-note.md"), b"keep these bytes")
            .expect("write pre-existing note");
        let operations = vec![
            ScaffoldOperation {
                kind: ScaffoldOperationKind::CreateDirectory,
                relative_path: "10-Projects/portable-project/Decisions".into(),
                content: None,
            },
            ScaffoldOperation {
                kind: ScaffoldOperationKind::CreateFile,
                relative_path: "10-Projects/portable-project/Decisions/Decisions.md".into(),
                content: Some("generated index".into()),
            },
            ScaffoldOperation {
                kind: ScaffoldOperationKind::CreateDirectory,
                relative_path: "10-Projects/portable-project/Plans".into(),
                content: None,
            },
        ];

        let error = apply_operations_with_fault(vault.path(), &operations, 2)
            .expect_err("inject failure before the third operation");

        assert!(error
            .to_string()
            .contains("injected scaffold write failure"));
        assert!(!project.join("Decisions").exists());
        assert!(!project.join("Plans").exists());
        assert_eq!(
            std::fs::read(project.join("human-note.md")).expect("read pre-existing note"),
            b"keep these bytes"
        );
    }
}
