// macOS MLX engine. MLX Python bindings remain outside the Rust process: this
// engine owns a loopback-only `mlx_lm server` child and proxies it through the
// existing daemon transport so callers never discover the sidecar port.

use std::fmt::Write as _;
use std::io::Write;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::engine::{
    model_path_bytes, Capabilities, ChatDelta, DeltaReceiver, EngineChatRequest, EngineError,
    InferenceEngine, LoadParams, MemoryReport, ModelFormat, ModelHandle, ModelMetadata, Supports,
};
use super::{hardware_ram_bytes, ram_budget_bytes};
use crate::process_tree::prepare_spawn;
use crate::shell::ShellEnvironment;

const SIDECAR_HOST: &str = "127.0.0.1";
const SIDECAR_LISTENER_TIMEOUT: Duration = Duration::from_secs(30);
const SIDECAR_LISTENER_POLL: Duration = Duration::from_millis(100);
const SIDECAR_READINESS_TIMEOUT: Duration = Duration::from_secs(120);
const SIDECAR_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const PYTHON_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_STOP_GRACE: Duration = Duration::from_secs(2);
const ERROR_BODY_CAP: u64 = 16 * 1024;

// mlx_lm.server currently exposes no API-key option or Authorization check.
// This exec-style supervisor imports the upstream server in the spawned Python
// process, installs a constant-time bearer check on every method, adopts the
// listener modeld reserved before spawn, and treats stdin EOF as parent death.
// The upstream model loader/server runs on a worker thread so the main thread
// can remain blocked on the liveness pipe without a shell or polling process.
const SIDECAR_SUPERVISOR: &str = r#"
import hmac
import os
import select
import socket
import sys
import threading

import mlx_lm.server as mlx_server

listener_fd = int(sys.argv[1])
sys.argv = ["mlx_lm.server", *sys.argv[2:]]
capability = sys.stdin.buffer.readline().decode("ascii").strip()
if len(capability) != 64:
    os._exit(2)
expected_authorization = "Bearer " + capability

class AuthenticatedHandler(mlx_server.APIHandler):
    def _kodade_authorized(self):
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, expected_authorization)

    def _kodade_reject(self):
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(b'{"error":"unauthorized"}')

    def do_GET(self):
        if not self._kodade_authorized():
            return self._kodade_reject()
        return super().do_GET()

    def do_POST(self):
        if not self._kodade_authorized():
            return self._kodade_reject()
        return super().do_POST()

    def do_OPTIONS(self):
        if not self._kodade_authorized():
            return self._kodade_reject()
        return super().do_OPTIONS()

class InheritedHttpServer(mlx_server.ThreadingHTTPServer):
    def server_bind(self):
        inherited = socket.socket(fileno=listener_fd)
        self.socket.close()
        self.socket = inherited
        self.server_address = inherited.getsockname()
        host, port = self.server_address[:2]
        self.server_name = socket.getfqdn(host)
        self.server_port = port

original_http_server = mlx_server._run_http_server
def authenticated_http_server(host, port, response_generator, *args, **kwargs):
    kwargs["server_class"] = InheritedHttpServer
    kwargs["handler_class"] = AuthenticatedHandler
    return original_http_server(host, port, response_generator, *args, **kwargs)
mlx_server._run_http_server = authenticated_http_server

failed = []
def serve():
    try:
        mlx_server.main()
    except BaseException as error:
        failed.append(error)

server_thread = threading.Thread(target=serve, name="kodade-mlx-server", daemon=True)
server_thread.start()
while server_thread.is_alive():
    readable, _, _ = select.select([sys.stdin.buffer], [], [], 0.25)
    if readable and os.read(sys.stdin.fileno(), 1) == b"":
        os._exit(0)
os._exit(1 if failed else 0)
"#;

#[derive(Clone, Copy, Debug)]
struct ListenerIdentity {
    pid: libc::pid_t,
    started_seconds: u64,
    started_microseconds: u64,
}

struct ManagedProcessGroup {
    child: Child,
    stdin: Option<ChildStdin>,
    pgid: libc::pid_t,
    stopped: bool,
}

struct PendingProcessGroup(Option<ManagedProcessGroup>);

struct LoadedSidecar {
    process: ManagedProcessGroup,
    _reservation: ReservedLoopbackPort,
    port: u16,
    capability: String,
    listener: ListenerIdentity,
    generation: u64,
    handle: ModelHandle,
}

pub struct MlxEngine {
    loaded: Arc<Mutex<Option<LoadedSidecar>>>,
    next_generation: AtomicU64,
}

impl MlxEngine {
    pub fn new() -> Self {
        Self {
            loaded: Arc::new(Mutex::new(None)),
            next_generation: AtomicU64::new(1),
        }
    }

    fn ensure_live_sidecar(&self) -> Result<SidecarEndpoint, EngineError> {
        let mut loaded = self.loaded.lock().unwrap();
        let Some(sidecar) = loaded.as_mut() else {
            // This state can only be reached through the registry after an
            // in-flight proxy observed a sidecar failure. Make it internal so
            // EngineRegistry clears its stale active handle on this request.
            return Err(EngineError::internal(
                "MLX sidecar is unavailable; model unloaded",
            ));
        };
        match sidecar.process.child.try_wait() {
            // mlx_lm advertises the canonical model directory as its model
            // identifier. The daemon's public id is intentionally friendlier
            // (the directory basename), so keep the translation inside this
            // proxy instead of forwarding a client-facing id to the sidecar.
            Ok(None) => {
                if let Err(error) = sidecar.listener.verify(sidecar.port) {
                    let failed = loaded.take().unwrap();
                    drop(loaded);
                    drop(failed);
                    return Err(error);
                }
                Ok(SidecarEndpoint {
                    port: sidecar.port,
                    capability: sidecar.capability.clone(),
                    listener: sidecar.listener,
                    generation: sidecar.generation,
                    model: sidecar.handle.path.to_string_lossy().into_owned(),
                })
            }
            Ok(Some(status)) => {
                let failed = loaded.take().unwrap();
                drop(loaded);
                drop(failed);
                Err(EngineError::internal(format!(
                    "MLX sidecar exited unexpectedly ({status}); model unloaded"
                )))
            }
            Err(error) => {
                let sidecar = loaded.take().unwrap();
                drop(loaded);
                drop(sidecar);
                Err(EngineError::internal(format!(
                    "inspect MLX sidecar: {error}; model unloaded"
                )))
            }
        }
    }
}

