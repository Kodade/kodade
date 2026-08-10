use std::path::PathBuf;

use rmcp::handler::server::common::schema_for_input;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ErrorData,
    GetPromptRequestParams, GetPromptResponse, GetPromptResult, Implementation, ListPromptsResult,
    ListToolsResult, PaginatedRequestParams, Prompt, PromptMessage, ProtocolVersion, Role,
    ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::schemars::{self, JsonSchema};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, ServiceExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};

use crate::memory::{
    MemoryError, MemoryKind, MemoryLink, MemoryQuery, MemoryRecord, MemoryRevision, MemorySource,
    MemoryStore, MutationProvenance, NewCheckpoint, NewMemory, Workspace, MEMORY_TITLE_LIMIT,
};

mod provider_context;
pub mod secret_scan;

use provider_context::structured_provider_context;

const DATABASE_FILENAME: &str = "kodade-memory.sqlite3";
const KODADE_WORKFLOW_INSTRUCTIONS: &str = "At the start of each work session, call get_context with the current workspace root before making plans. Search memories when you need a specific prior fact. Save only durable decisions, facts, preferences, tasks, or concise summaries with remember; use a stable idempotencyKey whenever a retry is possible. Do not store secrets, credentials, transient logs, or information already obvious from the repository. Use revise_memory with the version you read instead of overwriting newer work. Before ending or handing off a session, call checkpoint with a short summary, concrete next actions, a sessionId when available, and an idempotencyKey.";

pub const HELP: &str = "\
kodade-mcp - KödMem MCP stdio server

Usage: kodade-mcp [OPTIONS]

Options:
  --db <path>          Memory database (default: Kodade platform app-data)
  --workspace <root>   Restrict access to one registered workspace
  --read-only          Advertise and allow only read tools
  --client <name>      Audit provenance client label (default: mcp)
  -h, --help           Print help";

#[derive(Clone, Debug)]
pub struct Config {
    pub db_path: PathBuf,
    pub workspace_root: Option<PathBuf>,
    pub read_only: bool,
    pub client: String,
}

#[derive(Clone, Debug)]
pub enum Cli {
    Help,
    Serve(Config),
}

pub fn parse_cli(args: impl IntoIterator<Item = String>) -> Result<Cli, String> {
    let mut db_path = None;
    let mut workspace_root = None;
    let mut read_only = false;
    let mut client = String::from("mcp");
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Cli::Help),
            "--db" => {
                db_path = Some(PathBuf::from(args.next().ok_or("--db requires a path")?));
            }
            "--workspace" => {
                workspace_root = Some(PathBuf::from(
                    args.next().ok_or("--workspace requires a root")?,
                ));
            }
            "--read-only" => read_only = true,
            "--client" => {
                client = args.next().ok_or("--client requires a name")?;
                if client.trim().is_empty() {
                    return Err("--client cannot be empty".into());
                }
            }
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }

    Ok(Cli::Serve(Config {
        db_path: db_path.unwrap_or(default_database_path()?),
        workspace_root,
        read_only,
        client,
    }))
}

pub fn default_database_path() -> Result<PathBuf, String> {
    crate::app_data::default_app_data_dir().map(|directory| directory.join(DATABASE_FILENAME))
}

#[derive(Clone)]
pub struct KodadeMcp {
    store: MemoryStore,
    restricted_workspace_id: Option<String>,
    read_only: bool,
    client: String,
}

