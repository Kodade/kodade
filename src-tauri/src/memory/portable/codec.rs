use super::*;

pub(super) fn render_memory_note(
    location: &ProjectLocation,
    marker: &RecordMarker,
    title: &str,
    body: &str,
) -> Result<String> {
    let policy = portable_policy()?;
    let lane = record_lane(&policy, marker.kind)?;
    let status = if marker.deleted_at.is_some() {
        "archived"
    } else {
        &lane.active_status
    };
    render_template(
        &policy.templates.memory,
        &[
            ("title_json", serde_json::to_string(title)?),
            ("type", lane.note_type.clone()),
            ("status", status.into()),
            ("project_id", location.project_id.clone()),
            (
                "marker",
                format!(
                    "{}{} -->",
                    RECORD_MARKER_PREFIX,
                    serde_json::to_string(marker)?
                ),
            ),
            ("title", title.into()),
            ("body", body.trim_end().into()),
        ],
    )
}

pub(super) fn render_checkpoint_entry(
    marker: &CheckpointMarker,
    input: &NewCheckpoint,
) -> Result<String> {
    let stamp = crate::config::iso_timestamp(
        UNIX_EPOCH + std::time::Duration::from_millis(marker.created_at.max(0) as u64),
    );
    let policy = portable_policy()?;
    let mut output = render_template(
        &policy.templates.checkpoint_entry,
        &[
            (
                "marker",
                format!(
                    "{}{} -->",
                    CHECKPOINT_MARKER_PREFIX,
                    serde_json::to_string(marker)?
                ),
            ),
            ("timestamp", stamp),
            ("summary", bounded_preview(input.summary.trim(), 8_000)),
        ],
    )?;
    render_list(
        &mut output,
        "Decisions",
        &bounded_list_preview(&input.decisions),
    );
    render_list(
        &mut output,
        "Next actions",
        &bounded_list_preview(&input.next_actions),
    );
    render_list(
        &mut output,
        "Changed paths",
        &bounded_list_preview(&input.changed_paths),
    );
    output.push_str(&format!(
        "<!-- /kodmem-checkpoint {} -->\n",
        marker.checkpoint_id
    ));
    Ok(output)
}

pub(super) fn render_list(output: &mut String, heading: &str, items: &[String]) {
    if items.is_empty() {
        return;
    }
    output.push_str(&format!("\n### {heading}\n\n"));
    for item in items {
        output.push_str(&format!("- {}\n", item.trim()));
    }
}

pub(super) fn render_state(
    location: &ProjectLocation,
    marker: &CheckpointMarker,
    input: &NewCheckpoint,
) -> String {
    let policy = portable_policy().expect("embedded portable authority policy is valid");
    let mut output = render_template(
        &policy.templates.state,
        &[
            (
                "title_json",
                serde_json::to_string(&format!("{} State", location.project_display_name))
                    .expect("state title serializes"),
            ),
            ("project_id", location.project_id.clone()),
            (
                "marker",
                format!(
                    "<!-- kodmem-state {{\"schema\":1,\"checkpointId\":{}}} -->",
                    serde_json::to_string(&marker.checkpoint_id).expect("checkpoint ID serializes")
                ),
            ),
            ("project_name", location.project_display_name.clone()),
            ("summary", input.summary.trim().into()),
        ],
    )
    .expect("embedded state template renders");
    render_list(&mut output, "Decisions", &input.decisions);
    render_list(&mut output, "Next actions", &input.next_actions);
    render_list(&mut output, "Changed paths", &input.changed_paths);
    bounded_utf8(output, policy.state_byte_limit)
}

