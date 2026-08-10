use std::collections::BTreeSet;

use rmcp::model::CallToolResult;
use serde::Serialize;
use serde_json::{json, Value};

use crate::memory::{Checkpoint, MemoryRecord, WorkspaceContext};

// CallToolResult carries both text and structured JSON. Leave room for the
// JSON-RPC envelope so the complete stdio response stays below 64 KiB.
const MAX_TOOL_RESULT_BYTES: usize = 60 * 1024;
const MAX_PINNED_DECISIONS: usize = 3;
const MAX_OPEN_TASKS: usize = 5;
const MAX_RECENT_MEMORIES: usize = 5;
const MAX_MEMORY_BODY_CHARS: usize = 300;
const MAX_CHECKPOINT_SUMMARY_CHARS: usize = 1_000;
const MAX_CHECKPOINT_ITEMS: usize = 3;
const MAX_CHECKPOINT_ITEM_CHARS: usize = 200;
const MAX_WORKING_MEMORY_CHARS: usize = 1_000;
const MAX_PROJECT_SOURCES: usize = 6;
const MAX_PROJECT_SOURCE_CHARS: usize = 300;
const MAX_METADATA_CHARS: usize = 200;
const MAX_AFFECTED_LANES: usize = 96;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionCounts {
    pinned_decisions: usize,
    open_tasks: usize,
    recent_memories: usize,
    checkpoint_decisions: usize,
    checkpoint_next_actions: usize,
    checkpoint_changed_paths: usize,
    project_sources: usize,
}

impl ProjectionCounts {
    fn from_context(context: &WorkspaceContext) -> Self {
        let checkpoint = context.latest_checkpoint.as_ref();
        Self {
            pinned_decisions: context.pinned_decisions.len(),
            open_tasks: context.open_tasks.len(),
            recent_memories: context.recent_memories.len(),
            checkpoint_decisions: checkpoint.map_or(0, |value| value.decisions.len()),
            checkpoint_next_actions: checkpoint.map_or(0, |value| value.next_actions.len()),
            checkpoint_changed_paths: checkpoint.map_or(0, |value| value.changed_paths.len()),
            project_sources: context
                .project_knowledge
                .as_ref()
                .map_or(0, |value| value.sources.len()),
        }
    }

    fn from_value(value: &Value) -> Self {
        let checkpoint = &value["latestCheckpoint"];
        Self {
            pinned_decisions: array_len(&value["pinnedDecisions"]),
            open_tasks: array_len(&value["openTasks"]),
            recent_memories: array_len(&value["recentMemories"]),
            checkpoint_decisions: array_len(&checkpoint["decisions"]),
            checkpoint_next_actions: array_len(&checkpoint["nextActions"]),
            checkpoint_changed_paths: array_len(&checkpoint["changedPaths"]),
            project_sources: array_len(&value["projectKnowledge"]["sources"]),
        }
    }
}

struct Projection {
    original_counts: ProjectionCounts,
    returned_counts: ProjectionCounts,
    affected_lanes: BTreeSet<String>,
}

impl Projection {
    fn new(context: &WorkspaceContext) -> Self {
        let counts = ProjectionCounts::from_context(context);
        Self {
            original_counts: counts,
            returned_counts: counts,
            affected_lanes: BTreeSet::new(),
        }
    }

    fn affect(&mut self, lane: impl Into<String>) {
        self.affected_lanes.insert(lane.into());
    }

    fn update_returned_counts(&mut self, counts: ProjectionCounts) {
        self.returned_counts = counts;
        for (changed, lane) in [
            (
                self.original_counts.pinned_decisions != counts.pinned_decisions,
                "pinnedDecisions",
            ),
            (
                self.original_counts.open_tasks != counts.open_tasks,
                "openTasks",
            ),
            (
                self.original_counts.recent_memories != counts.recent_memories,
                "recentMemories",
            ),
            (
                self.original_counts.checkpoint_decisions != counts.checkpoint_decisions,
                "latestCheckpoint.decisions",
            ),
            (
                self.original_counts.checkpoint_next_actions != counts.checkpoint_next_actions,
                "latestCheckpoint.nextActions",
            ),
            (
                self.original_counts.checkpoint_changed_paths != counts.checkpoint_changed_paths,
                "latestCheckpoint.changedPaths",
            ),
            (
                self.original_counts.project_sources != counts.project_sources,
                "projectKnowledge.sources",
            ),
        ] {
            if changed {
                self.affect(lane);
            }
        }
    }