impl KodadeMcp {
    pub fn open(config: Config) -> Result<Self, String> {
        let store = if config.read_only {
            MemoryStore::open_read_only(&config.db_path)
        } else {
            MemoryStore::open(&config.db_path)
        }
        .map_err(|error| error.to_string())?;
        let restricted_workspace_id = config
            .workspace_root
            .as_ref()
            .map(|root| store.resolve_workspace(root).map(|workspace| workspace.id))
            .transpose()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            store,
            restricted_workspace_id,
            read_only: config.read_only,
            client: config.client,
        })
    }

    fn tools(&self) -> Vec<Tool> {
        let mut tools = vec![
            tool::<GetContextParams>(
                "get_context",
                "Get KödMem context for a registered workspace.",
                true,
                false,
                true,
            ),
            tool::<SearchMemoriesParams>(
                "search_memories",
                "Search KödMem records in a registered workspace.",
                true,
                false,
                true,
            ),
            tool::<GetMemoryParams>(
                "get_memory",
                "Get one KödMem record by id within a registered workspace.",
                true,
                false,
                true,
            ),
        ];
        if !self.read_only {
            tools.extend([
                tool::<RememberParams>(
                    "remember",
                    "Store an explicit project memory with optional retry deduplication.",
                    false,
                    false,
                    false,
                ),
                tool::<ReviseMemoryParams>(
                    "revise_memory",
                    "Revise a memory using optimistic version concurrency.",
                    false,
                    true,
                    false,
                ),
                tool::<ForgetMemoryParams>(
                    "forget_memory",
                    "Soft-delete a memory and return its tombstone.",
                    false,
                    true,
                    false,
                ),
                tool::<CheckpointParams>(
                    "checkpoint",
                    "Record an end-of-session summary, decisions, next actions, and changed paths.",
                    false,
                    false,
                    false,
                ),
            ]);
        }
        tools
    }

    fn call_tool_sync(&self, request: CallToolRequestParams) -> Result<CallToolResult, ErrorData> {
        if self.read_only && is_write_tool(request.name.as_ref()) {
            return Ok(tool_error(
                "read_only",
                "kodade-mcp is running in read-only mode; write tools are disabled",
                json!({ "tool": request.name }),
            ));
        }
        let arguments = request.arguments.unwrap_or_default();
        match request.name.as_ref() {
            "get_context" => {
                let params = parse_arguments::<GetContextParams>(arguments)?;
                let workspace = match self.workspace_for_root(&params.workspace_root) {
                    Ok(workspace) => workspace,
                    Err(error) => return Ok(error),
                };
                match self.store.context(&workspace.id) {
                    Ok(context) => Ok(structured_provider_context(context)),
                    Err(error) => Ok(memory_error(error)),
                }
            }
            "search_memories" => {
                let params = parse_arguments::<SearchMemoriesParams>(arguments)?;
                let workspace = match self.workspace_for_root(&params.workspace_root) {
                    Ok(workspace) => workspace,
                    Err(error) => return Ok(error),
                };
                let query = MemoryQuery {
                    workspace_id: workspace.id,
                    text: params.query,
                    kinds: params
                        .kinds
                        .unwrap_or_default()
                        .into_iter()
                        .map(Into::into)
                        .collect(),
                    sources: params
                        .sources
                        .unwrap_or_default()
                        .into_iter()
                        .map(Into::into)
                        .collect(),
                    updated_after: None,
                    limit: params.limit.unwrap_or(20).clamp(1, 50),
                    offset: params.offset.unwrap_or(0),
                };
                match self.store.search(query) {
                    Ok(page) => Ok(structured(page)),
                    Err(error) => Ok(memory_error(error)),
                }
            }
            "get_memory" => {
                let params = parse_arguments::<GetMemoryParams>(arguments)?;
                let workspace = match self.workspace_for_root(&params.workspace_root) {
                    Ok(workspace) => workspace,
                    Err(error) => return Ok(error),
                };
                let record = match self.store.memory(&params.id) {
                    Ok(record) => record,
                    Err(error) => return Ok(memory_error(error)),
                };
                if record.workspace_id != workspace.id {
                    return Ok(tool_error(
                        "memory_not_found",
                        "memory was not found in the requested workspace",
                        json!({ "id": params.id }),
                    ));
                }
                if let Err(error) = self.enforce_record_scope(&record) {
                    return Ok(error);
                }
                Ok(structured(record))
            }
            "remember" => {
                let params = parse_arguments::<RememberParams>(arguments)?;
                if let Err(error) = validate_title("title", &params.title) {
                    return Ok(error);
                }
                if let Err(error) = validate_large_text("body", &params.body) {
                    return Ok(error);
                }
                if let Err(error) = validate_persisted_text(
                    "memory content",
                    [params.title.as_str(), params.body.as_str()],
                ) {
                    return Ok(error);
                }
                let workspace = match self.workspace_for_root(&params.workspace_root) {
                    Ok(workspace) => workspace,
                    Err(error) => return Ok(error),
                };
                let provenance = self.provenance(params.session_id);
                let input = NewMemory {
                    workspace_id: workspace.id,
                    kind: params.kind.into(),
                    title: params.title,
                    body: params.body,
                    source: MemorySource::Agent,
                    source_client: provenance.source_client,
                    session_id: provenance.session_id,
                    pinned: false,
                    idempotency_key: params.idempotency_key,
                    links: params
                        .links
                        .unwrap_or_default()
                        .into_iter()
                        .map(Into::into)
                        .collect(),
                };
                match self.store.remember(input) {
                    Ok(record) => Ok(structured(record)),
                    Err(error) => Ok(memory_error(error)),
                }
            }
            "revise_memory" => {
                let params = parse_arguments::<ReviseMemoryParams>(arguments)?;
                if let Some(title) = params.title.as_deref() {
                    if let Err(error) = validate_title("title", title) {
                        return Ok(error);
                    }
                }
                if let Some(body) = params.body.as_deref() {
                    if let Err(error) = validate_large_text("body", body) {
                        return Ok(error);
                    }
                }
                let current = match self.store.memory(&params.id) {
                    Ok(record) => record,
                    Err(error) => return Ok(memory_error(error)),
                };
                if let Err(error) = self.enforce_record_scope(&current) {
                    return Ok(error);
                }
                let provenance = self.provenance(None);
                let revision = MemoryRevision {
                    id: params.id,
                    expected_version: params.expected_version,
                    kind: params.kind.map(Into::into).unwrap_or(current.kind),
                    title: params.title.unwrap_or(current.title),
                    body: params.body.unwrap_or(current.body),
                    pinned: params.pinned.unwrap_or(current.pinned),
                    source_client: provenance.source_client,
                    session_id: provenance.session_id,
                    links: current.links,
                };
                if let Err(error) = validate_persisted_text(
                    "memory content",
                    [revision.title.as_str(), revision.body.as_str()],
                ) {
                    return Ok(error);
                }
                match self.store.revise(revision) {
                    Ok(record) => Ok(structured(record)),
                    Err(error) => Ok(memory_error(error)),
                }
            }
            "forget_memory" => {
                let params = parse_arguments::<ForgetMemoryParams>(arguments)?;
                // Tombstones have no reason field; accept the contract hint without
                // inventing storage outside MemoryStore's existing model.
                let _reason = params.reason;
                let result = match self.restricted_workspace_id.as_deref() {
                    Some(workspace_id) => self.store.forget_in_workspace(
                        &params.id,
                        params.expected_version,
                        workspace_id,
                        &self.client,
                        None,
                    ),
                    None => {
                        self.store
                            .forget(&params.id, params.expected_version, &self.client, None)
                    }
                };
                match result {
                    Ok(tombstone) => Ok(structured(tombstone)),
                    Err(error) => Ok(memory_error(error)),
                }
            }
            "checkpoint" => {
                let params = parse_arguments::<CheckpointParams>(arguments)?;
                if let Err(error) = validate_large_text("summary", &params.summary) {
                    return Ok(error);
                }
                let decisions = params.decisions.unwrap_or_default();
                let next_actions = params.next_actions.unwrap_or_default();
                let changed_paths = params.changed_paths.unwrap_or_default();
                if let Err(error) =
                    validate_checkpoint_items("decisions", &decisions, 2_000, 16 * 1024)
                {
                    return Ok(error);
                }
                if let Err(error) = validate_next_actions(&next_actions) {
                    return Ok(error);
                }
                if let Err(error) =
                    validate_checkpoint_items("changedPaths", &changed_paths, 4_096, 64 * 1024)
                {
                    return Ok(error);
                }
                if let Err(error) = validate_persisted_text(
                    "checkpoint content",
                    std::iter::once(params.summary.as_str())
                        .chain(decisions.iter().map(String::as_str))
                        .chain(next_actions.iter().map(String::as_str))
                        .chain(changed_paths.iter().map(String::as_str)),
                ) {
                    return Ok(error);
                }
                let workspace = match self.workspace_for_root(&params.workspace_root) {
                    Ok(workspace) => workspace,
                    Err(error) => return Ok(error),
                };
                let provenance = self.provenance(params.session_id);
                let input = NewCheckpoint {
                    workspace_id: workspace.id,
                    summary: params.summary,
                    decisions,
                    next_actions,
                    changed_paths,
                    source: MemorySource::Agent,
                    source_client: provenance.source_client,
                    session_id: provenance.session_id,
                    idempotency_key: params.idempotency_key,
                };
                match self.store.checkpoint(input) {
                    Ok(checkpoint) => Ok(structured(checkpoint)),
                    Err(error) => Ok(memory_error(error)),
                }
            }
            name => Err(ErrorData::invalid_params(
                format!("unknown tool: {name}"),
                Some(json!({ "type": "unknown_tool", "tool": name })),
            )),
        }
    }

    fn workspace_for_root(&self, root: &str) -> Result<Workspace, CallToolResult> {
        let workspace = match self.store.resolve_workspace(root) {
            Ok(workspace) => workspace,
            Err(MemoryError::WorkspaceNotRegistered(_)) | Err(MemoryError::Io(_)) => {
                return Err(tool_error(
                    "workspace_not_registered",
                    &format!("workspace is not registered in Kodade: {root}"),
                    json!({ "workspaceRoot": root }),
                ));
            }
            Err(error) => return Err(memory_error(error)),
        };
        if self
            .restricted_workspace_id
            .as_ref()
            .is_some_and(|allowed| allowed != &workspace.id)
        {
            return Err(tool_error(
                "workspace_restricted",
                "workspace is outside the root allowed by --workspace",
                json!({ "workspaceRoot": root }),
            ));
        }
        Ok(workspace)
    }

    fn enforce_record_scope(&self, record: &MemoryRecord) -> Result<(), CallToolResult> {
        if self
            .restricted_workspace_id
            .as_ref()
            .is_some_and(|allowed| allowed != &record.workspace_id)
        {
            return Err(tool_error(
                "workspace_restricted",
                "memory is outside the root allowed by --workspace",
                json!({ "id": record.id }),
            ));
        }
        Ok(())
    }

    fn provenance(&self, session_id: Option<String>) -> MutationProvenance {
        MutationProvenance {
            source_client: self.client.clone(),
            session_id,
        }
    }
}

