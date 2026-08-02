use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Request as AxumRequest, State};
use axum::http::{
    header::{CONTENT_TYPE, ORIGIN},
    HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive};
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tower_http::cors::{AllowOrigin, CorsLayer};

use super::engine::{
    ChatDelta, ChatMessage, EngineChatRequest, EngineError, EngineErrorKind, EngineRegistry,
    LoadParams, SamplingParams,
};

static NEXT_COMPLETION_ID: AtomicU64 = AtomicU64::new(1);
const MAX_KOD_GRAMMAR_BYTES: usize = 128 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<EngineRegistry>,
    shutdown: watch::Sender<bool>,
}

impl AppState {
    pub fn new(registry: Arc<EngineRegistry>) -> Self {
        let (shutdown, _) = watch::channel(false);
        Self { registry, shutdown }
    }

    pub fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    fn request_shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
}

#[derive(Debug, Deserialize)]
struct ChatCompletionRequest {
    #[serde(default)]
    model: Option<String>,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    top_p: Option<f32>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    seed: Option<u32>,
    #[serde(default)]
    kod_grammar: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoadRequest {
    path: std::path::PathBuf,
    #[serde(default)]
    ctx: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct UnloadRequest {
    id: String,
}

#[derive(Debug, Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    message: String,
    r#type: &'static str,
}

struct ApiError(EngineError);

impl From<EngineError> for ApiError {
    fn from(error: EngineError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0.kind {
            EngineErrorKind::InvalidRequest | EngineErrorKind::Unsupported => {
                StatusCode::BAD_REQUEST
            }
            EngineErrorKind::NotFound => StatusCode::NOT_FOUND,
            EngineErrorKind::Conflict => StatusCode::CONFLICT,
            EngineErrorKind::InsufficientMemory => StatusCode::UNPROCESSABLE_ENTITY,
            EngineErrorKind::Load | EngineErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let error_type = match self.0.kind {
            EngineErrorKind::InsufficientMemory => "insufficient_memory",
            EngineErrorKind::Load => "model_load_error",
            _ => "invalid_request_error",
        };
        (
            status,
            Json(ErrorEnvelope {
                error: ErrorBody {
                    message: self.0.message,
                    r#type: error_type,
                },
            }),
        )
            .into_response()
    }
}

pub fn router(state: AppState) -> Router {
    // There is intentionally no pairing auth in M14a: the CLI refuses every
    // non-loopback bind, so the spike is reachable only from this machine.
    Router::new()
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/kod/load", post(load_model))
        .route("/kod/unload", post(unload_model))
        .route("/kod/shutdown", post(shutdown))
        .route("/kod/health", get(health))
        .route("/kod/capabilities", get(capabilities))
        .route("/kod/memory", get(memory_report))
        // CORS governs browser response access, not whether a cross-origin
        // request reaches loopback. Reject disallowed POST origins at the
        // request boundary before any mutating handler runs.
        .route_layer(middleware::from_fn(reject_disallowed_post_origins))
        // The desktop webview talks directly to this loopback HTTP surface so
        // chat never crosses IPC. Keep that convenience narrow: no wildcard
        // CORS and no LAN bind escape hatch.
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin, _parts| {
                    allowed_origin(origin)
                }))
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([CONTENT_TYPE, HeaderName::from_static("x-kodade-modeld")]),
        )
        .with_state(state)
}

fn allowed_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "http://localhost:1420"
}

async fn reject_disallowed_post_origins(request: AxumRequest, next: Next) -> Response {
    if request.method() == Method::POST {
        if request
            .headers()
            .get(ORIGIN)
            .is_some_and(|origin| !allowed_origin(origin))
        {
            return StatusCode::FORBIDDEN.into_response();
        }

        // Non-browser callers may omit Origin, so JSON control-plane requests
        // remain supported. A bodyless/form "simple" POST has neither JSON nor
        // the daemon header and is rejected before it can reach any handler.
        let is_json = request
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json"));
        let is_modeld_client = request
            .headers()
            .get("x-kodade-modeld")
            .and_then(|value| value.to_str().ok())
            == Some("1");
        if request.headers().get(ORIGIN).is_none() && !is_json && !is_modeld_client {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    next.run(request).await
}

async fn list_models(State(state): State<AppState>) -> Json<Value> {
    let data: Vec<Value> = state
        .registry
        .models()
        .into_iter()
        .map(|model| {
            json!({
                "id": model.id,
                "object": "model",
                "created": 0,
                "owned_by": "kodade-modeld",
                "kod": {
                    "ctx": model.metadata.context_length,
                    "ctx_advisory": model.metadata.context_length_is_advisory,
                    "loaded": true,
                    "quant": model.metadata.quant,
                }
            })
        })
        .collect();
    Json(json!({ "object": "list", "data": data }))
}

async fn capabilities(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::to_value(state.registry.capabilities()).unwrap())
}

async fn memory_report(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::to_value(state.registry.memory_report()).unwrap())
}

async fn health() -> Json<Value> {
    Json(json!({ "service": "kodade-modeld", "protocol": 1 }))
}

async fn load_model(
    State(state): State<AppState>,
    Json(request): Json<LoadRequest>,
) -> Result<Json<Value>, ApiError> {
    let registry = state.registry;
    let params = LoadParams {
        context_length: request.ctx.unwrap_or(LoadParams::default().context_length),
    };
    let model = tokio::task::spawn_blocking(move || registry.load(request.path, params))
        .await
        .map_err(|error| EngineError::internal(format!("model load task failed: {error}")))??;
    Ok(Json(serde_json::to_value(model).unwrap()))
}