#[derive(Clone)]
struct SidecarEndpoint {
    port: u16,
    capability: String,
    listener: ListenerIdentity,
    generation: u64,
    model: String,
}

impl Default for MlxEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl InferenceEngine for MlxEngine {
    fn name(&self) -> &'static str {
        "mlx-lm sidecar"
    }

    fn supports(&self, format: ModelFormat) -> bool {
        format == ModelFormat::Mlx
    }

    fn estimate_load_footprint(
        &self,
        path: &Path,
        _params: LoadParams,
    ) -> Result<u64, EngineError> {
        ensure_mlx_directory(path)?;
        model_path_bytes(path, ModelFormat::Mlx)
    }

    fn load(&self, path: &Path, params: LoadParams) -> Result<ModelHandle, EngineError> {
        ensure_mlx_directory(path)?;
        if self.loaded.lock().unwrap().is_some() {
            return Err(EngineError::conflict(
                "an MLX model is already loaded; unload it before loading another",
            ));
        }
        let path = std::fs::canonicalize(path).map_err(|error| {
            EngineError::invalid(format!(
                "resolve MLX model path {}: {error}",
                path.display()
            ))
        })?;
        let python = ShellEnvironment::current()
            .resolve_executable("python3")
            .ok_or_else(|| {
                EngineError::unsupported(
                    "python3 is required for MLX models; install Python 3 and mlx-lm",
                )
            })?;
        verify_mlx_lm(&python)?;

        let mut reservation = ReservedLoopbackPort::new()?;
        let port = reservation.port();
        let capability = random_capability()?;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let mut pending = spawn_sidecar(&python, &path, &reservation, &capability)?;
        reservation.prevent_future_inheritance()?;
        // The child inherited the exact bound descriptor. Keep modeld's copy
        // for this generation too: modeld never accepts from it, but retaining
        // the descriptor prevents a port takeover even if the child exits in
        // the narrow interval between identity verification and connection.
        let listener =
            wait_for_owned_listener(port, pending.process_mut(), SIDECAR_LISTENER_TIMEOUT)?;
        let endpoint = SidecarEndpoint {
            port,
            capability: capability.clone(),
            listener,
            generation,
            model: path.to_string_lossy().into_owned(),
        };
        readiness_probe(&endpoint, pending.process_mut(), SIDECAR_READINESS_TIMEOUT)?;

        let handle = model_handle(&path, params)?;
        let process = pending.commit();
        let mut loaded = self.loaded.lock().unwrap();
        if loaded.is_some() {
            drop(process);
            return Err(EngineError::conflict(
                "an MLX model was loaded concurrently; unload it before loading another",
            ));
        }
        *loaded = Some(LoadedSidecar {
            process,
            _reservation: reservation,
            port,
            capability,
            listener,
            generation,
            handle: handle.clone(),
        });
        Ok(handle)
    }

    fn unload(&self, id: &str) -> Result<(), EngineError> {
        let sidecar = {
            let mut loaded = self.loaded.lock().unwrap();
            let current = loaded
                .as_ref()
                .ok_or_else(|| EngineError::not_found("no MLX model is loaded"))?;
            if current.handle.id != id {
                return Err(EngineError::not_found(format!("model {id} is not loaded")));
            }
            loaded.take().unwrap()
        };
        drop(sidecar);
        Ok(())
    }

    fn chat_stream(&self, request: EngineChatRequest) -> Result<DeltaReceiver, EngineError> {
        if request.grammar.is_some() {
            return Err(EngineError::unsupported(
                "MLX does not support constrained decoding or GBNF grammars",
            ));
        }
        let endpoint = self.ensure_live_sidecar()?;
        let generation = endpoint.generation;
        let (deltas, receiver) = mpsc::channel(32);
        let loaded = Arc::clone(&self.loaded);
        let worker_deltas = deltas.clone();
        let worker = thread::Builder::new()
            .name("kodade-modeld-mlx-proxy".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| {
                        EngineError::internal(format!("start MLX proxy runtime: {error}"))
                    });
                let result = runtime.and_then(|runtime| {
                    runtime.block_on(proxy_chat_stream(endpoint, request, worker_deltas.clone()))
                });
                if let Err(error) = result {
                    if error.kind == super::engine::EngineErrorKind::Internal {
                        mark_sidecar_unavailable(&loaded, generation);
                    }
                    let _ = worker_deltas.blocking_send(Err(error));
                }
            });
        if let Err(error) = worker {
            // Thread creation failed after generation state was captured. Kill
            // that exact sidecar before the registry observes the terminal
            // internal error and clears its own matching generation.
            mark_sidecar_unavailable(&self.loaded, generation);
            return Err(EngineError::internal(format!(
                "start MLX stream proxy: {error}"
            )));
        }
        Ok(receiver)
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            engine: self.name().to_string(),
            formats: vec![ModelFormat::Mlx],
            supports: Supports {
                tools: false,
                grammar: false,
                constrained: false,
                embeddings: false,
            },
            ram_budget_bytes: ram_budget_bytes(),
        }
    }

    fn memory_report(&self) -> MemoryReport {
        let loaded_models: Vec<ModelHandle> = self
            .loaded
            .lock()
            .unwrap()
            .as_ref()
            .map(|sidecar| vec![sidecar.handle.clone()])
            .unwrap_or_default();
        MemoryReport {
            total_ram_bytes: hardware_ram_bytes(),
            ram_budget_bytes: ram_budget_bytes(),
            loaded_bytes: loaded_models
                .iter()
                .map(|model| model.footprint_bytes)
                .sum(),
            loaded_models,
        }
    }
}