fn tool<T: JsonSchema + 'static>(
    name: &'static str,
    description: &'static str,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
) -> Tool {
    Tool::new(
        name,
        description,
        schema_for_input::<T>().expect("KödMCP tool parameter schema is an object"),
    )
    .with_annotations(
        ToolAnnotations::new()
            .read_only(read_only)
            .destructive(destructive)
            .idempotent(idempotent)
            .open_world(false),
    )
}

impl ServerHandler for KodadeMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_prompts()
                .build(),
        )
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
        .with_instructions(KODADE_WORKFLOW_INSTRUCTIONS)
        .with_server_info(
            Implementation::new("kodade-mcp", env!("CARGO_PKG_VERSION"))
                .with_title("KödMCP")
                .with_description("Local project memory from KödMem"),
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let result = ListToolsResult::with_all_items(self.tools());
        Ok(if uses_cache_metadata(&context) {
            result.with_ttl_ms(0).with_cache_scope(CacheScope::Private)
        } else {
            result
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let server = self.clone();
        tokio::task::spawn_blocking(move || server.call_tool_sync(request))
            .await
            .map_err(|error| {
                ErrorData::internal_error(
                    format!("KödMCP memory worker failed: {error}"),
                    Some(json!({ "type": "worker_failed" })),
                )
            })?
            .map(Into::into)
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        let result = ListPromptsResult::with_all_items(vec![Prompt::new(
            "kodade_workflow",
            Some("How to use KödMem effectively during an agent session."),
            None,
        )]);
        Ok(if uses_cache_metadata(&context) {
            result.with_ttl_ms(0).with_cache_scope(CacheScope::Private)
        } else {
            result
        })
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        if request.name != "kodade_workflow" {
            return Err(ErrorData::invalid_params(
                format!("unknown prompt: {}", request.name),
                Some(json!({ "type": "unknown_prompt", "prompt": request.name })),
            ));
        }
        Ok(GetPromptResult::new(vec![PromptMessage::new_text(
            Role::User,
            KODADE_WORKFLOW_INSTRUCTIONS,
        )])
        .with_description("A concise workflow for using KödMem safely and effectively.")
        .into())
    }
}

fn uses_cache_metadata(context: &RequestContext<RoleServer>) -> bool {
    context
        .protocol_version()
        .is_some_and(|version| version.as_str() >= ProtocolVersion::V_2026_07_28.as_str())
}

pub async fn serve(config: Config) -> Result<(), String> {
    let server = KodadeMcp::open(config)?;
    let service = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|error| error.to_string())?;
    service.waiting().await.map_err(|error| error.to_string())?;
    Ok(())
}