pub(super) fn render_checkpoint_decision(
    location: &ProjectLocation,
    marker: &CheckpointMarker,
    index: usize,
    decision: &str,
) -> Result<String> {
    let title = decision
        .split_whitespace()
        .take(12)
        .collect::<Vec<_>>()
        .join(" ");
    let policy = portable_policy()?;
    render_template(
        &policy.templates.checkpoint_decision,
        &[
            ("title_json", serde_json::to_string(&title)?),
            ("project_id", location.project_id.clone()),
            (
                "marker",
                format!(
                    "<!-- kodmem-checkpoint-decision {{\"schema\":1,\"checkpointId\":{},\"index\":{index}}} -->",
                    serde_json::to_string(&marker.checkpoint_id)?
                ),
            ),
            ("title", title),
            ("decision", decision.trim().into()),
        ],
    )
}

pub(super) fn collect_memories(location: &ProjectLocation) -> Result<Vec<CanonicalMemory>> {
    collect_memories_with_budget(location, &mut ScanBudget::new())
}

pub(super) fn collect_memories_with_budget(
    location: &ProjectLocation,
    budget: &mut ScanBudget,
) -> Result<Vec<CanonicalMemory>> {
    let mut records = Vec::new();
    let policy = portable_policy()?;
    let mut directories = BTreeSet::new();
    for lane in &policy.record_lanes {
        for pattern in [&lane.active_pattern, &lane.archive_pattern] {
            let sample = fill_pattern(
                pattern,
                &[("record_id", "km_00000000000000000000000000000000")],
            )?;
            let parent = Path::new(&sample).parent().ok_or_else(|| {
                MemoryError::InvalidInput("portable record lane has no directory".into())
            })?;
            directories.insert(parent.to_path_buf());
        }
    }
    for directory in directories {
        collect_record_directory(
            location,
            &location.project_root.join(directory),
            &mut records,
            budget,
        )?;
    }
    records.sort_by(|left, right| left.marker.record_id.cmp(&right.marker.record_id));
    Ok(records)
}

pub(super) fn collect_record_directory(
    location: &ProjectLocation,
    directory: &Path,
    output: &mut Vec<CanonicalMemory>,
    budget: &mut ScanBudget,
) -> Result<()> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_symlink() {
            return Err(MemoryError::InvalidInput(
                "canonical memory folders cannot contain symlinks".into(),
            ));
        }
        if !entry.file_type()?.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let text = read_bounded_canonical_file(location, &entry.path(), budget)?;
        super::super::validate_no_likely_credential("canonical memory note", &text).map_err(
            |_| {
                MemoryError::InvalidInput(format!(
                    "canonical memory note contains likely credentials: {}",
                    entry.path().display()
                ))
            },
        )?;
        let Some(marker) = parse_record_marker_at_slot(&text)? else {
            continue;
        };
        if marker.schema != 1 || marker.project_id != location.project_id {
            return Err(MemoryError::InvalidInput(
                "canonical memory marker does not match the mapped project".into(),
            ));
        }
        let relative_path = relative_path(location, &entry.path())?;
        let title = frontmatter_title(&text).unwrap_or_else(|| marker.record_id.clone());
        let body = note_body(&text);
        let canonical = CanonicalMemory {
            marker,
            title,
            body,
            relative_path,
            sha256: sha256_bytes(text.as_bytes()),
        };
        validate_canonical_memory(location, &canonical, &text)?;
        output.push(canonical);
    }
    Ok(())
}

pub(super) fn collect_checkpoints(location: &ProjectLocation) -> Result<Vec<CanonicalCheckpoint>> {
    collect_checkpoints_with_budget(location, &mut ScanBudget::new())
}