impl Drop for MlxEngine {
    fn drop(&mut self) {
        let sidecar = self.loaded.lock().unwrap().take();
        drop(sidecar);
    }
}

fn ensure_mlx_directory(path: &Path) -> Result<(), EngineError> {
    match ModelFormat::from_path(path)? {
        ModelFormat::Mlx => Ok(()),
        ModelFormat::Gguf => Err(EngineError::unsupported(format!(
            "{} is GGUF, not an MLX model directory",
            path.display()
        ))),
    }
}

fn model_id(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("mlx-model")
        .to_string()
}

fn model_name(path: &Path) -> String {
    model_id(path)
}

fn model_architecture(path: &Path) -> Option<String> {
    let contents = std::fs::read(path.join("config.json")).ok()?;
    let config: Value = serde_json::from_slice(&contents).ok()?;
    config["model_type"]
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            config["architectures"]
                .as_array()?
                .first()?
                .as_str()
                .map(str::to_string)
        })
}

fn model_handle(path: &Path, params: LoadParams) -> Result<ModelHandle, EngineError> {
    Ok(ModelHandle {
        id: model_id(path),
        name: model_name(path),
        path: path.to_path_buf(),
        metadata: ModelMetadata {
            // mlx_lm.server does not expose a context-size control. Preserve
            // the user's request only as advisory metadata instead of claiming
            // the sidecar enforces it.
            context_length: params.context_length,
            context_length_is_advisory: true,
            quant: None,
            architecture: model_architecture(path),
        },
        footprint_bytes: model_path_bytes(path, ModelFormat::Mlx)?,
    })
}

struct ReservedLoopbackPort {
    listener: TcpListener,
    port: u16,
}

impl ReservedLoopbackPort {
    fn new() -> Result<Self, EngineError> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| {
            EngineError::internal(format!("reserve MLX loopback port: {error}"))
        })?;
        let port = listener
            .local_addr()
            .map_err(|error| EngineError::internal(format!("inspect MLX loopback port: {error}")))?
            .port();
        let fd = listener.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 {
            return Err(EngineError::internal(format!(
                "make MLX listener inheritable: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self { listener, port })
    }

    fn port(&self) -> u16 {
        self.port
    }

    fn fd(&self) -> i32 {
        self.listener.as_raw_fd()
    }

    fn prevent_future_inheritance(&mut self) -> Result<(), EngineError> {
        let fd = self.listener.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(EngineError::internal(format!(
                "seal MLX listener inheritance: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(())
    }
}

fn random_capability() -> Result<String, EngineError> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| EngineError::internal(format!("create MLX capability: {error}")))?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut token, "{byte:02x}").unwrap();
    }
    Ok(token)
}

fn sidecar_args(model: &Path, reservation: &ReservedLoopbackPort) -> Vec<String> {
    // Keep the fixed host literal in one constructor so neither a model path
    // nor a future caller can widen the sidecar's network exposure.
    vec![
        "-c".into(),
        SIDECAR_SUPERVISOR.into(),
        reservation.fd().to_string(),
        "--host".into(),
        SIDECAR_HOST.into(),
        "--port".into(),
        reservation.port().to_string(),
        "--model".into(),
        model.to_string_lossy().into_owned(),
    ]
}

fn spawn_sidecar(
    python: &Path,
    model: &Path,
    reservation: &ReservedLoopbackPort,
    capability: &str,
) -> Result<PendingProcessGroup, EngineError> {
    let mut command = Command::new(python);
    command
        .args(sidecar_args(model, reservation))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_process_group(&mut command);
    prepare_spawn().map_err(|error| {
        EngineError::internal(format!("prepare MLX sidecar process tree: {error}"))
    })?;
    let child = command.spawn().map_err(|error| {
        EngineError::internal(format!(
            "start MLX sidecar with {}: {error}",
            python.display()
        ))
    })?;
    let mut pending = PendingProcessGroup::new(child);
    let stdin = pending
        .process_mut()
        .stdin
        .as_mut()
        .ok_or_else(|| EngineError::internal("MLX sidecar liveness pipe is unavailable"))?;
    stdin
        .write_all(format!("{capability}\n").as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|error| EngineError::internal(format!("initialize MLX capability: {error}")))?;
    Ok(pending)
}

fn verify_mlx_lm(python: &Path) -> Result<(), EngineError> {
    let mut command = Command::new(python);
    command
        .args(["-c", "import mlx_lm"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_process_group(&mut command);
    prepare_spawn()
        .map_err(|error| EngineError::internal(format!("prepare python3 probe: {error}")))?;
    let child = command
        .spawn()
        .map_err(|error| EngineError::internal(format!("start python3 probe: {error}")))?;
    let mut process = ManagedProcessGroup::new(child);
    let started = Instant::now();
    loop {
        match process.child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                return Err(EngineError::unsupported(
                    "mlx-lm not installed; install it with `pip install mlx-lm`",
                ));
            }
            Ok(None) if started.elapsed() < PYTHON_PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                return Err(EngineError::internal(
                    "python3 timed out while checking mlx-lm installation",
                ));
            }
            Err(error) => {
                return Err(EngineError::internal(format!(
                    "inspect python3 mlx-lm probe: {error}"
                )));
            }
        }
    }
}