fn is_write_tool(name: &str) -> bool {
    matches!(
        name,
        "remember" | "revise_memory" | "forget_memory" | "checkpoint"
    )
}

fn parse_arguments<T: DeserializeOwned>(
    arguments: serde_json::Map<String, Value>,
) -> Result<T, ErrorData> {
    serde_json::from_value(Value::Object(arguments)).map_err(|error| {
        ErrorData::invalid_params(
            format!("invalid tool arguments: {error}"),
            Some(json!({ "type": "invalid_arguments" })),
        )
    })
}

fn structured(value: impl Serialize) -> CallToolResult {
    match serde_json::to_value(value) {
        Ok(value) => CallToolResult::structured(value),
        Err(error) => tool_error(
            "serialization_failed",
            &format!("failed to serialize KödMem result: {error}"),
            Value::Null,
        ),
    }
}

fn tool_error(kind: &str, message: &str, details: Value) -> CallToolResult {
    let mut payload = json!({ "type": kind, "message": message });
    if let (Some(payload), Some(details)) = (payload.as_object_mut(), details.as_object()) {
        for (key, value) in details {
            payload.insert(key.clone(), value.clone());
        }
    }
    CallToolResult::structured_error(payload)
}

fn memory_error(error: MemoryError) -> CallToolResult {
    let message = error.to_string();
    match error {
        MemoryError::WorkspaceNotRegistered(root) => tool_error(
            "workspace_not_registered",
            &message,
            json!({ "workspaceRoot": root }),
        ),
        MemoryError::WorkspaceRestricted(id) => {
            tool_error("workspace_restricted", &message, json!({ "id": id }))
        }
        MemoryError::VersionConflict { expected, actual } => tool_error(
            "version_conflict",
            &message,
            json!({ "expectedVersion": expected, "currentVersion": actual }),
        ),
        MemoryError::NotFound(id) => tool_error("memory_not_found", &message, json!({ "id": id })),
        MemoryError::InvalidInput(_) => tool_error("invalid_input", &message, Value::Null),
        MemoryError::Database(_)
        | MemoryError::Io(_)
        | MemoryError::Json(_)
        | MemoryError::CorruptDatabase(_) => tool_error("store_error", &message, Value::Null),
    }
}

