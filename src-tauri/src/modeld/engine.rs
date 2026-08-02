use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

pub type DeltaReceiver = mpsc::Receiver<Result<ChatDelta, EngineError>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFormat {
    Gguf,
    Mlx,
}

impl ModelFormat {
    pub fn from_path(path: &Path) -> Result<Self, EngineError> {
        // A complete MLX snapshot is a directory, even if a user happened to
        // name that directory with a `.gguf` suffix. Only actual GGUF files
        // take the extension path below.
        if path.is_dir() {
            return is_mlx_directory(path).then_some(Self::Mlx).ok_or_else(|| {
                EngineError::unsupported(format!("unsupported model format for {}", path.display()))
            });
        }
        match path.extension().and_then(|extension| extension.to_str()) {
            Some(extension) if extension.eq_ignore_ascii_case("gguf") => Ok(Self::Gguf),
            _ => Err(EngineError::unsupported(format!(
                "unsupported model format for {}",
                path.display()
            ))),
        }
    }
}

// MLX model snapshots are directories. Checking the two required artifacts
// here makes format selection deterministic for the registry, the desktop
// custom-path validation, and the engine itself. A directory that merely
// happens to contain a JSON file is never treated as runnable model weights.
fn is_mlx_directory(path: &Path) -> bool {
    if !path.is_dir() || !path.join("config.json").is_file() {
        return false;
    }
    std::fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| {
            let path = entry.path();
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("safetensors"))
        })
}

// The admission check needs an on-disk estimate before an engine allocates
// native memory. HF snapshots commonly use file symlinks into the blob cache,
// so count linked files but do not recursively follow linked directories.
pub fn model_path_bytes(path: &Path, format: ModelFormat) -> Result<u64, EngineError> {
    match format {
        ModelFormat::Gguf => std::fs::metadata(path)
            .map(|metadata| metadata.len())
            .map_err(|error| {
                EngineError::not_found(format!("inspect model file {}: {error}", path.display()))
            }),
        ModelFormat::Mlx => directory_bytes(path),
    }
}

