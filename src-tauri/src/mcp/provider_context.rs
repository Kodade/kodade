use rmcp::model::CallToolResult;
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

pub(super) fn structured_provider_context(mut context: WorkspaceContext) -> CallToolResult {
    bound_context(&mut context);
    let mut value = match serde_json::to_value(context) {
        Ok(value) => value,
        Err(error) => return serialization_error(error.to_string()),
    };
    remove_local_project_details(&mut value);

    if let Some(result) = result_within_budget(&value) {
        return result;
    }

    // Pathological metadata and JSON escaping can still exceed the ordinary
    // projection. Retain the highest-priority item from every context lane.
    mark_project_truncated(&mut value);
    reduce_context_collections(&mut value, 1);
    bound_all_strings(&mut value, 64);
    if let Some(result) = result_within_budget(&value) {
        return result;
    }

    // The final deterministic fallback preserves the response keys while
    // emptying optional collections and bounding every remaining scalar.
    reduce_context_collections(&mut value, 0);
    if let Some(result) = result_within_budget(&value) {
        return result;
    }
    bound_all_strings(&mut value, 16);
    result_within_budget(&value).unwrap_or_else(|| {
        serialization_error("bounded KödMem context exceeded its fixed response ceiling".into())
    })
}

fn bound_context(context: &mut WorkspaceContext) {
    bound_string(&mut context.workspace.display_name, MAX_METADATA_CHARS);
    if let Some(color) = context.workspace.color.as_mut() {
        bound_string(color, MAX_METADATA_CHARS);
    }

    if let Some(checkpoint) = context.latest_checkpoint.as_mut() {
        bound_checkpoint(checkpoint);
    }
    bound_memories(&mut context.pinned_decisions, MAX_PINNED_DECISIONS);
    bound_memories(&mut context.open_tasks, MAX_OPEN_TASKS);
    bound_memories(&mut context.recent_memories, MAX_RECENT_MEMORIES);

    if let Some(working) = context.working_memory.as_mut() {
        bound_string(&mut working.state, MAX_WORKING_MEMORY_CHARS);
        bound_string(&mut working.recent_worklog, MAX_WORKING_MEMORY_CHARS);
    }

    if let Some(project) = context.project_knowledge.as_mut() {
        let sources_truncated = project.sources.len() > MAX_PROJECT_SOURCES;
        project.sources.truncate(MAX_PROJECT_SOURCES);
        project.sync.truncated |= sources_truncated;
        for source in &mut project.sources {
            let title_truncated = bound_string(&mut source.title, MAX_METADATA_CHARS);
            let content_truncated = bound_string(&mut source.content, MAX_PROJECT_SOURCE_CHARS);
            source.truncated |= title_truncated || content_truncated;
            project.sync.truncated |= title_truncated || content_truncated;
        }
        if project.sync.error.is_some() {
            project.sync.error = Some(
                "Refresh failed. Repair the mapped project in the local Memory pane, then retry."
                    .into(),
            );
        }
    }
}

fn bound_checkpoint(checkpoint: &mut Checkpoint) {
    bound_string(&mut checkpoint.summary, MAX_CHECKPOINT_SUMMARY_CHARS);
    bound_string(&mut checkpoint.source_client, MAX_METADATA_CHARS);
    if let Some(session_id) = checkpoint.session_id.as_mut() {
        bound_string(session_id, MAX_METADATA_CHARS);
    }
    for items in [
        &mut checkpoint.decisions,
        &mut checkpoint.next_actions,
        &mut checkpoint.changed_paths,
    ] {
        items.truncate(MAX_CHECKPOINT_ITEMS);
        for item in items {
            bound_string(item, MAX_CHECKPOINT_ITEM_CHARS);
        }
    }
}

fn bound_memories(memories: &mut Vec<MemoryRecord>, limit: usize) {
    memories.truncate(limit);
    for memory in memories {
        bound_string(&mut memory.title, MAX_METADATA_CHARS);
        bound_string(&mut memory.body, MAX_MEMORY_BODY_CHARS);
        bound_string(&mut memory.source_client, MAX_METADATA_CHARS);
        if let Some(session_id) = memory.session_id.as_mut() {
            bound_string(session_id, MAX_METADATA_CHARS);
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

fn remove_local_project_details(value: &mut Value) {
    if let Some(project) = value
        .get_mut("projectKnowledge")
        .and_then(Value::as_object_mut)
    {
        project.remove("origin");
    }
}

fn result_within_budget(value: &Value) -> Option<CallToolResult> {
    let result = CallToolResult::structured(value.clone());
    serde_json::to_vec(&result)
        .ok()
        .filter(|serialized| serialized.len() <= MAX_TOOL_RESULT_BYTES)
        .map(|_| result)
}

fn reduce_context_collections(value: &mut Value, limit: usize) {
    for key in ["pinnedDecisions", "openTasks", "recentMemories"] {
        if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
            items.truncate(limit);
        }
    }
    if let Some(checkpoint) = value
        .get_mut("latestCheckpoint")
        .and_then(Value::as_object_mut)
    {
        for key in ["decisions", "nextActions", "changedPaths"] {
            if let Some(items) = checkpoint.get_mut(key).and_then(Value::as_array_mut) {
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
            if let Some(sync) = project.get_mut("sync").and_then(Value::as_object_mut) {
                sync.insert("truncated".into(), Value::Bool(true));
            }
        }
    }
}

fn mark_project_truncated(value: &mut Value) {
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
    }
}

fn bound_all_strings(value: &mut Value, limit: usize) {
    match value {
        Value::String(value) => {
            bound_string(value, limit);
        }
        Value::Array(values) => {
            for value in values {
                bound_all_strings(value, limit);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                bound_all_strings(value, limit);
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