fn validate_title(field: &str, value: &str) -> Result<(), CallToolResult> {
    if value.chars().count() > MEMORY_TITLE_LIMIT {
        return Err(tool_error(
            "size_limit",
            &format!("title cannot exceed {MEMORY_TITLE_LIMIT} characters"),
            json!({ "field": field, "maxCharacters": MEMORY_TITLE_LIMIT }),
        ));
    }
    validate_secret(field, value)
}

fn validate_large_text(field: &str, value: &str) -> Result<(), CallToolResult> {
    if value.len() > 64 * 1024 {
        return Err(tool_error(
            "size_limit",
            &format!("{field} cannot exceed 64 KiB"),
            json!({ "field": field, "maxBytes": 64 * 1024 }),
        ));
    }
    validate_secret(field, value)
}

fn validate_secret(field: &str, value: &str) -> Result<(), CallToolResult> {
    if let Some(kind) = secret_scan::detect(value) {
        return Err(tool_error(
            "secret_detected",
            &format!("{field} contains a rejected secret pattern; nothing was stored"),
            json!({ "field": field, "pattern": kind.as_str() }),
        ));
    }
    Ok(())
}

fn validate_persisted_text<'a>(
    field: &str,
    values: impl IntoIterator<Item = &'a str>,
) -> Result<(), CallToolResult> {
    // One tool call is one persistence boundary, so scan across all of its
    // text fields. Secrets split across separate calls remain out of scope.
    let mut combined = String::new();
    for (index, value) in values.into_iter().enumerate() {
        if index > 0 {
            combined.push('\n');
        }
        combined.push_str(value);
    }
    validate_secret(field, &combined)
}