pub(super) fn collect_checkpoints_with_budget(
    location: &ProjectLocation,
    budget: &mut ScanBudget,
) -> Result<Vec<CanonicalCheckpoint>> {
    let root = location
        .project_root
        .join(portable_policy()?.checkpoint.worklog_root);
    let mut paths = Vec::new();
    collect_markdown_recursive(&root, &mut paths, 0, portable_policy()?.max_scan_files)?;
    let mut checkpoints = Vec::new();
    for path in paths {
        let text = read_bounded_canonical_file(location, &path, budget)?;
        super::super::validate_no_likely_credential("canonical Worklog", &text).map_err(|_| {
            MemoryError::InvalidInput(format!(
                "canonical Worklog contains likely credentials: {}",
                path.display()
            ))
        })?;
        let relative = relative_path(location, &path)?;
        let lines = text.lines().collect::<Vec<_>>();
        let mut fenced = false;
        let mut seen = BTreeSet::new();
        for (index, marker_line) in lines.iter().enumerate() {
            if marker_line.trim_start().starts_with("```") {
                fenced = !fenced;
                continue;
            }
            if fenced
                || !marker_line.starts_with(CHECKPOINT_MARKER_PREFIX)
                || index == 0
                || !lines[index - 1].is_empty()
                || lines
                    .get(index + 1)
                    .is_none_or(|line| !line.starts_with("## "))
            {
                continue;
            }
            let marker =
                parse_marker_line::<CheckpointMarker>(marker_line, CHECKPOINT_MARKER_PREFIX)?;
            if marker.project_id != location.project_id || marker.schema != 1 {
                return Err(MemoryError::InvalidInput(
                    "checkpoint marker does not match the mapped project".into(),
                ));
            }
            let end_marker = format!("<!-- /kodmem-checkpoint {} -->", marker.checkpoint_id);
            let end = lines
                .iter()
                .enumerate()
                .skip(index + 1)
                .find(|(_, line)| **line == end_marker)
                .map(|(end, _)| end)
                .ok_or_else(|| {
                    MemoryError::InvalidInput(
                        "checkpoint entry is missing its closing marker".into(),
                    )
                })?;
            if lines[index + 1..end]
                .iter()
                .any(|line| line.starts_with(CHECKPOINT_MARKER_PREFIX))
                || !seen.insert(marker.checkpoint_id.clone())
            {
                return Err(MemoryError::InvalidInput(
                    "canonical Worklog contains a nested or duplicate checkpoint marker".into(),
                ));
            }
            let summary = marker.summary.clone();
            let decisions = marker.decisions.clone();
            let next_actions = marker.next_actions.clone();
            let changed_paths = marker.changed_paths.clone();
            validate_checkpoint_marker_payload(&marker)?;
            validate_canonical_checkpoint(location, &marker, &relative)?;
            checkpoints.push(CanonicalCheckpoint {
                marker,
                summary,
                decisions,
                next_actions,
                changed_paths,
                relative_path: relative.clone(),
            });
        }
    }
    checkpoints.sort_by_key(|checkpoint| checkpoint.marker.created_at);
    validate_checkpoint_artifacts(location, &checkpoints, budget)?;
    Ok(checkpoints)
}