    fn value(&self) -> Option<Value> {
        let truncated =
            self.original_counts != self.returned_counts || !self.affected_lanes.is_empty();
        if !truncated {
            return None;
        }
        Some(json!({
            "truncated": true,
            "originalCounts": self.original_counts,
            "returnedCounts": self.returned_counts,
            "affectedLanes": self
                .affected_lanes
                .iter()
                .take(MAX_AFFECTED_LANES)
                .collect::<Vec<_>>(),
            "affectedLanesTruncated": self.affected_lanes.len() > MAX_AFFECTED_LANES,
        }))
    }
}

fn array_len(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}

pub(super) fn structured_provider_context(mut context: WorkspaceContext) -> CallToolResult {
    let mut projection = Projection::new(&context);
    bound_context(&mut context, &mut projection);
    projection.update_returned_counts(ProjectionCounts::from_context(&context));
    let mut value = match serde_json::to_value(context) {
        Ok(value) => value,
        Err(error) => return serialization_error(error.to_string()),
    };
    remove_local_project_details(&mut value);

    if let Some(result) = result_within_budget(&value, &projection) {
        return result;
    }

    // Pathological metadata and JSON escaping can still exceed the ordinary
    // projection. Retain the highest-priority item from every context lane.
    mark_project_truncated(&mut value, &mut projection);
    reduce_context_collections(&mut value, 1, &mut projection);
    bound_all_strings(&mut value, 64, "", &mut projection);
    projection.update_returned_counts(ProjectionCounts::from_value(&value));
    if let Some(result) = result_within_budget(&value, &projection) {
        return result;
    }

    // The final deterministic fallback preserves the response keys while
    // emptying optional collections and bounding every remaining scalar.
    reduce_context_collections(&mut value, 0, &mut projection);
    projection.update_returned_counts(ProjectionCounts::from_value(&value));
    if let Some(result) = result_within_budget(&value, &projection) {
        return result;
    }
    bound_all_strings(&mut value, 16, "", &mut projection);
    result_within_budget(&value, &projection).unwrap_or_else(|| {
        serialization_error("bounded KödMem context exceeded its fixed response ceiling".into())
    })
}

fn bound_context(context: &mut WorkspaceContext, projection: &mut Projection) {
    bound_string_lane(
        &mut context.workspace.display_name,
        MAX_METADATA_CHARS,
        "workspace.displayName",
        projection,
    );
    if let Some(color) = context.workspace.color.as_mut() {
        bound_string_lane(color, MAX_METADATA_CHARS, "workspace.color", projection);
    }

    if let Some(checkpoint) = context.latest_checkpoint.as_mut() {
        bound_checkpoint(checkpoint, projection);
    }
    bound_memories(
        &mut context.pinned_decisions,
        MAX_PINNED_DECISIONS,
        "pinnedDecisions",
        projection,
    );
    bound_memories(
        &mut context.open_tasks,
        MAX_OPEN_TASKS,
        "openTasks",
        projection,
    );
    bound_memories(
        &mut context.recent_memories,
        MAX_RECENT_MEMORIES,
        "recentMemories",
        projection,
    );

    if let Some(working) = context.working_memory.as_mut() {
        bound_string_lane(
            &mut working.state,
            MAX_WORKING_MEMORY_CHARS,
            "workingMemory.state",
            projection,
        );
        bound_string_lane(
            &mut working.recent_worklog,
            MAX_WORKING_MEMORY_CHARS,
            "workingMemory.recentWorklog",
            projection,
        );
    }

    if let Some(project) = context.project_knowledge.as_mut() {
        let sources_truncated = project.sources.len() > MAX_PROJECT_SOURCES;
        project.sources.truncate(MAX_PROJECT_SOURCES);
        project.sync.truncated |= sources_truncated;
        if sources_truncated {
            projection.affect("projectKnowledge.sources");
        }
        for source in &mut project.sources {
            let title_truncated = bound_string_lane(
                &mut source.title,
                MAX_METADATA_CHARS,
                "projectKnowledge.sources.title",
                projection,
            );
            let content_truncated = bound_string_lane(
                &mut source.content,
                MAX_PROJECT_SOURCE_CHARS,
                "projectKnowledge.sources.content",
                projection,
            );
            source.truncated |= title_truncated || content_truncated;
            project.sync.truncated |= title_truncated || content_truncated;
        }
        if project.sync.error.is_some() {
            projection.affect("projectKnowledge.sync.error");
            project.sync.error = Some(
                "Refresh failed. Repair the mapped project in the local Memory pane, then retry."
                    .into(),
            );
        }
    }
}