fn directory_bytes(path: &Path) -> Result<u64, EngineError> {
    let entries = std::fs::read_dir(path).map_err(|error| {
        EngineError::not_found(format!(
            "inspect MLX model directory {}: {error}",
            path.display()
        ))
    })?;
    let mut bytes = 0_u64;
    for entry in entries {
        let entry = entry.map_err(|error| {
            EngineError::internal(format!(
                "read MLX model directory {}: {error}",
                path.display()
            ))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            EngineError::internal(format!(
                "inspect MLX model entry {}: {error}",
                entry.path().display()
            ))
        })?;
        let metadata = entry.metadata().map_err(|error| {
            EngineError::internal(format!(
                "inspect MLX model entry {}: {error}",
                entry.path().display()
            ))
        })?;
        if metadata.is_file() {
            bytes = bytes.saturating_add(metadata.len());
        } else if metadata.is_dir() && !file_type.is_symlink() {
            bytes = bytes.saturating_add(directory_bytes(&entry.path())?);
        }
    }
    Ok(bytes)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LoadParams {
    pub context_length: u32,
}

impl Default for LoadParams {
    fn default() -> Self {
        Self {
            context_length: 4_096,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelMetadata {
    pub context_length: u32,
    #[serde(default)]
    pub context_length_is_advisory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelHandle {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub metadata: ModelMetadata,
    pub footprint_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplingParams {
    pub temperature: f32,
    pub top_p: f32,
    pub max_tokens: u32,
    pub seed: u32,
}

impl Default for SamplingParams {
    fn default() -> Self {
        Self {
            temperature: 0.8,
            top_p: 0.95,
            max_tokens: 256,
            seed: u32::MAX,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EngineChatRequest {
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub sampling: SamplingParams,
    pub grammar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatDelta {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_per_second: Option<f64>,
}

impl ChatDelta {
    pub fn content(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            finish_reason: None,
            completion_tokens: None,
            tokens_per_second: None,
        }
    }

    pub fn finished(
        reason: impl Into<String>,
        completion_tokens: u32,
        tokens_per_second: Option<f64>,
    ) -> Self {
        Self {
            content: String::new(),
            finish_reason: Some(reason.into()),
            completion_tokens: Some(completion_tokens),
            tokens_per_second,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Supports {
    pub tools: bool,
    pub grammar: bool,
    pub constrained: bool,
    pub embeddings: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Capabilities {
    pub engine: String,
    pub formats: Vec<ModelFormat>,
    pub supports: Supports,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram_budget_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_ram_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram_budget_bytes: Option<u64>,
    pub loaded_bytes: u64,
    pub loaded_models: Vec<ModelHandle>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineErrorKind {
    InvalidRequest,
    NotFound,
    Conflict,
    InsufficientMemory,
    Unsupported,
    Load,
    Internal,
}

#[derive(Debug, Clone)]
pub struct EngineError {
    pub kind: EngineErrorKind,
    pub message: String,
}

impl EngineError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::InvalidRequest, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::NotFound, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::Conflict, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::Unsupported, message)
    }

    pub fn insufficient_memory(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::InsufficientMemory, message)
    }

    pub fn load(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::Load, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::Internal, message)
    }

    fn new(kind: EngineErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for EngineError {}

// Seam #2: model engines own native state and token generation; transport and
// TypeScript callers stay independent of the selected model format.
pub trait InferenceEngine: Send + Sync {
    fn name(&self) -> &'static str;
    fn supports(&self, format: ModelFormat) -> bool;
    fn load(&self, path: &Path, params: LoadParams) -> Result<ModelHandle, EngineError>;
    // The daemon must reject a model before native loading when its estimated
    // footprint cannot fit. File bytes are the portable baseline; engines can
    // override this for a more precise estimate without changing HTTP callers.
    fn estimate_load_footprint(
        &self,
        path: &Path,
        _params: LoadParams,
    ) -> Result<u64, EngineError> {
        model_path_bytes(path, ModelFormat::from_path(path)?)
    }
    fn unload(&self, id: &str) -> Result<(), EngineError>;
    fn chat_stream(&self, request: EngineChatRequest) -> Result<DeltaReceiver, EngineError>;
    fn capabilities(&self) -> Capabilities;
    fn memory_report(&self) -> MemoryReport;
}

struct ActiveEngine {
    engine: Arc<dyn InferenceEngine>,
    model: ModelHandle,
    generation: u64,
}

// Explicit selection-by-format lives here, never in HTTP handlers.
pub struct EngineRegistry {
    engines: Vec<Arc<dyn InferenceEngine>>,
    active: Arc<Mutex<Option<ActiveEngine>>>,
    next_generation: AtomicU64,
}

impl EngineRegistry {
    pub fn new(engines: Vec<Arc<dyn InferenceEngine>>) -> Result<Self, EngineError> {
        if engines.is_empty() {
            return Err(EngineError::invalid(
                "at least one inference engine is required",
            ));
        }
        Ok(Self {
            engines,
            active: Arc::new(Mutex::new(None)),
            next_generation: AtomicU64::new(1),
        })
    }

    pub fn load(&self, path: PathBuf, params: LoadParams) -> Result<ModelHandle, EngineError> {
        if params.context_length == 0 {
            return Err(EngineError::invalid(
                "context length must be greater than zero",
            ));
        }
        let format = ModelFormat::from_path(&path)?;
        let mut active = self.active.lock().unwrap();
        if let Some(current) = active.as_ref() {
            if current.model.path == path
                && current.model.metadata.context_length == params.context_length
            {
                return Ok(current.model.clone());
            }
            return Err(EngineError::conflict(format!(
                "model {} is already loaded; unload it before loading another",
                current.model.id
            )));
        }
        let engine = self
            .engines
            .iter()
            .find(|engine| engine.supports(format))
            .cloned()
            .ok_or_else(|| EngineError::unsupported(format!("no engine supports {format:?}")))?;
        let report = engine.memory_report();
        let budget = report
            .ram_budget_bytes
            .or(report.total_ram_bytes)
            .ok_or_else(|| {
                EngineError::insufficient_memory(
                    "cannot determine a RAM budget; refusing to load a local model",
                )
            })?;
        let available = budget.saturating_sub(report.loaded_bytes);
        let estimated = engine.estimate_load_footprint(&path, params)?;
        if estimated > available {
            return Err(EngineError::insufficient_memory(format!(
                "model needs about {estimated} bytes but only {available} bytes fit within the {budget}-byte RAM budget",
            )));
        }

        let model = engine.load(&path, params)?;
        if model.footprint_bytes > available {
            // The portable preflight is deliberately conservative, but never
            // keep a model resident if the native engine reports it exceeds
            // the daemon's own budget after loading.
            let _ = engine.unload(&model.id);
            return Err(EngineError::insufficient_memory(format!(
                "model needs {} bytes but only {available} bytes fit within the {budget}-byte RAM budget",
                model.footprint_bytes,
            )));
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        *active = Some(ActiveEngine {
            engine,
            model: model.clone(),
            generation,
        });
        Ok(model)
    }

    pub fn unload(&self, id: &str) -> Result<(), EngineError> {
        let mut active = self.active.lock().unwrap();
        let current = active
            .as_ref()
            .ok_or_else(|| EngineError::not_found("no model is loaded"))?;
        if current.model.id != id {
            return Err(EngineError::not_found(format!("model {id} is not loaded")));
        }
        current.engine.unload(id)?;
        *active = None;
        Ok(())
    }

    pub fn chat_stream(&self, request: EngineChatRequest) -> Result<DeltaReceiver, EngineError> {
        let active = self.active.lock().unwrap();
        let current = active
            .as_ref()
            .ok_or_else(|| EngineError::conflict("no model is loaded"))?;
        if let Some(requested) = request.model.as_deref() {
            if requested != current.model.id {
                return Err(EngineError::not_found(format!(
                    "model {requested} is not loaded"
                )));
            }
        }
        let generation = current.generation;
        let engine = Arc::clone(&current.engine);
        let model_id = current.model.id.clone();
        let result = engine.chat_stream(request);
        // An engine-side process crash is terminal for the resident model. Do
        // not retain a stale handle that would make /v1/models claim it is
        // usable. Unsupported requests (for example MLX + grammar) leave a
        // healthy model loaded for ordinary chat.
        let source = match result {
            Ok(receiver) => receiver,
            Err(error) => {
                drop(active);
                if error.kind == EngineErrorKind::Internal {
                    clear_active_generation(&self.active, generation);
                }
                return Err(error);
            }
        };
        drop(active);

        let (deltas, receiver) = mpsc::channel(32);
        let active_for_worker = Arc::clone(&self.active);
        let observer = thread::Builder::new()
            .name("kodade-modeld-stream-observer".to_string())
            .spawn(move || observe_stream(source, deltas, active_for_worker, generation));
        if let Err(error) = observer {
            // The engine may already have started native generation. Unload it
            // before clearing the registry so no resident child is orphaned by
            // a failed observer-thread allocation.
            let _ = engine.unload(&model_id);
            clear_active_generation(&self.active, generation);
            return Err(EngineError::internal(format!(
                "start model stream observer: {error}"
            )));
        }
        Ok(receiver)
    }

    pub fn models(&self) -> Vec<ModelHandle> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|active| vec![active.model.clone()])
            .unwrap_or_default()
    }

    pub fn capabilities(&self) -> Capabilities {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|active| active.engine.capabilities())
            .unwrap_or_else(|| aggregate_capabilities(&self.engines))
    }

    pub fn memory_report(&self) -> MemoryReport {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|active| active.engine.memory_report())
            .unwrap_or_else(|| self.engines[0].memory_report())
    }

    // Graceful daemon shutdown owns the loaded engine lifecycle explicitly.
    // Engine Drop remains a final safety net for early-return/error paths.
    pub fn shutdown(&self) {
        let current = self.active.lock().unwrap().take();
        if let Some(current) = current {
            let _ = current.engine.unload(&current.model.id);
        }
    }
}

fn clear_active_generation(active: &Arc<Mutex<Option<ActiveEngine>>>, generation: u64) {
    let removed = {
        let mut active = active.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|current| current.generation == generation)
        {
            active.take()
        } else {
            None
        }
    };
    if let Some(removed) = removed {
        let _ = removed.engine.unload(&removed.model.id);
    }
}

fn observe_stream(
    mut source: DeltaReceiver,
    deltas: mpsc::Sender<Result<ChatDelta, EngineError>>,
    active: Arc<Mutex<Option<ActiveEngine>>>,
    generation: u64,
) {
    while let Some(delta) = source.blocking_recv() {
        let terminal_internal = delta
            .as_ref()
            .is_err_and(|error| error.kind == EngineErrorKind::Internal);
        if terminal_internal {
            clear_active_generation(&active, generation);
        }
        if deltas.blocking_send(delta).is_err() || terminal_internal {
            break;
        }
    }
}

fn aggregate_capabilities(engines: &[Arc<dyn InferenceEngine>]) -> Capabilities {
    let capabilities: Vec<_> = engines.iter().map(|engine| engine.capabilities()).collect();
    let mut names = Vec::new();
    let mut formats = Vec::new();
    let mut supports = Supports {
        tools: false,
        grammar: false,
        constrained: false,
        embeddings: false,
    };
    for capability in &capabilities {
        if !names.contains(&capability.engine) {
            names.push(capability.engine.clone());
        }
        for format in &capability.formats {
            if !formats.contains(format) {
                formats.push(*format);
            }
        }
        supports.tools |= capability.supports.tools;
        supports.grammar |= capability.supports.grammar;
        supports.constrained |= capability.supports.constrained;
        supports.embeddings |= capability.supports.embeddings;
    }
    Capabilities {
        engine: names.join(" + "),
        formats,
        supports,
        ram_budget_bytes: capabilities
            .iter()
            .filter_map(|capability| capability.ram_budget_bytes)
            .min(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn detects_mlx_only_for_complete_weight_directories() {
        let temp = tempfile::tempdir().unwrap();
        let model = temp.path().join("mlx-model");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        std::fs::write(model.join("model-00001.safetensors"), "weights").unwrap();

        assert_eq!(ModelFormat::from_path(&model).unwrap(), ModelFormat::Mlx);
        assert!(model_path_bytes(&model, ModelFormat::Mlx).unwrap() >= 9);

        let incomplete = temp.path().join("incomplete");
        std::fs::create_dir(&incomplete).unwrap();
        std::fs::write(incomplete.join("config.json"), "{}").unwrap();
        assert_eq!(
            ModelFormat::from_path(&incomplete).unwrap_err().kind,
            EngineErrorKind::Unsupported
        );
        assert_eq!(
            ModelFormat::from_path(Path::new("model.gguf")).unwrap(),
            ModelFormat::Gguf
        );
        let oddly_named_mlx = temp.path().join("snapshot.gguf");
        std::fs::create_dir(&oddly_named_mlx).unwrap();
        std::fs::write(oddly_named_mlx.join("config.json"), "{}").unwrap();
        std::fs::write(oddly_named_mlx.join("weights.safetensors"), "weights").unwrap();
        assert_eq!(
            ModelFormat::from_path(&oddly_named_mlx).unwrap(),
            ModelFormat::Mlx
        );

        let weight_directory = temp.path().join("weight-directory");
        std::fs::create_dir(&weight_directory).unwrap();
        std::fs::write(weight_directory.join("config.json"), "{}").unwrap();
        std::fs::create_dir(weight_directory.join("model.safetensors")).unwrap();
        assert_eq!(
            ModelFormat::from_path(&weight_directory).unwrap_err().kind,
            EngineErrorKind::Unsupported
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                weight_directory.join("missing-weights"),
                weight_directory.join("broken.safetensors"),
            )
            .unwrap();
            assert_eq!(
                ModelFormat::from_path(&weight_directory).unwrap_err().kind,
                EngineErrorKind::Unsupported
            );
        }
    }

    struct RecordingEngine {
        format: ModelFormat,
        loads: AtomicUsize,
        loaded: Mutex<Option<ModelHandle>>,
    }

    impl RecordingEngine {
        fn new(format: ModelFormat) -> Self {
            Self {
                format,
                loads: AtomicUsize::new(0),
                loaded: Mutex::new(None),
            }
        }
    }

    impl InferenceEngine for RecordingEngine {
        fn name(&self) -> &'static str {
            "recording"
        }

        fn supports(&self, format: ModelFormat) -> bool {
            self.format == format
        }

        fn load(&self, path: &Path, params: LoadParams) -> Result<ModelHandle, EngineError> {
            self.loads.fetch_add(1, Ordering::SeqCst);
            let handle = ModelHandle {
                id: "recording-model".into(),
                name: "Recording model".into(),
                path: PathBuf::from(path),
                metadata: ModelMetadata {
                    context_length: params.context_length,
                    context_length_is_advisory: false,
                    quant: None,
                    architecture: None,
                },
                footprint_bytes: 1,
            };
            *self.loaded.lock().unwrap() = Some(handle.clone());
            Ok(handle)
        }

        fn estimate_load_footprint(
            &self,
            _path: &Path,
            _params: LoadParams,
        ) -> Result<u64, EngineError> {
            Ok(1)
        }

        fn unload(&self, _id: &str) -> Result<(), EngineError> {
            *self.loaded.lock().unwrap() = None;
            Ok(())
        }

        fn chat_stream(&self, _request: EngineChatRequest) -> Result<DeltaReceiver, EngineError> {
            Err(EngineError::internal("not used in registry selection test"))
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities {
                engine: self.name().into(),
                formats: vec![self.format],
                supports: Supports {
                    tools: false,
                    grammar: false,
                    constrained: false,
                    embeddings: false,
                },
                ram_budget_bytes: Some(1024),
            }
        }

        fn memory_report(&self) -> MemoryReport {
            MemoryReport {
                total_ram_bytes: Some(1024),
                ram_budget_bytes: Some(1024),
                loaded_bytes: 0,
                loaded_models: Vec::new(),
            }
        }
    }

    #[test]
    fn registry_selects_the_mlx_engine_by_directory_format() {
        let temp = tempfile::tempdir().unwrap();
        let model = temp.path().join("mlx-model");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        std::fs::write(model.join("weights.safetensors"), "weights").unwrap();
        let gguf = Arc::new(RecordingEngine::new(ModelFormat::Gguf));
        let mlx = Arc::new(RecordingEngine::new(ModelFormat::Mlx));
        let registry = EngineRegistry::new(vec![gguf.clone(), mlx.clone()]).unwrap();

        registry.load(model, LoadParams::default()).unwrap();

        assert_eq!(gguf.loads.load(Ordering::SeqCst), 0);
        assert_eq!(mlx.loads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn registry_advertises_every_registered_format_before_load() {
        let gguf = Arc::new(RecordingEngine::new(ModelFormat::Gguf));
        let mlx = Arc::new(RecordingEngine::new(ModelFormat::Mlx));
        let registry = EngineRegistry::new(vec![gguf, mlx]).unwrap();

        let capabilities = registry.capabilities();

        assert_eq!(
            capabilities.formats,
            vec![ModelFormat::Gguf, ModelFormat::Mlx]
        );
        assert!(capabilities.engine.contains("recording"));
    }

    struct ControlledStreamEngine {
        loaded: Mutex<Option<ModelHandle>>,
        sender: Mutex<Option<mpsc::Sender<Result<ChatDelta, EngineError>>>>,
    }

    impl ControlledStreamEngine {
        fn new() -> Self {
            Self {
                loaded: Mutex::new(None),
                sender: Mutex::new(None),
            }
        }
    }

    impl InferenceEngine for ControlledStreamEngine {
        fn name(&self) -> &'static str {
            "controlled"
        }

        fn supports(&self, format: ModelFormat) -> bool {
            format == ModelFormat::Gguf
        }

        fn load(&self, path: &Path, params: LoadParams) -> Result<ModelHandle, EngineError> {
            let handle = ModelHandle {
                id: "controlled-model".into(),
                name: "Controlled model".into(),
                path: path.to_path_buf(),
                metadata: ModelMetadata {
                    context_length: params.context_length,
                    context_length_is_advisory: false,
                    quant: None,
                    architecture: None,
                },
                footprint_bytes: 1,
            };
            *self.loaded.lock().unwrap() = Some(handle.clone());
            Ok(handle)
        }

        fn estimate_load_footprint(
            &self,
            _path: &Path,
            _params: LoadParams,
        ) -> Result<u64, EngineError> {
            Ok(1)
        }

        fn unload(&self, _id: &str) -> Result<(), EngineError> {
            *self.loaded.lock().unwrap() = None;
            Ok(())
        }

        fn chat_stream(&self, _request: EngineChatRequest) -> Result<DeltaReceiver, EngineError> {
            let (sender, receiver) = mpsc::channel(2);
            *self.sender.lock().unwrap() = Some(sender);
            Ok(receiver)
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities {
                engine: self.name().into(),
                formats: vec![ModelFormat::Gguf],
                supports: Supports {
                    tools: false,
                    grammar: false,
                    constrained: false,
                    embeddings: false,
                },
                ram_budget_bytes: Some(1024),
            }
        }

        fn memory_report(&self) -> MemoryReport {
            MemoryReport {
                total_ram_bytes: Some(1024),
                ram_budget_bytes: Some(1024),
                loaded_bytes: 0,
                loaded_models: Vec::new(),
            }
        }
    }

    fn empty_chat_request() -> EngineChatRequest {
        EngineChatRequest {
            model: None,
            messages: Vec::new(),
            sampling: SamplingParams::default(),
            grammar: None,
        }
    }

    #[test]
    fn terminal_internal_stream_error_clears_the_matching_resident_model() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("model.gguf");
        std::fs::write(&path, "weights").unwrap();
        let engine = Arc::new(ControlledStreamEngine::new());
        let registry = EngineRegistry::new(vec![engine.clone()]).unwrap();
        registry.load(path, LoadParams::default()).unwrap();
        let mut receiver = registry.chat_stream(empty_chat_request()).unwrap();

        engine
            .sender
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .blocking_send(Err(EngineError::internal("sidecar failed")))
            .unwrap();
        let error = receiver.blocking_recv().unwrap().unwrap_err();

        assert_eq!(error.kind, EngineErrorKind::Internal);
        assert!(registry.models().is_empty());
    }

    #[test]
    fn stale_stream_failure_does_not_clear_a_reloaded_generation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("model.gguf");
        std::fs::write(&path, "weights").unwrap();
        let engine = Arc::new(ControlledStreamEngine::new());
        let registry = EngineRegistry::new(vec![engine.clone()]).unwrap();
        registry.load(path.clone(), LoadParams::default()).unwrap();
        let mut stale_receiver = registry.chat_stream(empty_chat_request()).unwrap();
        let stale_sender = engine.sender.lock().unwrap().take().unwrap();

        registry.unload("controlled-model").unwrap();
        registry.load(path, LoadParams::default()).unwrap();
        stale_sender
            .blocking_send(Err(EngineError::internal("old generation failed")))
            .unwrap();
        let error = stale_receiver.blocking_recv().unwrap().unwrap_err();

        assert_eq!(error.kind, EngineErrorKind::Internal);
        assert_eq!(registry.models().len(), 1);
    }

    #[test]
    fn internal_engine_failure_clears_the_stale_resident_model() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("model.gguf");
        std::fs::write(&path, "weights").unwrap();
        let engine = Arc::new(RecordingEngine::new(ModelFormat::Gguf));
        let registry = EngineRegistry::new(vec![engine]).unwrap();
        registry.load(path, LoadParams::default()).unwrap();

        let error = registry
            .chat_stream(EngineChatRequest {
                model: None,
                messages: Vec::new(),
                sampling: SamplingParams::default(),
                grammar: None,
            })
            .unwrap_err();

        assert_eq!(error.kind, EngineErrorKind::Internal);
        assert!(registry.models().is_empty());
    }
}