pub(super) fn validate_checkpoint_artifacts(
    location: &ProjectLocation,
    checkpoints: &[CanonicalCheckpoint],
    budget: &mut ScanBudget,
) -> Result<()> {
    for checkpoint in checkpoints {
        for (index, _) in checkpoint.marker.decisions.iter().enumerate() {
            let formatted_index = format!("{:02}", index + 1);
            let relative = fill_pattern(
                &portable_policy()?.checkpoint.decision_pattern,
                &[
                    ("checkpoint_id", checkpoint.marker.checkpoint_id.as_str()),
                    ("index", formatted_index.as_str()),
                ],
            )?;
            let text = read_bounded_canonical_file(
                location,
                &location.project_root.join(&relative),
                budget,
            )?;
            let marker = parse_frontmatter_slot_marker::<CheckpointDecisionMarker>(
                &text,
                "<!-- kodmem-checkpoint-decision ",
            )?
            .ok_or_else(|| {
                MemoryError::InvalidInput(
                    "checkpoint decision artifact is missing its canonical marker".into(),
                )
            })?;
            if marker.checkpoint_id != checkpoint.marker.checkpoint_id || marker.index != index {
                return Err(MemoryError::InvalidInput(
                    "checkpoint decision artifact does not match its Worklog entry".into(),
                ));
            }
        }
    }
    if let Some(latest) = checkpoints
        .iter()
        .filter(|checkpoint| checkpoint.marker.updates_state)
        .max_by_key(|checkpoint| checkpoint.marker.created_at)
    {
        let text = read_bounded_canonical_file(
            location,
            &location.project_root.join(&portable_policy()?.state_file),
            budget,
        )?;
        let marker = parse_frontmatter_slot_marker::<StateMarker>(&text, "<!-- kodmem-state ")?
            .ok_or_else(|| {
                MemoryError::InvalidInput("STATE is missing its canonical marker".into())
            })?;
        if marker.schema != 1 || marker.checkpoint_id != latest.marker.checkpoint_id {
            return Err(MemoryError::InvalidInput(
                "STATE does not match the latest state-updating checkpoint".into(),
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_canonical_memory(
    location: &ProjectLocation,
    memory: &CanonicalMemory,
    text: &str,
) -> Result<()> {
    let marker = &memory.marker;
    if marker.schema != 1
        || marker.project_id != location.project_id
        || !marker.record_id.starts_with("km_")
        || marker.record_id.len() != 35
        || marker.version == 0
        || marker.updated_at < marker.created_at
        || marker
            .deleted_at
            .is_some_and(|deleted| deleted > marker.updated_at)
    {
        return Err(MemoryError::InvalidInput(
            "canonical memory marker has invalid identity or chronology".into(),
        ));
    }
    validate_sha256("memory payload hash", &marker.payload_hash)?;
    if let Some(hash) = marker.idempotency_key_hash.as_deref() {
        validate_sha256("memory idempotency key hash", hash)?;
    }
    super::super::validate_memory_fields(
        &memory.title,
        &memory.body,
        &marker.source_client,
        super::super::MEMORY_TITLE_LIMIT,
    )?;
    super::super::validate_optional_no_likely_credential(
        "canonical memory session id",
        marker.session_id.as_deref(),
    )?;
    super::super::validate_memory_links(&marker.links)?;
    let expected_path =
        record_relative_path(marker.kind, &marker.record_id, marker.deleted_at.is_some())?;
    let policy = portable_policy()?;
    let lane = record_lane(&policy, marker.kind)?;
    let expected_status = if marker.deleted_at.is_some() {
        "archived"
    } else {
        lane.active_status.as_str()
    };
    if memory.relative_path != expected_path
        || frontmatter_scalar(text, "project_id").as_deref() != Some(location.project_id.as_str())
        || frontmatter_scalar(text, "type").as_deref() != Some(lane.note_type.as_str())
        || frontmatter_scalar(text, "status").as_deref() != Some(expected_status)
    {
        return Err(MemoryError::InvalidInput(
            "canonical memory note does not match its declared project lane".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_canonical_checkpoint(
    location: &ProjectLocation,
    marker: &CheckpointMarker,
    relative_path: &str,
) -> Result<()> {
    if marker.schema != 1
        || marker.project_id != location.project_id
        || !marker.checkpoint_id.starts_with("km_")
        || marker.checkpoint_id.len() != 35
        || marker.created_at < 0
        || !is_policy_daily_worklog(&portable_policy()?, relative_path)
    {
        return Err(MemoryError::InvalidInput(
            "canonical checkpoint marker has invalid identity or Worklog path".into(),
        ));
    }
    if let Some(hash) = marker.idempotency_key_hash.as_deref() {
        validate_sha256("checkpoint idempotency key hash", hash)?;
    }
    super::super::validate_checkpoint(&NewCheckpoint {
        workspace_id: "portable-rebuild".into(),
        summary: marker.summary.clone(),
        decisions: marker.decisions.clone(),
        next_actions: marker.next_actions.clone(),
        changed_paths: marker.changed_paths.clone(),
        source: marker.source,
        source_client: marker.source_client.clone(),
        session_id: marker.session_id.clone(),
        idempotency_key: None,
    })?;
    validate_checkpoint_marker_payload(marker)
}

pub(super) fn find_checkpoint_by_key(
    location: &ProjectLocation,
    key_hash: &str,
) -> Result<Option<CanonicalCheckpoint>> {
    Ok(collect_checkpoints(location)?
        .into_iter()
        .find(|checkpoint| checkpoint.marker.idempotency_key_hash.as_deref() == Some(key_hash)))
}

pub(super) fn find_memory_by_key(
    location: &ProjectLocation,
    key_hash: &str,
) -> Result<Option<CanonicalMemory>> {
    Ok(collect_memories(location)?
        .into_iter()
        .find(|record| record.marker.idempotency_key_hash.as_deref() == Some(key_hash)))
}

pub(super) fn parse_marker<T: for<'de> Deserialize<'de>>(
    text: &str,
    prefix: &str,
) -> Result<Option<T>> {
    let Some(line) = text
        .lines()
        .find(|line| line.trim_start().starts_with(prefix))
    else {
        return Ok(None);
    };
    parse_marker_line(line.trim(), prefix).map(Some)
}

pub(super) fn parse_record_marker_at_slot(text: &str) -> Result<Option<RecordMarker>> {
    parse_frontmatter_slot_marker(text, RECORD_MARKER_PREFIX)
}

pub(super) fn parse_frontmatter_slot_marker<T: for<'de> Deserialize<'de>>(
    text: &str,
    prefix: &str,
) -> Result<Option<T>> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Ok(None);
    }
    let mut closed = false;
    for line in &mut lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
    }
    if !closed {
        return Ok(None);
    }
    let Some(line) = lines.find(|line| !line.trim().is_empty()) else {
        return Ok(None);
    };
    let line = line.trim();
    if !line.starts_with(prefix.trim_end()) {
        return Ok(None);
    }
    if text
        .lines()
        .filter(|line| line.trim_start().starts_with(prefix.trim_end()))
        .count()
        != 1
    {
        return Err(MemoryError::InvalidInput(
            "canonical memory note must contain exactly one marker".into(),
        ));
    }
    parse_marker_line(line, prefix).map(Some)
}

pub(super) fn parse_marker_line<T: for<'de> Deserialize<'de>>(
    line: &str,
    prefix: &str,
) -> Result<T> {
    let json = line
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(" -->"))
        .ok_or_else(|| {
            MemoryError::InvalidInput("canonical Markdown marker is malformed".into())
        })?;
    serde_json::from_str(json).map_err(Into::into)
}

pub(super) fn frontmatter_title(text: &str) -> Option<String> {
    let line = text
        .lines()
        .take(100)
        .find(|line| line.starts_with("title:"))?;
    let value = line.split_once(':')?.1.trim();
    serde_json::from_str(value)
        .ok()
        .or_else(|| Some(value.trim_matches('"').into()))
}

pub(super) fn note_body(text: &str) -> String {
    let mut after_heading = false;
    text.lines()
        .filter_map(|line| {
            if !after_heading && line.starts_with("# ") {
                after_heading = true;
                return None;
            }
            after_heading.then_some(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub(super) fn collect_markdown_recursive(
    root: &Path,
    paths: &mut Vec<PathBuf>,
    depth: usize,
    max_files: usize,
) -> Result<()> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(MemoryError::InvalidInput(
                "canonical Worklog cannot contain symlinks".into(),
            ));
        }
        if kind.is_dir() {
            if depth >= 1 {
                return Err(MemoryError::InvalidInput(
                    "canonical Worklog tree is deeper than Worklog/YYYY/file.md".into(),
                ));
            }
            collect_markdown_recursive(&entry.path(), paths, depth + 1, max_files)?;
        } else if kind.is_file()
            && entry.path().extension().and_then(|value| value.to_str()) == Some("md")
        {
            paths.push(entry.path());
            if paths.len() > max_files {
                return Err(MemoryError::InvalidInput(
                    "canonical Worklog exceeds the file scan limit".into(),
                ));
            }
        }
    }
    paths.sort();
    Ok(())
}

pub(super) fn read_bounded_canonical_file(
    location: &ProjectLocation,
    path: &Path,
    budget: &mut ScanBudget,
) -> Result<String> {
    let policy = portable_policy()?;
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::InvalidInput(
            "canonical Markdown must be a regular file".into(),
        ));
    }
    if metadata.len() > policy.max_document_bytes {
        return Err(MemoryError::InvalidInput(format!(
            "canonical Markdown exceeds the {} KiB file limit",
            policy.max_document_bytes / 1024
        )));
    }
    let canonical = std::fs::canonicalize(path)?;
    let canonical_root = std::fs::canonicalize(&location.project_root)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(MemoryError::InvalidInput(
            "canonical Markdown escapes the mapped project".into(),
        ));
    }
    budget.files = budget.files.saturating_add(1);
    budget.bytes = budget.bytes.saturating_add(metadata.len() as usize);
    if budget.files > policy.max_scan_files || budget.bytes > policy.max_project_bytes {
        return Err(MemoryError::InvalidInput(
            "canonical Markdown exceeds the project scan budget".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(canonical)?
        .take(policy.max_document_bytes + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > policy.max_document_bytes {
        return Err(MemoryError::InvalidInput(
            "canonical Markdown grew beyond the file limit while reading".into(),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| MemoryError::InvalidInput("canonical Markdown must be valid UTF-8".into()))
}

pub(super) fn record_relative_path(kind: MemoryKind, id: &str, archived: bool) -> Result<String> {
    let policy = portable_policy()?;
    let lane = record_lane(&policy, kind)?;
    fill_pattern(
        if archived {
            &lane.archive_pattern
        } else {
            &lane.active_pattern
        },
        &[("record_id", id)],
    )
}

pub(super) fn checkpoint_payload_hash(input: &NewCheckpoint, update_state: bool) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(&(
        input.summary.trim(),
        &input.decisions,
        &input.next_actions,
        &input.changed_paths,
        input.source,
        &input.source_client,
        &input.session_id,
        update_state,
    ))?))
}

pub(super) fn validate_checkpoint_marker_payload(marker: &CheckpointMarker) -> Result<()> {
    let actual = sha256_bytes(&serde_json::to_vec(&(
        marker.summary.trim(),
        &marker.decisions,
        &marker.next_actions,
        &marker.changed_paths,
        marker.source,
        &marker.source_client,
        &marker.session_id,
        marker.updates_state,
    ))?);
    if actual != marker.payload_hash {
        return Err(MemoryError::InvalidInput(
            "checkpoint marker payload hash does not match its structured content".into(),
        ));
    }
    Ok(())
}

pub(super) fn memory_payload_hash(input: &NewMemory) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(&(
        input.kind,
        input.title.trim(),
        &input.body,
        input.source,
        &input.source_client,
        &input.session_id,
        input.pinned,
        &input.links,
    ))?))
}

pub(super) fn unique_id(scope: &str, project_id: &str, now: i64) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let seed = format!(
        "{scope}\0{project_id}\0{now}\0{}\0{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    format!("km_{}", &sha256_text(&seed)[..32])
}

pub(super) fn projected_id(prefix: &str, workspace_id: &str, logical_id: &str) -> String {
    format!(
        "{prefix}_{}",
        &sha256_text(&format!("{workspace_id}\0{logical_id}"))[..32]
    )
}

pub(crate) fn portable_projected_memory_id(workspace_id: &str, logical_id: &str) -> String {
    projected_id("mem", workspace_id, logical_id)
}

pub(super) fn utc_date(now: SystemTime) -> String {
    crate::config::iso_timestamp(now)[..10].to_string()
}

pub(super) fn daily_header(date: &str, project_name: &str) -> Result<String> {
    let policy = portable_policy()?;
    render_template(
        &policy.templates.daily_header,
        &[
            (
                "title_json",
                serde_json::to_string(&format!("{project_name} — {date}"))?,
            ),
            ("date", date.into()),
            ("project_name", project_name.into()),
        ],
    )
}

pub(super) fn portable_policy() -> Result<PortablePolicy> {
    let policy: PortablePolicy = serde_json::from_str(include_str!(
        "../../../../resources/kodmem/portable-authority.json"
    ))?;
    if policy.schema != 1
        || policy.state_byte_limit < 1024
        || policy.state_byte_limit > 256 * 1024
        || policy.max_document_bytes != 256 * 1024
        || policy.max_project_bytes != 4 * 1024 * 1024
        || policy.max_scan_files != 512
        || policy.record_lanes.len() != 2
        || policy.journal_file != ".kodmem-write-journal.json"
        || policy.lock_namespace.is_empty()
    {
        return Err(MemoryError::InvalidInput(
            "portable authority policy is invalid".into(),
        ));
    }
    let mut kinds = Vec::new();
    for lane in &policy.record_lanes {
        if lane.note_type.is_empty() || lane.active_status.is_empty() {
            return Err(MemoryError::InvalidInput(
                "portable authority record lane is incomplete".into(),
            ));
        }
        for kind in &lane.kinds {
            if kinds.contains(kind) {
                return Err(MemoryError::InvalidInput(
                    "portable authority policy repeats a memory kind".into(),
                ));
            }
            kinds.push(*kind);
        }
        fill_pattern(
            &lane.active_pattern,
            &[("record_id", "km_00000000000000000000000000000000")],
        )?;
        fill_pattern(
            &lane.archive_pattern,
            &[("record_id", "km_00000000000000000000000000000000")],
        )?;
    }
    if kinds.len() != 5 {
        return Err(MemoryError::InvalidInput(
            "portable authority policy must route every memory kind exactly once".into(),
        ));
    }
    Ok(policy)
}

pub(super) fn record_lane(policy: &PortablePolicy, kind: MemoryKind) -> Result<&RecordLanePolicy> {
    policy
        .record_lanes
        .iter()
        .find(|lane| lane.kinds.contains(&kind))
        .ok_or_else(|| MemoryError::InvalidInput("memory kind has no portable lane".into()))
}

pub(super) fn fill_pattern(pattern: &str, values: &[(&str, &str)]) -> Result<String> {
    let rendered = render_original_tokens(pattern, values, "pattern")?;
    let path = Path::new(&rendered);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(MemoryError::InvalidInput(
            "portable authority pattern produced an unsafe path".into(),
        ));
    }
    Ok(rendered)
}

pub(super) fn render_template(lines: &[String], values: &[(&str, String)]) -> Result<String> {
    let mut rendered = render_original_tokens(&lines.join("\n"), values, "template")?;
    rendered.push('\n');
    Ok(rendered)
}

fn render_original_tokens<T: AsRef<str>>(
    original: &str,
    values: &[(&str, T)],
    label: &str,
) -> Result<String> {
    let mut rendered = String::with_capacity(original.len());
    let mut remaining = original;
    while let Some(start) = remaining.find("{{") {
        rendered.push_str(&remaining[..start]);
        let token_and_tail = &remaining[start + 2..];
        let end = token_and_tail.find("}}").ok_or_else(|| {
            MemoryError::InvalidInput(format!(
                "portable authority {label} contains an unknown token"
            ))
        })?;
        let key = &token_and_tail[..end];
        let value = values
            .iter()
            .find(|(candidate, _)| *candidate == key)
            .map(|(_, value)| value.as_ref())
            .ok_or_else(|| {
                MemoryError::InvalidInput(format!(
                    "portable authority {label} contains an unknown token"
                ))
            })?;
        rendered.push_str(value);
        remaining = &token_and_tail[end + 2..];
    }
    rendered.push_str(remaining);
    Ok(rendered)
}

pub(super) fn validate_sha256(field: &str, value: &str) -> Result<()> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(MemoryError::InvalidInput(format!(
            "{field} must be a 64-character SHA-256 value"
        )))
    }
}

pub(super) fn sha256_text(value: &str) -> String {
    sha256_bytes(value.as_bytes())
}

pub(super) fn sha256_bytes(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