fn bound_checkpoint(checkpoint: &mut Checkpoint, projection: &mut Projection) {
    bound_string_lane(
        &mut checkpoint.summary,
        MAX_CHECKPOINT_SUMMARY_CHARS,
        "latestCheckpoint.summary",
        projection,
    );
    bound_string_lane(
        &mut checkpoint.source_client,
        MAX_METADATA_CHARS,
        "latestCheckpoint.sourceClient",
        projection,
    );
    if let Some(session_id) = checkpoint.session_id.as_mut() {
        bound_string_lane(
            session_id,
            MAX_METADATA_CHARS,
            "latestCheckpoint.sessionId",
            projection,
        );
    }
    for (items, lane) in [
        (&mut checkpoint.decisions, "latestCheckpoint.decisions"),
        (&mut checkpoint.next_actions, "latestCheckpoint.nextActions"),
        (
            &mut checkpoint.changed_paths,
            "latestCheckpoint.changedPaths",
        ),
    ] {
        if items.len() > MAX_CHECKPOINT_ITEMS {
            projection.affect(lane);
        }
        items.truncate(MAX_CHECKPOINT_ITEMS);
        for item in items {
            bound_string_lane(
                item,
                MAX_CHECKPOINT_ITEM_CHARS,
                format!("{lane}.items"),
                projection,
            );
        }
    }
}

fn bound_memories(
    memories: &mut Vec<MemoryRecord>,
    limit: usize,
    lane: &str,
    projection: &mut Projection,
) {
    if memories.len() > limit {
        projection.affect(lane);
    }
    memories.truncate(limit);
    for memory in memories {
        bound_string_lane(
            &mut memory.title,
            MAX_METADATA_CHARS,
            format!("{lane}.title"),
            projection,
        );
        bound_string_lane(
            &mut memory.body,
            MAX_MEMORY_BODY_CHARS,
            format!("{lane}.body"),
            projection,
        );
        bound_string_lane(
            &mut memory.source_client,
            MAX_METADATA_CHARS,
            format!("{lane}.sourceClient"),
            projection,
        );
        if let Some(session_id) = memory.session_id.as_mut() {
            bound_string_lane(
                session_id,
                MAX_METADATA_CHARS,
                format!("{lane}.sessionId"),
                projection,
            );
        }
        if memory.links.len() > 2 {
            projection.affect(format!("{lane}.links"));
        }
        if memory.backlinks.len() > 2 {
            projection.affect(format!("{lane}.backlinks"));
        }
        memory.links.truncate(2);
        memory.backlinks.truncate(2);
    }
}

fn bound_string(value: &mut String, limit: usize) -> bool {
    if value.chars().count() <= limit {
        return false;
    }
    let mut bounded = value
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    if limit > 0 {
        bounded.push('…');
    }
    *value = bounded;
    true
}