fn validate_next_actions(next_actions: &[String]) -> Result<(), CallToolResult> {
    validate_checkpoint_items("nextActions", next_actions, 2_000, 16 * 1024)
}

fn validate_checkpoint_items(
    field: &str,
    items: &[String],
    item_character_limit: usize,
    aggregate_byte_limit: usize,
) -> Result<(), CallToolResult> {
    for (index, item) in items.iter().enumerate() {
        if item.chars().count() > item_character_limit {
            return Err(tool_error(
                "size_limit",
                &format!(
                    "checkpoint.{field} items cannot exceed {item_character_limit} characters"
                ),
                json!({
                    "field": field,
                    "itemIndex": index,
                    "maxCharactersPerItem": item_character_limit
                }),
            ));
        }
    }
    let total_bytes = items.iter().map(String::len).sum::<usize>();
    if total_bytes > aggregate_byte_limit {
        return Err(tool_error(
            "size_limit",
            &format!("checkpoint.{field} exceeds its aggregate size limit"),
            json!({
                "field": field,
                "maxBytes": aggregate_byte_limit
            }),
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetContextParams {
    pub workspace_root: String,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum McpMemoryKind {
    Summary,
    Decision,
    Task,
    Fact,
    Preference,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum McpMemorySource {
    User,
    Kodade,
    Agent,
}

impl From<McpMemoryKind> for MemoryKind {
    fn from(value: McpMemoryKind) -> Self {
        match value {
            McpMemoryKind::Summary => Self::Summary,
            McpMemoryKind::Decision => Self::Decision,
            McpMemoryKind::Task => Self::Task,
            McpMemoryKind::Fact => Self::Fact,
            McpMemoryKind::Preference => Self::Preference,
        }
    }
}

impl From<McpMemorySource> for MemorySource {
    fn from(value: McpMemorySource) -> Self {
        match value {
            McpMemorySource::User => Self::User,
            McpMemorySource::Kodade => Self::Kodade,
            McpMemorySource::Agent => Self::Agent,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchMemoriesParams {
    pub workspace_root: String,
    pub query: String,
    pub kinds: Option<Vec<McpMemoryKind>>,
    pub sources: Option<Vec<McpMemorySource>>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetMemoryParams {
    pub workspace_root: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkParams {
    pub target_id: String,
    pub relation: String,
}

impl From<LinkParams> for MemoryLink {
    fn from(value: LinkParams) -> Self {
        Self {
            target_id: value.target_id,
            relation: value.relation,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RememberParams {
    pub workspace_root: String,
    pub kind: McpMemoryKind,
    pub title: String,
    pub body: String,
    pub idempotency_key: Option<String>,
    pub session_id: Option<String>,
    pub links: Option<Vec<LinkParams>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviseMemoryParams {
    pub id: String,
    pub expected_version: u64,
    pub title: Option<String>,
    pub body: Option<String>,
    pub kind: Option<McpMemoryKind>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForgetMemoryParams {
    pub id: String,
    pub expected_version: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointParams {
    pub workspace_root: String,
    pub summary: String,
    pub decisions: Option<Vec<String>>,
    pub next_actions: Option<Vec<String>>,
    pub changed_paths: Option<Vec<String>>,
    pub session_id: Option<String>,
    pub idempotency_key: Option<String>,
}
