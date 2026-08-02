use std::path::Path;
#[cfg(feature = "modeld")]
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use kodade_lib::modeld::{
    router, AppState, Capabilities, ChatDelta, EngineChatRequest, EngineError, EngineRegistry,
    InferenceEngine, LoadParams, MemoryReport, ModelFormat, ModelHandle, ModelMetadata, Supports,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tower::ServiceExt;

#[derive(Default)]
struct TestEngine {
    load_count: AtomicUsize,
    estimated_footprint: u64,
    ram_budget: Option<u64>,
    load_started: Option<Arc<Barrier>>,
    load_release: Option<Arc<Barrier>>,
    loaded: Mutex<Option<ModelHandle>>,
    requests: Mutex<Vec<EngineChatRequest>>,
}

impl TestEngine {
    fn with_blocked_load(load_started: Arc<Barrier>, load_release: Arc<Barrier>) -> Self {
        Self {
            load_started: Some(load_started),
            load_release: Some(load_release),
            ..Self::default()
        }
    }
}

impl InferenceEngine for TestEngine {
    fn name(&self) -> &'static str {
        "test"
    }

    fn supports(&self, format: ModelFormat) -> bool {
        format == ModelFormat::Gguf
    }

    fn load(&self, path: &Path, params: LoadParams) -> Result<ModelHandle, EngineError> {
        self.load_count.fetch_add(1, Ordering::SeqCst);
        if let Some(load_started) = &self.load_started {
            load_started.wait();
            self.load_release.as_ref().unwrap().wait();
        }
        let handle = ModelHandle {
            id: "shared-model".into(),
            name: "Shared Model".into(),
            path: path.to_path_buf(),
            metadata: ModelMetadata {
                context_length: params.context_length,
                context_length_is_advisory: false,
                quant: Some("Q8_0".into()),
                architecture: Some("qwen2".into()),
            },
            footprint_bytes: 512,
        };
        *self.loaded.lock().unwrap() = Some(handle.clone());
        Ok(handle)
    }

    fn estimate_load_footprint(
        &self,
        _path: &Path,
        _params: LoadParams,
    ) -> Result<u64, EngineError> {
        Ok(if self.estimated_footprint == 0 {
            512
        } else {
            self.estimated_footprint
        })
    }

    fn unload(&self, id: &str) -> Result<(), EngineError> {
        let mut loaded = self.loaded.lock().unwrap();
        match loaded.as_ref() {
            Some(model) if model.id == id => {
                *loaded = None;
                Ok(())
            }
            _ => Err(EngineError::not_found(format!("model {id} is not loaded"))),
        }
    }

    fn chat_stream(
        &self,
        request: EngineChatRequest,
    ) -> Result<mpsc::Receiver<Result<ChatDelta, EngineError>>, EngineError> {
        if self.loaded.lock().unwrap().is_none() {
            return Err(EngineError::conflict("no model is loaded"));
        }
        self.requests.lock().unwrap().push(request.clone());
        let content = request.messages.last().unwrap().content.clone();
        let (tx, rx) = mpsc::channel(4);
        tokio::spawn(async move {
            tx.send(Ok(ChatDelta::content(content))).await.unwrap();
            tx.send(Ok(ChatDelta::finished("stop", 1, Some(100.0))))
                .await
                .unwrap();
        });
        Ok(rx)
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            engine: "test".into(),
            formats: vec![ModelFormat::Gguf],
            supports: Supports {
                tools: false,
                grammar: true,
                constrained: true,
                embeddings: false,
            },
            ram_budget_bytes: self.ram_budget.or(Some(1_024)),
        }
    }

    fn memory_report(&self) -> MemoryReport {
        let loaded_models = self.loaded.lock().unwrap().clone().into_iter().collect();
        MemoryReport {
            total_ram_bytes: Some(2_048),
            ram_budget_bytes: self.ram_budget.or(Some(1_024)),
            loaded_bytes: 512,
            loaded_models,
        }
    }
}