async fn unload_model(
    State(state): State<AppState>,
    Json(request): Json<UnloadRequest>,
) -> Result<Json<Value>, ApiError> {
    let registry = state.registry;
    let id = request.id;
    let response_id = id.clone();
    tokio::task::spawn_blocking(move || registry.unload(&id))
        .await
        .map_err(|error| EngineError::internal(format!("model unload task failed: {error}")))??;
    Ok(Json(json!({ "unloaded": response_id })))
}

async fn shutdown(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    // This header makes every browser shutdown attempt preflight. It is also
    // checked server-side so a bodyless simple POST cannot trigger lifecycle
    // teardown even from a local process with no Origin header.
    if headers
        .get("x-kodade-modeld")
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return Err(StatusCode::FORBIDDEN);
    }
    state.request_shutdown();
    Ok(Json(json!({ "stopping": true })))
}

async fn chat_completions(
    State(state): State<AppState>,
    Json(request): Json<ChatCompletionRequest>,
) -> Result<Response, ApiError> {
    if request.messages.is_empty() {
        return Err(EngineError::invalid("messages must not be empty").into());
    }
    if request
        .kod_grammar
        .as_ref()
        .is_some_and(|grammar| grammar.len() > MAX_KOD_GRAMMAR_BYTES)
    {
        return Err(EngineError::invalid("kod_grammar must not exceed 128 KiB").into());
    }
    let completion_id = format!(
        "chatcmpl-kod-{}",
        NEXT_COMPLETION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let requested_model = request.model.clone();
    let response_model = requested_model
        .clone()
        .or_else(|| {
            state
                .registry
                .models()
                .first()
                .map(|model| model.id.clone())
        })
        .unwrap_or_default();
    let mut sampling = SamplingParams::default();
    if let Some(temperature) = request.temperature {
        sampling.temperature = temperature;
    }
    if let Some(top_p) = request.top_p {
        sampling.top_p = top_p;
    }
    if let Some(max_tokens) = request.max_tokens {
        sampling.max_tokens = max_tokens;
    }
    if let Some(seed) = request.seed {
        sampling.seed = seed;
    }
    let receiver = state.registry.chat_stream(EngineChatRequest {
        model: requested_model.clone(),
        messages: request.messages,
        sampling,
        grammar: request.kod_grammar,
    })?;

    if request.stream {
        let id = completion_id.clone();
        let model = response_model;
        let mut first = true;
        let events = ReceiverStream::new(receiver).map(move |result| {
            let payload = match result {
                Ok(delta) => {
                    let is_first = std::mem::replace(&mut first, false);
                    stream_chunk(&id, &model, created, delta, is_first)
                }
                Err(error) => {
                    json!({ "error": { "message": error.message, "type": "server_error" } })
                }
            };
            Ok::<Event, Infallible>(Event::default().data(payload.to_string()))
        });
        let done = tokio_stream::once(Ok::<Event, Infallible>(Event::default().data("[DONE]")));
        return Ok(Sse::new(events.chain(done))
            .keep_alive(KeepAlive::default())
            .into_response());
    }

    let mut receiver = receiver;
    let mut content = String::new();
    let mut finish_reason = "stop".to_string();
    let mut completion_tokens = 0;
    let mut tokens_per_second = None;
    while let Some(result) = receiver.recv().await {
        let delta = result?;
        content.push_str(&delta.content);
        if let Some(reason) = delta.finish_reason {
            finish_reason = reason;
        }
        if let Some(tokens) = delta.completion_tokens {
            completion_tokens = tokens;
        }
        if delta.tokens_per_second.is_some() {
            tokens_per_second = delta.tokens_per_second;
        }
    }
    Ok(Json(json!({
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": response_model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": finish_reason,
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": completion_tokens,
            "total_tokens": completion_tokens,
        },
        "kod": { "tokens_per_second": tokens_per_second }
    }))
    .into_response())
}

fn stream_chunk(id: &str, model: &str, created: u64, delta: ChatDelta, first: bool) -> Value {
    let (body, finish_reason) = match delta.finish_reason {
        Some(reason) if first => (json!({ "role": "assistant" }), Some(reason)),
        Some(reason) => (json!({}), Some(reason)),
        None if first => (
            json!({ "role": "assistant", "content": delta.content }),
            None,
        ),
        None => (json!({ "content": delta.content }), None),
    };
    json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": body,
            "finish_reason": finish_reason,
        }],
        "kod": {
            "completion_tokens": delta.completion_tokens,
            "tokens_per_second": delta.tokens_per_second,
        }
    })
}

#[cfg(test)]
mod cors_tests {
    use axum::body::to_bytes;
    use axum::http::HeaderValue;
    use axum::response::IntoResponse;

    use super::{allowed_origin, ApiError};
    use crate::modeld::EngineError;

    #[test]
    fn only_allows_the_desktop_webview_and_local_dev_origins() {
        assert!(allowed_origin(&HeaderValue::from_static(
            "tauri://localhost"
        )));
        assert!(allowed_origin(&HeaderValue::from_static(
            "http://tauri.localhost"
        )));
        assert!(allowed_origin(&HeaderValue::from_static(
            "http://localhost:1420"
        )));
        assert!(!allowed_origin(&HeaderValue::from_static(
            "http://localhost:5173"
        )));
        assert!(!allowed_origin(&HeaderValue::from_static(
            "http://localhost"
        )));
        assert!(!allowed_origin(&HeaderValue::from_static(
            "https://localhost:1420"
        )));
        assert!(!allowed_origin(&HeaderValue::from_static(
            "https://example.test"
        )));
    }

    #[tokio::test]
    async fn load_failures_have_a_distinct_api_error_type() {
        let response = ApiError(EngineError::load("weights failed to load")).into_response();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(status, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"]["type"], "model_load_error");
    }
}
