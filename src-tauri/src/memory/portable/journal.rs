use super::*;

pub(super) fn validate_journal(location: &ProjectLocation, journal: &Journal) -> Result<()> {
    if journal.schema != 1 || journal.project_id != location.project_id {
        return Err(MemoryError::InvalidInput(
            "portable write journal does not match the mapped project".into(),
        ));
    }
    if !matches!(
        journal.action.as_str(),
        "checkpoint" | "remember" | "revise" | "forget" | "restore"
    ) {
        return Err(MemoryError::InvalidInput(
            "portable write journal contains an unsupported action".into(),
        ));
    }
    if (journal.action == "checkpoint") != journal.checkpoint.is_some() {
        return Err(MemoryError::InvalidInput(
            "portable checkpoint journal has invalid structured payload".into(),
        ));
    }
    if !journal.target_id.starts_with("km_")
        || journal.target_id.len() != 35
        || !journal.target_id[3..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(MemoryError::InvalidInput(
            "portable write journal contains an invalid target".into(),
        ));
    }
    super::super::validate_source_client("portable journal", &journal.source_client)?;
    super::super::validate_optional_no_likely_credential(
        "portable journal session id",
        journal.session_id.as_deref(),
    )?;
    if journal.operations.is_empty() || journal.operations.len() > 128 {
        return Err(MemoryError::InvalidInput(
            "portable write journal has an invalid operation count".into(),
        ));
    }
    let mut total_bytes = 0_usize;
    for operation in &journal.operations {
        let allowed = journal_path_allowed(journal, &operation.relative_path);
        if !allowed {
            return Err(MemoryError::InvalidInput(format!(
                "portable write journal targets an unsupported path: {}",
                operation.relative_path
            )));
        }
        if let Some(hash) = operation.expected_sha256.as_deref() {
            validate_sha256("journal expected hash", hash)?;
        }
        if let Some(contents) = operation.contents.as_deref() {
            if contents.len() as u64 > portable_policy()?.max_document_bytes {
                return Err(MemoryError::InvalidInput(
                    "portable journal operation exceeds the file limit".into(),
                ));
            }
            total_bytes = total_bytes.saturating_add(contents.len());
            super::super::validate_no_likely_credential("portable journal contents", contents)?;
            validate_journal_contents(location, journal, operation, contents)?;
        }
    }
    validate_journal_topology(location, journal)?;
    if total_bytes > 8 * 1024 * 1024 {
        return Err(MemoryError::InvalidInput(
            "portable write journal exceeds the 8 MiB transaction limit".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_journal_topology(
    location: &ProjectLocation,
    journal: &Journal,
) -> Result<()> {
    let unique = journal
        .operations
        .iter()
        .map(|operation| operation.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    if unique.len() != journal.operations.len() {
        return Err(MemoryError::InvalidInput(
            "portable write journal repeats an operation path".into(),
        ));
    }
    let policy = portable_policy()?;
    if journal.action == "checkpoint" {
        let marker = journal.checkpoint.as_ref().ok_or_else(|| {
            MemoryError::InvalidInput("checkpoint journal is missing structured payload".into())
        })?;
        validate_checkpoint_marker_payload(marker)?;
        if marker.schema != 1
            || marker.project_id != location.project_id
            || marker.checkpoint_id != journal.target_id
            || marker.source_client != journal.source_client
            || marker.session_id != journal.session_id
        {
            return Err(MemoryError::InvalidInput(
                "checkpoint journal payload does not match its transaction".into(),
            ));
        }
        let checkpoint_input = checkpoint_input_from_marker(&journal.workspace_id, marker);
        if journal.previous_version.is_some() {
            return Err(MemoryError::InvalidInput(
                "checkpoint journal cannot carry a record version".into(),
            ));
        }
        let worklogs = journal
            .operations
            .iter()
            .filter(|operation| is_policy_daily_worklog(&policy, &operation.relative_path))
            .collect::<Vec<_>>();
        if worklogs.len() != 1
            || worklogs[0].contents.is_none()
            || worklogs[0].mode != JournalOperationMode::Append
        {
            return Err(MemoryError::InvalidInput(
                "checkpoint journal must replace exactly one daily Worklog".into(),
            ));
        }
        if worklogs[0].contents.as_deref()
            != Some(render_checkpoint_entry(marker, &checkpoint_input)?.as_str())
        {
            return Err(MemoryError::InvalidInput(
                "checkpoint Worklog delta does not match structured payload".into(),
            ));
        }
        let states = journal
            .operations
            .iter()
            .filter(|operation| operation.relative_path == policy.state_file)
            .collect::<Vec<_>>();
        if marker.updates_state {
            if states.len() != 1
                || states[0].contents.is_none()
                || states[0].expected_sha256.is_none()
                || states[0].mode != JournalOperationMode::Replace
            {
                return Err(MemoryError::InvalidInput(
                    "state-updating checkpoint journal must CAS-replace STATE".into(),
                ));
            }
            let lineage = super::migration::state_lineage_sha256(
                states[0].contents.as_deref().expect("checked above"),
            )?;
            if states[0].contents.as_deref()
                != Some(
                    render_state(location, marker, &checkpoint_input, lineage.as_deref()).as_str(),
                )
            {
                return Err(MemoryError::InvalidInput(
                    "checkpoint STATE bytes do not match structured payload".into(),
                ));
            }
        } else if !states.is_empty() {
            return Err(MemoryError::InvalidInput(
                "append-only checkpoint journal cannot modify STATE".into(),
            ));
        }
        let decision_operations = journal
            .operations
            .iter()
            .filter(|operation| {
                operation.relative_path != policy.state_file
                    && !is_policy_daily_worklog(&policy, &operation.relative_path)
            })
            .collect::<Vec<_>>();
        if decision_operations.len() != marker.decisions.len() {
            return Err(MemoryError::InvalidInput(
                "checkpoint journal decision notes do not match structured decisions".into(),
            ));
        }
        for (index, operation) in decision_operations.iter().enumerate() {
            if operation.mode != JournalOperationMode::Replace
                || operation.expected_sha256.is_some()
                || operation.contents.is_none()
            {
                return Err(MemoryError::InvalidInput(
                    "checkpoint decision journal entries must be new files".into(),
                ));
            }
            let marker = parse_named_marker::<CheckpointDecisionMarker>(
                operation.contents.as_deref().expect("checked above"),
                "<!-- kodmem-checkpoint-decision ",
            )?
            .ok_or_else(|| MemoryError::InvalidInput("checkpoint decision has no marker".into()))?;
            if marker.index != index || marker.checkpoint_id != journal.target_id {
                return Err(MemoryError::InvalidInput(
                    "checkpoint decision journal index is invalid".into(),
                ));
            }
            if operation.contents.as_deref()
                != Some(
                    render_checkpoint_decision(
                        location,
                        journal.checkpoint.as_ref().expect("checked above"),
                        index,
                        &journal
                            .checkpoint
                            .as_ref()
                            .expect("checked above")
                            .decisions[index],
                    )?
                    .as_str(),
                )
            {
                return Err(MemoryError::InvalidInput(
                    "checkpoint decision bytes do not match structured payload".into(),
                ));
            }
        }
        return Ok(());
    }

    let creates = journal
        .operations
        .iter()
        .filter(|operation| operation.contents.is_some() && operation.expected_sha256.is_none())
        .collect::<Vec<_>>();
    let replacements = journal
        .operations
        .iter()
        .filter(|operation| operation.contents.is_some() && operation.expected_sha256.is_some())
        .collect::<Vec<_>>();
    let deletes = journal
        .operations
        .iter()
        .filter(|operation| operation.contents.is_none())
        .collect::<Vec<_>>();
    if journal
        .operations
        .iter()
        .any(|operation| operation.mode != JournalOperationMode::Replace)
    {
        return Err(MemoryError::InvalidInput(
            "memory journal operations must replace canonical files".into(),
        ));
    }
    if deletes
        .iter()
        .any(|operation| operation.expected_sha256.is_none())
    {
        return Err(MemoryError::InvalidInput(
            "memory journal deletes must carry an expected source hash".into(),
        ));
    }
    let new_note = creates
        .first()
        .or_else(|| replacements.first())
        .and_then(|operation| operation.contents.as_deref())
        .ok_or_else(|| MemoryError::InvalidInput("memory journal has no target note".into()))?;
    let marker = parse_record_marker_at_slot(new_note)?.ok_or_else(|| {
        MemoryError::InvalidInput("memory journal target has no canonical marker".into())
    })?;
    match journal.action.as_str() {
        "remember" if creates.len() == 1 && replacements.is_empty() && deletes.is_empty() => {
            if journal.previous_version.is_some() || marker.version != 1 {
                return Err(MemoryError::InvalidInput(
                    "remember journal has an invalid version transition".into(),
                ));
            }
        }
        "revise"
            if (replacements.len() == 1 && creates.is_empty() && deletes.is_empty())
                || (replacements.is_empty() && creates.len() == 1 && deletes.len() == 1) => {}
        "forget" if creates.len() == 1 && replacements.is_empty() && deletes.len() == 1 => {
            if marker.deleted_at.is_none() {
                return Err(MemoryError::InvalidInput(
                    "forget journal target must be archived".into(),
                ));
            }
            if deletes[0].relative_path
                != record_relative_path(marker.kind, &marker.record_id, false)?
            {
                return Err(MemoryError::InvalidInput(
                    "forget journal must move the active canonical note".into(),
                ));
            }
        }
        "restore" if creates.len() == 1 && replacements.is_empty() && deletes.len() == 1 => {
            if marker.deleted_at.is_some() {
                return Err(MemoryError::InvalidInput(
                    "restore journal target must be active".into(),
                ));
            }
            if deletes[0].relative_path
                != record_relative_path(marker.kind, &marker.record_id, true)?
            {
                return Err(MemoryError::InvalidInput(
                    "restore journal must move the archived canonical note".into(),
                ));
            }
        }
        _ => {
            return Err(MemoryError::InvalidInput(
                "portable memory journal has an invalid operation topology".into(),
            ));
        }
    }
    if journal.action != "remember" {
        let previous = journal.previous_version.ok_or_else(|| {
            MemoryError::InvalidInput("memory journal is missing its previous version".into())
        })?;
        if marker.version != previous.saturating_add(1) {
            return Err(MemoryError::InvalidInput(
                "memory journal has an invalid version transition".into(),
            ));
        }
        for operation in journal
            .operations
            .iter()
            .filter(|operation| operation.expected_sha256.is_some())
        {
            let path = confined_path(location, &operation.relative_path)?;
            if file_hash_optional(&path)? == operation.expected_sha256 {
                let current = std::fs::read_to_string(&path)?;
                if let Some(current_marker) = parse_record_marker_at_slot(&current)? {
                    if current_marker.record_id != journal.target_id
                        || current_marker.version != previous
                    {
                        return Err(MemoryError::InvalidInput(
                            "memory journal source marker/version does not match".into(),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

pub(super) fn checkpoint_input_from_marker(
    workspace_id: &str,
    marker: &CheckpointMarker,
) -> NewCheckpoint {
    NewCheckpoint {
        workspace_id: workspace_id.into(),
        summary: marker.summary.clone(),
        decisions: marker.decisions.clone(),
        next_actions: marker.next_actions.clone(),
        changed_paths: marker.changed_paths.clone(),
        source: marker.source,
        source_client: marker.source_client.clone(),
        session_id: marker.session_id.clone(),
        idempotency_key: None,
    }
}

pub(super) fn validate_journal_contents(
    location: &ProjectLocation,
    journal: &Journal,
    operation: &JournalOperation,
    contents: &str,
) -> Result<()> {
    let policy = portable_policy()?;
    if journal.action == "checkpoint" {
        if operation.relative_path == policy.state_file {
            let marker = parse_named_marker::<StateMarker>(contents, "<!-- kodmem-state ")?
                .ok_or_else(|| MemoryError::InvalidInput("journal STATE has no marker".into()))?;
            if marker.schema != 1
                || marker.checkpoint_id != journal.target_id
                || frontmatter_scalar(contents, "project_id").as_deref()
                    != Some(location.project_id.as_str())
            {
                return Err(MemoryError::InvalidInput(
                    "journal STATE marker does not match its checkpoint".into(),
                ));
            }
            return Ok(());
        }
        if is_policy_daily_worklog(&policy, &operation.relative_path) {
            let marker = contents
                .lines()
                .filter(|line| line.trim_start().starts_with(CHECKPOINT_MARKER_PREFIX))
                .map(|line| {
                    parse_marker_line::<CheckpointMarker>(line.trim(), CHECKPOINT_MARKER_PREFIX)
                })
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .find(|marker| marker.checkpoint_id == journal.target_id)
                .ok_or_else(|| {
                    MemoryError::InvalidInput(
                        "journal Worklog does not contain its checkpoint marker".into(),
                    )
                })?;
            validate_sha256("checkpoint payload hash", &marker.payload_hash)?;
            validate_checkpoint_marker_payload(&marker)?;
            if marker.schema != 1
                || marker.project_id != location.project_id
                || marker.source_client != journal.source_client
                || marker.session_id != journal.session_id
            {
                return Err(MemoryError::InvalidInput(
                    "journal checkpoint marker does not match its transaction".into(),
                ));
            }
            return Ok(());
        }
        let marker = parse_named_marker::<CheckpointDecisionMarker>(
            contents,
            "<!-- kodmem-checkpoint-decision ",
        )?
        .ok_or_else(|| MemoryError::InvalidInput("journal decision has no marker".into()))?;
        if marker.schema != 1
            || marker.checkpoint_id != journal.target_id
            || marker.index >= 100
            || frontmatter_scalar(contents, "project_id").as_deref()
                != Some(location.project_id.as_str())
            || frontmatter_scalar(contents, "status").as_deref() != Some("accepted")
        {
            return Err(MemoryError::InvalidInput(
                "journal decision marker does not match its checkpoint".into(),
            ));
        }
        return Ok(());
    }

    let marker = parse_record_marker_at_slot(contents)?.ok_or_else(|| {
        MemoryError::InvalidInput("journal memory note has no canonical marker".into())
    })?;
    validate_sha256("memory payload hash", &marker.payload_hash)?;
    let archived = marker.deleted_at.is_some();
    let expected_path = record_relative_path(marker.kind, &marker.record_id, archived)?;
    let lane = record_lane(&policy, marker.kind)?;
    let expected_status = if archived {
        "archived"
    } else {
        lane.active_status.as_str()
    };
    let version_valid = match journal.action.as_str() {
        "remember" => marker.version == 1 && !archived,
        "revise" => marker.version >= 2 && !archived,
        "forget" => marker.version >= 2 && archived,
        "restore" => marker.version >= 3 && !archived,
        _ => false,
    };
    if marker.schema != 1
        || marker.project_id != location.project_id
        || marker.record_id != journal.target_id
        || marker.source_client != journal.source_client
        || marker.session_id != journal.session_id
        || expected_path != operation.relative_path
        || !version_valid
        || frontmatter_scalar(contents, "project_id").as_deref()
            != Some(location.project_id.as_str())
        || frontmatter_scalar(contents, "type").as_deref() != Some(lane.note_type.as_str())
        || frontmatter_scalar(contents, "status").as_deref() != Some(expected_status)
    {
        return Err(MemoryError::InvalidInput(
            "journal memory marker does not match its transaction or lane".into(),
        ));
    }
    Ok(())
}

pub(super) fn parse_named_marker<T: for<'de> Deserialize<'de>>(
    text: &str,
    prefix: &str,
) -> Result<Option<T>> {
    parse_marker(text, prefix)
}

pub(super) fn frontmatter_scalar(text: &str, key: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines.take(100) {
        if line.trim() == "---" {
            break;
        }
        let (candidate, value) = line.split_once(':')?;
        if candidate.trim() == key {
            let value = value.trim();
            return serde_json::from_str(value)
                .ok()
                .or_else(|| Some(value.trim_matches(['\'', '"']).into()));
        }
    }
    None
}

pub(super) fn journal_path_allowed(journal: &Journal, relative: &str) -> bool {
    let Ok(policy) = portable_policy() else {
        return false;
    };
    let target = &journal.target_id;
    match journal.action.as_str() {
        "checkpoint" => {
            relative == policy.state_file
                || is_policy_daily_worklog(&policy, relative)
                || (1..=100).any(|index| {
                    fill_pattern(
                        &policy.checkpoint.decision_pattern,
                        &[
                            ("checkpoint_id", target.as_str()),
                            ("index", format!("{index:02}").as_str()),
                        ],
                    )
                    .is_ok_and(|candidate| candidate == relative)
                })
        }
        "remember" | "revise" | "forget" | "restore" => policy.record_lanes.iter().any(|lane| {
            [&lane.active_pattern, &lane.archive_pattern]
                .iter()
                .any(|pattern| {
                    fill_pattern(pattern, &[("record_id", target.as_str())])
                        .is_ok_and(|candidate| candidate == relative)
                })
        }),
        _ => false,
    }
}

pub(super) fn is_policy_daily_worklog(policy: &PortablePolicy, relative: &str) -> bool {
    let Some(tail) = relative.strip_prefix("Worklog/") else {
        return false;
    };
    let mut parts = tail.split('/');
    let (Some(year), Some(file), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let Some(date) = file.strip_suffix(".md") else {
        return false;
    };
    let valid = year.len() == 4
        && year.bytes().all(|byte| byte.is_ascii_digit())
        && date.len() == 10
        && date.starts_with(year)
        && date.as_bytes().get(4) == Some(&b'-')
        && date.as_bytes().get(7) == Some(&b'-')
        && date
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());
    valid
        && fill_pattern(
            &policy.checkpoint.worklog_pattern,
            &[("year", year), ("date", date)],
        )
        .is_ok_and(|candidate| candidate == relative)
}