#[tokio::test]
async fn rejects_a_load_that_cannot_fit_the_daemon_ram_budget() {
    let engine = Arc::new(TestEngine {
        estimated_footprint: 2_048,
        ram_budget: Some(1_024),
        ..TestEngine::default()
    });
    let registry = Arc::new(EngineRegistry::new(vec![engine.clone()]).unwrap());
    let app = router(AppState::new(registry));

    let response = app
        .oneshot(json_request(
            "/kod/load",
            json!({"path": "/models/too-large.gguf"}),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await;
    assert_eq!(body["error"]["type"], "insufficient_memory");
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("RAM budget"));
    assert_eq!(engine.load_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn loads_when_the_estimated_footprint_fits_the_daemon_ram_budget() {
    let engine = Arc::new(TestEngine {
        estimated_footprint: 512,
        ram_budget: Some(1_024),
        ..TestEngine::default()
    });
    let registry = Arc::new(EngineRegistry::new(vec![engine.clone()]).unwrap());
    let app = router(AppState::new(registry));

    let response = app
        .oneshot(json_request(
            "/kod/load",
            json!({"path": "/models/fits.gguf"}),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(engine.load_count.load(Ordering::SeqCst), 1);
}

async fn response_json(response: axum::response::Response) -> Value {
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn daemon_health_has_a_fixed_identity_marker() {
    let engine = Arc::new(TestEngine::default());
    let app = router(AppState::new(Arc::new(
        EngineRegistry::new(vec![engine]).unwrap(),
    )));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/kod/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_json(response).await,
        json!({"service": "kodade-modeld", "protocol": 1})
    );
}

#[tokio::test]
async fn hostile_simple_posts_are_rejected_before_all_post_handlers() {
    let engine = Arc::new(TestEngine::default());
    let app = router(AppState::new(Arc::new(
        EngineRegistry::new(vec![engine]).unwrap(),
    )));

    for uri in [
        "/kod/shutdown",
        "/kod/load",
        "/kod/unload",
        "/v1/chat/completions",
    ] {
        let no_origin = Request::builder()
            .method("POST")
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(no_origin).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "no Origin: {uri}");

        let hostile_origin = Request::builder()
            .method("POST")
            .uri(uri)
            .header("origin", "https://hostile.example")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(hostile_origin).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "hostile Origin: {uri}"
        );
    }
}

#[tokio::test]
async fn shutdown_requires_the_preflight_forcing_daemon_header() {
    let engine = Arc::new(TestEngine::default());
    let app = router(AppState::new(Arc::new(
        EngineRegistry::new(vec![engine]).unwrap(),
    )));

    let rejected = Request::builder()
        .method("POST")
        .uri("/kod/shutdown")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(rejected).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );

    let accepted = Request::builder()
        .method("POST")
        .uri("/kod/shutdown")
        .header("x-kodade-modeld", "1")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.oneshot(accepted).await.unwrap().status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn concurrent_http_clients_share_one_resident_model() {
    let load_started = Arc::new(Barrier::new(2));
    let load_release = Arc::new(Barrier::new(2));
    let engine = Arc::new(TestEngine::with_blocked_load(
        load_started.clone(),
        load_release.clone(),
    ));
    let registry = Arc::new(EngineRegistry::new(vec![engine.clone()]).unwrap());
    let app = router(AppState::new(registry));

    let load_request = || {
        Request::builder()
            .method("POST")
            .uri("/kod/load")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"path": "/models/shared.gguf", "ctx": 4096}).to_string(),
            ))
            .unwrap()
    };
    let load_race = tokio::spawn({
        let app = app.clone();
        async move {
            tokio::join!(
                app.clone().oneshot(load_request()),
                app.oneshot(load_request())
            )
        }
    });

    tokio::task::spawn_blocking(move || load_started.wait())
        .await
        .unwrap();
    tokio::task::spawn_blocking(move || load_release.wait())
        .await
        .unwrap();

    let (first_load, second_load) = load_race.await.unwrap();
    let first_load = first_load.unwrap();
    let second_load = second_load.unwrap();
    assert_eq!(first_load.status(), StatusCode::OK);
    assert_eq!(second_load.status(), StatusCode::OK);
    assert_eq!(response_json(first_load).await["id"], "shared-model");
    assert_eq!(response_json(second_load).await["id"], "shared-model");
    assert_eq!(engine.load_count.load(Ordering::SeqCst), 1);

    let request = |content: &str| {
        Request::builder()
            .method("POST")
            .uri("/v1/chat/completions")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "model": "shared-model",
                    "messages": [{"role": "user", "content": content}],
                    "stream": false
                })
                .to_string(),
            ))
            .unwrap()
    };

    let (left, right) = tokio::join!(
        app.clone().oneshot(request("client one")),
        app.oneshot(request("client two"))
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left.status(), StatusCode::OK);
    assert_eq!(right.status(), StatusCode::OK);
    assert_eq!(
        response_json(left).await["choices"][0]["message"]["content"],
        "client one"
    );
    assert_eq!(
        response_json(right).await["choices"][0]["message"]["content"],
        "client two"
    );
    assert_eq!(engine.load_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_kod_grammar_larger_than_128_kib() {
    let engine = Arc::new(TestEngine::default());
    let registry = Arc::new(EngineRegistry::new(vec![engine.clone()]).unwrap());
    let app = router(AppState::new(registry));
    let grammar = "x".repeat(128 * 1024 + 1);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "messages": [{"role": "user", "content": "hi"}],
                "kod_grammar": grammar
            })
            .to_string(),
        ))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error = response_json(response).await;
    assert_eq!(error["error"]["type"], "invalid_request_error");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("128 KiB"));
    assert!(engine.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn grammar_and_kod_lifecycle_cross_the_http_seam() {
    let engine = Arc::new(TestEngine::default());
    let registry = Arc::new(EngineRegistry::new(vec![engine.clone()]).unwrap());
    let app = router(AppState::new(registry));

    let load = Request::builder()
        .method("POST")
        .uri("/kod/load")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"path": "/models/qwen.gguf", "ctx": 2048}).to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(load).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let chat = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "messages": [{"role": "user", "content": "yes"}],
                "kod_grammar": r#"root ::= \"yes\""#,
                "stream": true
            })
            .to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(chat).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(body.contains("data: [DONE]"));
    assert_eq!(
        engine.requests.lock().unwrap()[0].grammar.as_deref(),
        Some(r#"root ::= \"yes\""#)
    );

    for uri in [
        "/v1/models",
        "/kod/health",
        "/kod/capabilities",
        "/kod/memory",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
    }

    let unload = Request::builder()
        .method("POST")
        .uri("/kod/unload")
        .header("content-type", "application/json")
        .body(Body::from(json!({"id": "shared-model"}).to_string()))
        .unwrap();
    assert_eq!(app.oneshot(unload).await.unwrap().status(), StatusCode::OK);
}