fn wait_for_owned_listener(
    port: u16,
    process: &mut ManagedProcessGroup,
    timeout: Duration,
) -> Result<ListenerIdentity, EngineError> {
    let started = Instant::now();
    loop {
        if let Some(status) = process
            .child
            .try_wait()
            .map_err(|error| EngineError::load(format!("inspect MLX sidecar: {error}")))?
        {
            return Err(EngineError::load(format!(
                "MLX sidecar exited before binding its listener ({status})"
            )));
        }
        if let Some(identity) = ListenerIdentity::capture(process.child.id(), port)? {
            return Ok(identity);
        }
        if TcpStream::connect_timeout(
            &format!("{SIDECAR_HOST}:{port}").parse().unwrap(),
            Duration::from_millis(50),
        )
        .is_ok()
        {
            return Err(EngineError::load(
                "refusing MLX listener: the reserved port is not owned by the spawned sidecar",
            ));
        }
        if started.elapsed() >= timeout {
            return Err(EngineError::load(
                "MLX sidecar did not bind its authenticated loopback listener before timeout",
            ));
        }
        thread::sleep(SIDECAR_LISTENER_POLL);
    }
}

fn readiness_probe(
    endpoint: &SidecarEndpoint,
    process: &mut ManagedProcessGroup,
    timeout: Duration,
) -> Result<(), EngineError> {
    endpoint.listener.verify(endpoint.port)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .build()
        .map_err(|error| EngineError::internal(format!("create MLX readiness client: {error}")))?;
    let request = client
        .post(format!(
            "http://{SIDECAR_HOST}:{}/v1/chat/completions",
            endpoint.port
        ))
        .bearer_auth(&endpoint.capability)
        .header("content-type", "application/json")
        .body(
            json!({
                "model": endpoint.model,
                "messages": [{"role": "user", "content": "Reply with one token."}],
                "temperature": 0.0,
                "max_tokens": 1,
                "stream": false,
            })
            .to_string(),
        );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| EngineError::internal(format!("start MLX readiness runtime: {error}")))?;
    let (status, body) = runtime.block_on(async {
        let probe = async {
            let response = request.send().await.map_err(|error| {
                EngineError::load(format!("MLX weight-load readiness probe failed: {error}"))
            })?;
            let status = response.status();
            let body = response.text().await.map_err(|error| {
                EngineError::load(format!("read MLX readiness response: {error}"))
            })?;
            Ok::<_, EngineError>((status, body))
        };
        tokio::pin!(probe);
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                result = &mut probe => break result,
                _ = &mut deadline => {
                    break Err(EngineError::load(
                        "MLX weight-load inference readiness probe timed out",
                    ));
                }
                _ = tokio::time::sleep(SIDECAR_LISTENER_POLL) => {
                    if let Some(status) = process.child.try_wait().map_err(|error| {
                        EngineError::load(format!("inspect MLX sidecar during readiness: {error}"))
                    })? {
                        break Err(EngineError::load(format!(
                            "MLX sidecar exited during weight loading ({status})"
                        )));
                    }
                }
            }
        }
    })?;
    let body: Value = serde_json::from_str(&body)
        .map_err(|error| EngineError::load(format!("parse MLX readiness response: {error}")))?;
    if !status.is_success() {
        return Err(EngineError::load(format!(
            "MLX model failed its inference readiness probe ({status}): {}",
            body.get("error")
                .and_then(|error| error.get("message").or(Some(error)))
                .and_then(Value::as_str)
                .unwrap_or("loader failure")
        )));
    }
    let terminal_choice = body
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|choice| {
                choice
                    .get("finish_reason")
                    .and_then(Value::as_str)
                    .is_some()
                    && (choice.get("message").is_some() || choice.get("text").is_some())
            })
        });
    let generated_token = body
        .pointer("/usage/completion_tokens")
        .and_then(Value::as_u64)
        .is_some_and(|tokens| tokens == 1);
    if !terminal_choice || !generated_token {
        return Err(EngineError::load(
            "MLX readiness probe returned no validated one-token completion; model weights are not ready",
        ));
    }
    Ok(())
}