fn bound_string_lane(
    value: &mut String,
    limit: usize,
    lane: impl Into<String>,
    projection: &mut Projection,
) -> bool {
    let truncated = bound_string(value, limit);
    if truncated {
        projection.affect(lane);
    }
    truncated
}

fn remove_local_project_details(value: &mut Value) {
    if let Some(workspace) = value.get_mut("workspace").and_then(Value::as_object_mut) {
        workspace.remove("canonicalRoot");
    }
    if let Some(working) = value
        .get_mut("workingMemory")
        .and_then(Value::as_object_mut)
    {
        working.remove("directory");
    }
    if let Some(project) = value
        .get_mut("projectKnowledge")
        .and_then(Value::as_object_mut)
    {
        project.remove("origin");
    }
}

fn result_within_budget(value: &Value, projection: &Projection) -> Option<CallToolResult> {
    let mut projected = value.clone();
    if let (Some(projection), Some(context)) = (projection.value(), projected.as_object_mut()) {
        context.insert("projection".into(), projection);
    }
    let result = CallToolResult::structured(projected);
    serde_json::to_vec(&result)
        .ok()
        .filter(|serialized| serialized.len() <= MAX_TOOL_RESULT_BYTES)
        .map(|_| result)
}

fn reduce_context_collections(value: &mut Value, limit: usize, projection: &mut Projection) {
    for key in ["pinnedDecisions", "openTasks", "recentMemories"] {
        if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
            if items.len() > limit {
                projection.affect(key);
            }
            items.truncate(limit);
        }
    }
    if let Some(checkpoint) = value
        .get_mut("latestCheckpoint")
        .and_then(Value::as_object_mut)
    {
        for key in ["decisions", "nextActions", "changedPaths"] {
            if let Some(items) = checkpoint.get_mut(key).and_then(Value::as_array_mut) {
                if items.len() > limit {
                    projection.affect(format!("latestCheckpoint.{key}"));
                }
                items.truncate(limit);
            }
        }
    }
    if let Some(project) = value
        .get_mut("projectKnowledge")
        .and_then(Value::as_object_mut)
    {
        let sources_truncated = project
            .get_mut("sources")
            .and_then(Value::as_array_mut)
            .is_some_and(|sources| {
                let truncated = sources.len() > limit;
                sources.truncate(limit);
                truncated
            });
        if sources_truncated {
            projection.affect("projectKnowledge.sources");
            if let Some(sync) = project.get_mut("sync").and_then(Value::as_object_mut) {
                sync.insert("truncated".into(), Value::Bool(true));
            }
        }
    }
}

fn mark_project_truncated(value: &mut Value, projection: &mut Projection) {
    if let Some(project) = value
        .get_mut("projectKnowledge")
        .and_then(Value::as_object_mut)
    {
        if let Some(sync) = project.get_mut("sync").and_then(Value::as_object_mut) {
            sync.insert("truncated".into(), Value::Bool(true));
        }
        if let Some(sources) = project.get_mut("sources").and_then(Value::as_array_mut) {
            for source in sources {
                if let Some(source) = source.as_object_mut() {
                    source.insert("truncated".into(), Value::Bool(true));
                }
            }
        }
        projection.affect("projectKnowledge.sources");
    }
}

fn bound_all_strings(value: &mut Value, limit: usize, path: &str, projection: &mut Projection) {
    match value {
        Value::String(value) => {
            if bound_string(value, limit) && !path.is_empty() {
                projection.affect(path);
            }
        }
        Value::Array(values) => {
            for value in values {
                let item_path = if value.is_string() {
                    format!("{path}.items")
                } else {
                    path.to_string()
                };
                bound_all_strings(value, limit, &item_path, projection);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                bound_all_strings(value, limit, &child_path, projection);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn serialization_error(message: String) -> CallToolResult {
    CallToolResult::structured_error(json!({
        "type": "serialization_failed",
        "message": format!("failed to serialize bounded KödMem context: {message}")
    }))
}