#[cfg(feature = "modeld")]
#[tokio::test]
async fn real_model_http_smoke() {
    use kodade_lib::modeld::LlamaCppEngine;

    let Some(path) = std::env::var_os("KODADE_TEST_GGUF").map(PathBuf::from) else {
        eprintln!("KODADE_TEST_GGUF unset; skipping real GGUF smoke");
        return;
    };
    assert!(path.is_absolute(), "KODADE_TEST_GGUF must be absolute");
    assert!(path.is_file(), "GGUF does not exist: {}", path.display());

    let engine = Arc::new(LlamaCppEngine::new().expect("initialize llama.cpp"));
    let registry = Arc::new(EngineRegistry::new(vec![engine]).unwrap());
    let app = router(AppState::new(registry));

    let load = json_request("/kod/load", json!({"path": path, "ctx": 2048}));
    let response = app.clone().oneshot(load).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let loaded = response_json(response).await;
    let model_id = loaded["id"].as_str().unwrap().to_string();

    let non_stream = json_request(
        "/v1/chat/completions",
        json!({
            "model": model_id,
            "messages": [{"role": "user", "content": "What is two plus two? Reply in one short sentence."}],
            "temperature": 0.1,
            "max_tokens": 32,
            "stream": false
        }),
    );
    let response = app.clone().oneshot(non_stream).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let non_stream = response_json(response).await;
    let sample = non_stream["choices"][0]["message"]["content"]
        .as_str()
        .unwrap()
        .trim()
        .to_string();
    let tokens_per_second = non_stream["kod"]["tokens_per_second"]
        .as_f64()
        .expect("tokens/s in non-stream response");
    assert!(!sample.is_empty());

    let stream = json_request(
        "/v1/chat/completions",
        json!({
            "model": model_id,
            "messages": [{"role": "user", "content": "Say hello in exactly three words."}],
            "temperature": 0.1,
            "max_tokens": 24,
            "stream": true
        }),
    );
    let response = app.clone().oneshot(stream).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let stream_body = String::from_utf8(body.to_vec()).unwrap();
    assert!(stream_body.contains("data: [DONE]"));
    let (stream_sample, _) = parse_sse_output(&stream_body);
    assert!(!stream_sample.trim().is_empty());

    let grammar = json_request(
        "/v1/chat/completions",
        json!({
            "model": model_id,
            "messages": [{"role": "user", "content": "Return KOD_OK and nothing else."}],
            "temperature": 0.0,
            "max_tokens": 8,
            "kod_grammar": r#"root ::= "KOD_OK""#,
            "stream": false
        }),
    );
    let response = app.oneshot(grammar).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let grammar = response_json(response).await;
    let grammar_sample = grammar["choices"][0]["message"]["content"]
        .as_str()
        .unwrap()
        .trim()
        .to_string();
    assert_eq!(grammar_sample, "KOD_OK");

    println!("KODADE_MODEL_SMOKE_FILE={}", path.display());
    println!("KODADE_MODEL_SMOKE_TOKENS_PER_SECOND={tokens_per_second:.2}");
    println!("KODADE_MODEL_SMOKE_SAMPLE={sample}");
    println!("KODADE_MODEL_SMOKE_STREAM_SAMPLE={}", stream_sample.trim());
    println!("KODADE_MODEL_SMOKE_GRAMMAR={grammar_sample}");
}

fn json_request(uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[cfg(feature = "modeld")]
fn parse_sse_output(body: &str) -> (String, Option<f64>) {
    let mut content = String::new();
    let mut tokens_per_second = None;
    for line in body.lines().filter_map(|line| line.strip_prefix("data: ")) {
        if line == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(line).unwrap();
        if let Some(piece) = event["choices"][0]["delta"]["content"].as_str() {
            content.push_str(piece);
        }
        if let Some(value) = event["kod"]["tokens_per_second"].as_f64() {
            tokens_per_second = Some(value);
        }
    }
    (content, tokens_per_second)
}