async fn proxy_chat_stream(
    endpoint: SidecarEndpoint,
    request: EngineChatRequest,
    deltas: mpsc::Sender<Result<ChatDelta, EngineError>>,
) -> Result<(), EngineError> {
    if deltas.is_closed() {
        return Ok(());
    }
    endpoint.listener.verify(endpoint.port)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| EngineError::internal(format!("create MLX proxy client: {error}")))?;
    let body = json!({
        // The outer daemon has already matched request.model against the
        // resident handle. mlx_lm expects its own canonical path id here.
        "model": endpoint.model,
        "messages": request.messages,
        "temperature": request.sampling.temperature,
        "top_p": request.sampling.top_p,
        "max_tokens": request.sampling.max_tokens,
        "seed": request.sampling.seed,
        "stream": true,
        // mlx_lm emits exact completion usage in its terminal SSE event when
        // asked. That lets the outer daemon report measured tok/s without
        // guessing from UTF-8 chunks.
        "stream_options": { "include_usage": true },
    });
    let send = client
        .post(format!(
            "http://{SIDECAR_HOST}:{}/v1/chat/completions",
            endpoint.port
        ))
        .bearer_auth(&endpoint.capability)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send();
    let response = tokio::select! {
        _ = deltas.closed() => return Ok(()),
        result = tokio::time::timeout(SIDECAR_HEADER_TIMEOUT, send) => {
            result
                .map_err(|_| EngineError::internal("MLX sidecar timed out before stream headers"))?
                .map_err(|error| EngineError::internal(format!("MLX sidecar is unavailable: {error}")))?
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = tokio::select! {
            _ = deltas.closed() => return Ok(()),
            result = tokio::time::timeout(Duration::from_secs(2), response.text()) => {
                result.ok().and_then(Result::ok).unwrap_or_default()
            }
        };
        let mut end = body.len().min(ERROR_BODY_CAP as usize);
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        let capped = &body[..end];
        return Err(map_sidecar_response_error(status, capped));
    }

    let started = Instant::now();
    let mut response = response;
    let mut buffered = Vec::new();
    let mut event_data = String::new();
    let mut finish_reason = None;
    let mut completion_tokens = None;
    let mut saw_done = false;
    loop {
        let chunk = tokio::select! {
            _ = deltas.closed() => return Ok(()),
            chunk = response.chunk() => chunk
                .map_err(|error| EngineError::internal(format!("read MLX sidecar stream: {error}")))?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        buffered.extend_from_slice(&chunk);
        while let Some(newline) = buffered.iter().position(|byte| *byte == b'\n') {
            let mut line = buffered.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = std::str::from_utf8(&line)
                .map_err(|error| EngineError::internal(format!("decode MLX SSE line: {error}")))?;
            if line.is_empty() {
                if !event_data.is_empty() {
                    let (done, content) =
                        parse_sse_event(&event_data, &mut finish_reason, &mut completion_tokens)?;
                    event_data.clear();
                    for delta in content {
                        if deltas.send(Ok(delta)).await.is_err() {
                            return Ok(());
                        }
                    }
                    if done {
                        saw_done = true;
                        break;
                    }
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                if !event_data.is_empty() {
                    event_data.push('\n');
                }
                event_data.push_str(data.trim_start());
            }
            // SSE comments and fields other than `data` are keepalives or
            // metadata. Returning to select here keeps cancellation active
            // even when the upstream only emits progress comments.
        }
        if saw_done {
            break;
        }
    }
    if !buffered.is_empty() {
        let line = std::str::from_utf8(&buffered)
            .map_err(|error| EngineError::internal(format!("decode MLX SSE tail: {error}")))?
            .trim_end_matches('\r');
        if let Some(data) = line.strip_prefix("data:") {
            if !event_data.is_empty() {
                event_data.push('\n');
            }
            event_data.push_str(data.trim_start());
        }
    }
    if !event_data.is_empty() {
        let (done, content) =
            parse_sse_event(&event_data, &mut finish_reason, &mut completion_tokens)?;
        saw_done |= done;
        for delta in content {
            if deltas.send(Ok(delta)).await.is_err() {
                return Ok(());
            }
        }
    }
    if !saw_done && finish_reason.is_none() {
        return Err(EngineError::internal(
            "MLX sidecar stream ended before a terminal event",
        ));
    }
    let tokens_per_second = completion_tokens.and_then(|tokens| {
        let elapsed = started.elapsed().as_secs_f64();
        (elapsed > 0.0).then_some(f64::from(tokens) / elapsed)
    });
    let _ = deltas
        .send(Ok(ChatDelta::finished(
            finish_reason.unwrap_or_else(|| "stop".into()),
            completion_tokens.unwrap_or(0),
            tokens_per_second,
        )))
        .await;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct SidecarChunk {
    #[serde(default)]
    choices: Vec<SidecarChoice>,
    #[serde(default)]
    usage: Option<SidecarUsage>,
    #[serde(default)]
    error: Option<SidecarError>,
}

#[derive(Debug, Deserialize)]
struct SidecarChoice {
    #[serde(default)]
    delta: SidecarDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SidecarDelta {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SidecarUsage {
    #[serde(default)]
    completion_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct SidecarError {
    #[serde(default)]
    message: String,
}

fn parse_sse_event(
    data: &str,
    finish_reason: &mut Option<String>,
    completion_tokens: &mut Option<u32>,
) -> Result<(bool, Vec<ChatDelta>), EngineError> {
    if data == "[DONE]" {
        return Ok((true, Vec::new()));
    }
    let chunk: SidecarChunk = serde_json::from_str(data)
        .map_err(|error| EngineError::internal(format!("parse MLX sidecar SSE event: {error}")))?;
    if let Some(error) = chunk.error {
        return Err(EngineError::invalid(format!(
            "MLX sidecar error: {}",
            error.message
        )));
    }
    if let Some(usage) = chunk.usage {
        if usage.completion_tokens.is_some() {
            *completion_tokens = usage.completion_tokens;
        }
    }
    let mut deltas = Vec::new();
    for choice in chunk.choices {
        if let Some(content) = choice.delta.content.filter(|content| !content.is_empty()) {
            deltas.push(ChatDelta::content(content));
        }
        if choice.finish_reason.is_some() {
            *finish_reason = choice.finish_reason;
        }
    }
    Ok((false, deltas))
}

fn map_sidecar_response_error(status: reqwest::StatusCode, body: &str) -> EngineError {
    let detail = body.trim();
    let suffix = (!detail.is_empty()).then(|| format!(": {detail}"));
    if status.is_client_error() {
        EngineError::invalid(format!(
            "MLX sidecar rejected the chat request ({status}){}",
            suffix.unwrap_or_default()
        ))
    } else {
        EngineError::internal(format!(
            "MLX sidecar failed the chat request ({status}){}",
            suffix.unwrap_or_default()
        ))
    }
}

fn mark_sidecar_unavailable(loaded: &Arc<Mutex<Option<LoadedSidecar>>>, generation: u64) {
    let sidecar = {
        let mut loaded = loaded.lock().unwrap();
        if loaded
            .as_ref()
            .is_some_and(|sidecar| sidecar.generation == generation)
        {
            loaded.take()
        } else {
            None
        }
    };
    drop(sidecar);
}

fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

impl ListenerIdentity {
    fn capture(pid: u32, port: u16) -> Result<Option<Self>, EngineError> {
        let Some(identity) = process_identity(pid as libc::pid_t) else {
            return Ok(None);
        };
        if process_owns_loopback_listener(identity.pid, port)? {
            Ok(Some(identity))
        } else {
            Ok(None)
        }
    }

    fn verify(&self, port: u16) -> Result<(), EngineError> {
        let current = process_identity(self.pid).ok_or_else(|| {
            EngineError::internal("MLX sidecar identity disappeared before proxying the prompt")
        })?;
        if current.started_seconds != self.started_seconds
            || current.started_microseconds != self.started_microseconds
            || !process_owns_loopback_listener(self.pid, port)?
        {
            return Err(EngineError::internal(
                "refusing MLX socket: it is no longer owned by modeld's spawned sidecar",
            ));
        }
        Ok(())
    }
}

fn process_identity(pid: libc::pid_t) -> Option<ListenerIdentity> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(ListenerIdentity {
        pid,
        started_seconds: info.pbi_start_tvsec,
        started_microseconds: info.pbi_start_tvusec,
    })
}

fn process_owns_loopback_listener(pid: libc::pid_t, port: u16) -> Result<bool, EngineError> {
    const PROC_PIDFDSOCKETINFO: i32 = 3;
    const SOCKET_FDINFO_SIZE: usize = 792;
    const SOCKET_KIND_OFFSET: usize = 256;
    const SOCKET_LOCAL_PORT_OFFSET: usize = 268;
    const SOCKET_LOCAL_ADDRESS_OFFSET: usize = 324;
    const TCP_STATE_OFFSET: usize = 344;
    const SOCKINFO_TCP: i32 = 2;
    const TSI_S_LISTEN: i32 = 1;

    let bytes =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if bytes <= 0 {
        return Ok(false);
    }
    let count = bytes as usize / std::mem::size_of::<libc::proc_fdinfo>() + 8;
    let mut fds = Vec::<libc::proc_fdinfo>::with_capacity(count);
    let requested = (fds.capacity() * std::mem::size_of::<libc::proc_fdinfo>()) as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            requested,
        )
    };
    if read < 0 {
        return Err(EngineError::internal(format!(
            "inspect MLX sidecar file descriptors: {}",
            std::io::Error::last_os_error()
        )));
    }
    unsafe {
        fds.set_len(read as usize / std::mem::size_of::<libc::proc_fdinfo>());
    }
    for fd in fds {
        if fd.proc_fdtype != libc::PROX_FDTYPE_SOCKET as u32 {
            continue;
        }
        // socket_fdinfo is private Darwin ABI. The SDK-stable structure is 792
        // bytes on supported 64-bit macOS; use an aligned opaque buffer and
        // read only the documented TCP fields from sys/proc_info.h.
        let mut info = [0_u64; SOCKET_FDINFO_SIZE / 8];
        let read = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd.proc_fd,
                PROC_PIDFDSOCKETINFO,
                info.as_mut_ptr().cast(),
                SOCKET_FDINFO_SIZE as i32,
            )
        };
        if read != SOCKET_FDINFO_SIZE as i32 {
            continue;
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(info.as_ptr().cast::<u8>(), SOCKET_FDINFO_SIZE) };
        let integer =
            |offset: usize| i32::from_ne_bytes(bytes[offset..offset + 4].try_into().unwrap());
        let local_port = u16::from_be(integer(SOCKET_LOCAL_PORT_OFFSET) as u16);
        if integer(SOCKET_KIND_OFFSET) == SOCKINFO_TCP
            && integer(TCP_STATE_OFFSET) == TSI_S_LISTEN
            && local_port == port
            && bytes[SOCKET_LOCAL_ADDRESS_OFFSET..SOCKET_LOCAL_ADDRESS_OFFSET + 4]
                == Ipv4Addr::LOCALHOST.octets()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl ManagedProcessGroup {
    fn new(mut child: Child) -> Self {
        let pgid = child.id() as libc::pid_t;
        let stdin = child.stdin.take();
        Self {
            child,
            stdin,
            pgid,
            stopped: false,
        }
    }

    fn stop(&mut self) {
        if self.stopped {
            return;
        }
        // Closing the liveness pipe is the crash-containment path. Explicit
        // teardown additionally signals the retained group id even if its
        // leader already exited, so helpers cannot survive as orphans.
        self.stdin.take();
        let _ = unsafe { libc::kill(-self.pgid, libc::SIGTERM) };
        let started = Instant::now();
        while started.elapsed() < PROCESS_STOP_GRACE {
            let _ = self.child.try_wait();
            if !process_group_exists(self.pgid) {
                let _ = self.child.wait();
                self.stopped = true;
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let _ = unsafe { libc::kill(-self.pgid, libc::SIGKILL) };
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.stopped = true;
    }
}

impl Drop for ManagedProcessGroup {
    fn drop(&mut self) {
        self.stop();
    }
}

impl PendingProcessGroup {
    fn new(child: Child) -> Self {
        Self(Some(ManagedProcessGroup::new(child)))
    }

    fn process_mut(&mut self) -> &mut ManagedProcessGroup {
        self.0.as_mut().unwrap()
    }

    fn commit(mut self) -> ManagedProcessGroup {
        self.0.take().unwrap()
    }
}

fn process_group_exists(pgid: libc::pid_t) -> bool {
    let result = unsafe { libc::kill(-pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use super::*;

    fn test_chat_request() -> EngineChatRequest {
        EngineChatRequest {
            model: None,
            messages: vec![super::super::engine::ChatMessage {
                role: "user".into(),
                content: "hello".into(),
            }],
            sampling: super::super::engine::SamplingParams {
                max_tokens: 1,
                ..Default::default()
            },
            grammar: None,
        }
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        let header_end = loop {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "client closed before sending HTTP headers");
            request.extend_from_slice(&chunk[..read]);
            if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while request.len() < header_end + content_length {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "client closed before sending HTTP body");
            request.extend_from_slice(&chunk[..read]);
        }
        String::from_utf8(request).unwrap()
    }

    fn local_endpoint(port: u16, capability: &str) -> SidecarEndpoint {
        SidecarEndpoint {
            port,
            capability: capability.into(),
            listener: ListenerIdentity::capture(std::process::id(), port)
                .unwrap()
                .unwrap(),
            generation: 1,
            model: "/models/test".into(),
        }
    }

    #[test]
    fn early_sidecar_eof_is_an_internal_stream_error() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_http_request(&mut stream);
            assert!(
                request.contains("authorization: Bearer test-capability")
                    || request.contains("Authorization: Bearer test-capability")
            );
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
                )
                .unwrap();
        });
        let (sender, _receiver) = mpsc::channel(4);
        let endpoint = local_endpoint(port, "test-capability");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let error = runtime
            .block_on(proxy_chat_stream(endpoint, test_chat_request(), sender))
            .unwrap_err();

        assert_eq!(error.kind, super::super::engine::EngineErrorKind::Internal);
        server.join().unwrap();
    }

    #[test]
    fn sidecar_arguments_always_enforce_loopback() {
        let mut reservation = ReservedLoopbackPort::new().unwrap();
        let args = sidecar_args(Path::new("/models/qwen-mlx"), &reservation);
        let host = args.iter().position(|arg| arg == "--host").unwrap();
        let port = args.iter().position(|arg| arg == "--port").unwrap();
        assert_eq!(args[host + 1], "127.0.0.1");
        assert_eq!(args[port + 1], reservation.port().to_string());
        assert_eq!(args.last().unwrap(), "/models/qwen-mlx");
        assert_eq!(args[0], "-c");
        assert!(args[1].contains("AuthenticatedHandler"));
        assert!(!args.iter().any(|arg| arg == "0.0.0.0"));
        assert!(!args.iter().any(|arg| arg.len() == 64));
        reservation.prevent_future_inheritance().unwrap();
        let flags = unsafe { libc::fcntl(reservation.fd(), libc::F_GETFD) };
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }

    #[test]
    fn sidecar_proxy_maps_client_and_server_errors() {
        assert_eq!(
            map_sidecar_response_error(reqwest::StatusCode::BAD_REQUEST, "bad prompt").kind,
            super::super::engine::EngineErrorKind::InvalidRequest
        );
        assert_eq!(
            map_sidecar_response_error(reqwest::StatusCode::BAD_GATEWAY, "upstream died").kind,
            super::super::engine::EngineErrorKind::Internal
        );
    }

    #[test]
    fn requested_mlx_context_is_reported_as_advisory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("config.json"), r#"{"model_type":"qwen"}"#).unwrap();
        std::fs::write(temp.path().join("model.safetensors"), "weights").unwrap();

        let handle = model_handle(
            temp.path(),
            LoadParams {
                context_length: 16_384,
            },
        )
        .unwrap();

        assert_eq!(handle.metadata.context_length, 16_384);
        assert!(handle.metadata.context_length_is_advisory);
    }

    #[test]
    fn terminal_usage_from_the_sidecar_becomes_measured_token_count() {
        let mut finish_reason = None;
        let mut completion_tokens = None;

        let (done, deltas) = parse_sse_event(
            r#"{"object":"chat.completion","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":17}}"#,
            &mut finish_reason,
            &mut completion_tokens,
        )
        .unwrap();

        assert!(!done);
        assert_eq!(finish_reason.as_deref(), Some("stop"));
        assert_eq!(completion_tokens, Some(17));
        assert!(deltas.is_empty());
    }

    fn spawn_test_process(mode: &str, port: Option<u16>, extra: Option<&Path>) -> Child {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "modeld::mlx::tests::fake_sidecar_process",
                "--nocapture",
            ])
            .env("KODADE_MLX_FAKE_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(port) = port {
            command.env("KODADE_MLX_FAKE_PORT", port.to_string());
        }
        if let Some(extra) = extra {
            command.env("KODADE_MLX_FAKE_EXTRA", extra);
        }
        configure_process_group(&mut command);
        command.spawn().unwrap()
    }

    fn wait_until_gone(pid: libc::pid_t) {
        let started = Instant::now();
        while unsafe { libc::kill(pid, 0) } == 0 && started.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "process {pid} survived");
    }

    #[test]
    #[ignore]
    // This helper intentionally exits before its descendant so the parent test
    // can prove retained-PGID teardown after the leader has already gone.
    #[allow(clippy::zombie_processes)]
    fn fake_sidecar_process() {
        let Ok(mode) = std::env::var("KODADE_MLX_FAKE_MODE") else {
            return;
        };
        match mode.as_str() {
            "sleep" => thread::sleep(Duration::from_secs(30)),
            "readiness-failure" => {
                let port: u16 = std::env::var("KODADE_MLX_FAKE_PORT")
                    .unwrap()
                    .parse()
                    .unwrap();
                let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
                let (mut stream, _) = listener.accept().unwrap();
                let _ = read_http_request(&mut stream);
                stream
                    .write_all(
                        b"HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 35\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"load failed\"}}",
                    )
                    .unwrap();
                thread::sleep(Duration::from_secs(30));
            }
            "inherited-listener" => {
                use std::os::fd::FromRawFd;

                let fd: i32 = std::env::var("KODADE_MLX_FAKE_FD")
                    .unwrap()
                    .parse()
                    .unwrap();
                let _listener = unsafe { TcpListener::from_raw_fd(fd) };
                thread::sleep(Duration::from_secs(30));
            }
            "leader-exit" => {
                let pid_path = std::env::var_os("KODADE_MLX_FAKE_EXTRA").unwrap();
                let descendant = Command::new("sleep").arg("30").spawn().unwrap();
                std::fs::write(pid_path, descendant.id().to_string()).unwrap();
            }
            other => panic!("unknown fake sidecar mode {other}"),
        }
    }

    #[test]
    fn impostor_listener_is_refused_and_spawned_child_is_killed() {
        let impostor = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = impostor.local_addr().unwrap().port();
        let child = spawn_test_process("sleep", None, None);
        let child_pid = child.id() as libc::pid_t;
        let mut pending = PendingProcessGroup::new(child);

        let error =
            wait_for_owned_listener(port, pending.process_mut(), Duration::from_millis(250))
                .unwrap_err();
        drop(pending);

        assert_eq!(error.kind, super::super::engine::EngineErrorKind::Load);
        assert!(error.message.contains("not owned"));
        wait_until_gone(child_pid);
    }

    #[test]
    fn reserved_listener_is_inherited_by_the_exact_spawned_child() {
        let mut reservation = ReservedLoopbackPort::new().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "modeld::mlx::tests::fake_sidecar_process",
                "--nocapture",
            ])
            .env("KODADE_MLX_FAKE_MODE", "inherited-listener")
            .env("KODADE_MLX_FAKE_FD", reservation.fd().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_group(&mut command);
        let child = command.spawn().unwrap();
        let mut pending = PendingProcessGroup::new(child);
        reservation.prevent_future_inheritance().unwrap();

        let identity = wait_for_owned_listener(
            reservation.port(),
            pending.process_mut(),
            Duration::from_secs(2),
        )
        .unwrap();

        assert_eq!(
            identity.pid,
            pending.process_mut().child.id() as libc::pid_t
        );
        drop(pending);
    }

    #[test]
    fn readiness_probe_failure_kills_the_uncommitted_sidecar() {
        let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let child = spawn_test_process("readiness-failure", Some(port), None);
        let child_pid = child.id() as libc::pid_t;
        let mut pending = PendingProcessGroup::new(child);
        let listener =
            wait_for_owned_listener(port, pending.process_mut(), Duration::from_secs(2)).unwrap();
        let endpoint = SidecarEndpoint {
            port,
            capability: "fake-token".into(),
            listener,
            generation: 1,
            model: "/models/failing".into(),
        };

        let error =
            readiness_probe(&endpoint, pending.process_mut(), Duration::from_secs(2)).unwrap_err();
        drop(pending);

        assert_eq!(error.kind, super::super::engine::EngineErrorKind::Load);
        wait_until_gone(child_pid);
    }

    #[test]
    fn post_spawn_failure_drops_and_reaps_the_pending_process_group() {
        let child = spawn_test_process("sleep", None, None);
        let pid = child.id() as libc::pid_t;
        let pending = PendingProcessGroup::new(child);

        drop(pending);

        wait_until_gone(pid);
    }

    #[test]
    fn cancellation_closes_the_sidecar_response_promptly() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let endpoint = local_endpoint(port, "cancel-token");
        let (accepted, accepted_rx) = std::sync::mpsc::channel();
        let (closed, closed_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_http_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n: keepalive\n\n",
                )
                .unwrap();
            accepted.send(()).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut byte = [0_u8; 1];
            closed
                .send(stream.read(&mut byte).unwrap_or(0) == 0)
                .unwrap();
        });
        let (sender, receiver) = mpsc::channel(2);
        let proxy = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(proxy_chat_stream(endpoint, test_chat_request(), sender))
        });
        accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        drop(receiver);

        assert!(closed_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        proxy.join().unwrap().unwrap();
        server.join().unwrap();
    }

    #[test]
    fn process_group_is_killed_after_its_leader_exits() {
        let temp = tempfile::tempdir().unwrap();
        let descendant_pid_path = temp.path().join("descendant.pid");
        let child = spawn_test_process("leader-exit", None, Some(&descendant_pid_path));
        let mut process = ManagedProcessGroup::new(child);
        let started = Instant::now();
        while !descendant_pid_path.is_file() && started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(10));
        }
        let descendant_pid: libc::pid_t = std::fs::read_to_string(descendant_pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        while process.child.try_wait().unwrap().is_none() {
            thread::sleep(Duration::from_millis(10));
        }

        process.stop();

        wait_until_gone(descendant_pid);
    }

    #[test]
    fn real_mlx_sidecar_smoke() {
        let Some(python) = std::env::var_os("KODADE_TEST_MLX_PYTHON").map(std::path::PathBuf::from)
        else {
            eprintln!("KODADE_TEST_MLX_PYTHON unset; skipping real MLX smoke");
            return;
        };
        let Some(model) = std::env::var_os("KODADE_TEST_MLX").map(std::path::PathBuf::from) else {
            eprintln!("KODADE_TEST_MLX unset; skipping real MLX smoke");
            return;
        };
        assert!(
            python.is_file(),
            "Python does not exist: {}",
            python.display()
        );
        ensure_mlx_directory(&model).unwrap();
        verify_mlx_lm(&python).unwrap();

        let mut reservation = ReservedLoopbackPort::new().unwrap();
        let port = reservation.port();
        let capability = random_capability().unwrap();
        let mut pending = spawn_sidecar(&python, &model, &reservation, &capability).unwrap();
        reservation.prevent_future_inheritance().unwrap();
        let listener =
            wait_for_owned_listener(port, pending.process_mut(), SIDECAR_LISTENER_TIMEOUT).unwrap();
        let endpoint = SidecarEndpoint {
            port,
            capability,
            listener,
            generation: 1,
            model: model.to_string_lossy().into_owned(),
        };
        readiness_probe(&endpoint, pending.process_mut(), SIDECAR_READINESS_TIMEOUT).unwrap();
        let process = pending.commit();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let unauthorized = runtime
            .block_on(async {
                reqwest::Client::new()
                    .get(format!("http://{SIDECAR_HOST}:{port}/v1/models"))
                    .send()
                    .await
            })
            .unwrap();
        assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

        let (sender, mut receiver) = mpsc::channel(32);
        runtime
            .block_on(proxy_chat_stream(endpoint, test_chat_request(), sender))
            .unwrap();
        let mut saw_terminal = false;
        while let Some(delta) = receiver.blocking_recv() {
            let delta = delta.unwrap();
            saw_terminal |= delta.finish_reason.is_some();
        }
        assert!(saw_terminal, "real MLX stream had no terminal delta");
        drop(process);
        drop(reservation);
    }
}
