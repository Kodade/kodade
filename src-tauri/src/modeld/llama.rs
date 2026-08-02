use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use tokio::sync::mpsc;

use super::engine::{
    Capabilities, ChatDelta, DeltaReceiver, EngineChatRequest, EngineError, InferenceEngine,
    LoadParams, MemoryReport, ModelFormat, ModelHandle, ModelMetadata, Supports,
};
use super::{hardware_ram_bytes, ram_budget_bytes};

enum WorkerCommand {
    Load {
        path: PathBuf,
        params: LoadParams,
        reply: std_mpsc::Sender<Result<ModelHandle, EngineError>>,
    },
    Unload {
        id: String,
        reply: std_mpsc::Sender<Result<(), EngineError>>,
    },
    Chat {
        request: EngineChatRequest,
        deltas: mpsc::Sender<Result<ChatDelta, EngineError>>,
    },
    Shutdown,
}

struct LoadedModel {
    model: LlamaModel,
    handle: ModelHandle,
}

pub struct LlamaCppEngine {
    commands: std_mpsc::Sender<WorkerCommand>,
    loaded: Arc<Mutex<Option<ModelHandle>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl LlamaCppEngine {
    pub fn new() -> Result<Self, EngineError> {
        let (commands, receiver) = std_mpsc::channel();
        let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("kodade-modeld-llama".to_string())
            .spawn(move || match LlamaBackend::init() {
                Ok(backend) => {
                    let _ = ready_tx.send(Ok(()));
                    run_worker(backend, receiver);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(EngineError::internal(format!(
                        "initialize llama.cpp: {error}"
                    ))));
                }
            })
            .map_err(|error| EngineError::internal(format!("start llama.cpp worker: {error}")))?;
        ready_rx
            .recv()
            .map_err(|_| EngineError::internal("llama.cpp worker stopped during startup"))??;
        Ok(Self {
            commands,
            loaded: Arc::new(Mutex::new(None)),
            worker: Mutex::new(Some(worker)),
        })
    }

    fn command_reply<T>(
        &self,
        make_command: impl FnOnce(std_mpsc::Sender<Result<T, EngineError>>) -> WorkerCommand,
    ) -> Result<T, EngineError> {
        let (reply, response) = std_mpsc::channel();
        self.commands
            .send(make_command(reply))
            .map_err(|_| EngineError::internal("llama.cpp worker is unavailable"))?;
        response
            .recv()
            .map_err(|_| EngineError::internal("llama.cpp worker closed its response"))?
    }
}

impl InferenceEngine for LlamaCppEngine {
    fn name(&self) -> &'static str {
        "llama.cpp"
    }

    fn supports(&self, format: ModelFormat) -> bool {
        format == ModelFormat::Gguf
    }

    fn load(&self, path: &Path, params: LoadParams) -> Result<ModelHandle, EngineError> {
        let handle = self.command_reply(|reply| WorkerCommand::Load {
            path: path.to_path_buf(),
            params,
            reply,
        })?;
        *self.loaded.lock().unwrap() = Some(handle.clone());
        Ok(handle)
    }

    fn unload(&self, id: &str) -> Result<(), EngineError> {
        self.command_reply(|reply| WorkerCommand::Unload {
            id: id.to_string(),
            reply,
        })?;
        *self.loaded.lock().unwrap() = None;
        Ok(())
    }

    fn chat_stream(&self, request: EngineChatRequest) -> Result<DeltaReceiver, EngineError> {
        if self.loaded.lock().unwrap().is_none() {
            return Err(EngineError::conflict("no model is loaded"));
        }
        let (deltas, receiver) = mpsc::channel(32);
        self.commands
            .send(WorkerCommand::Chat { request, deltas })
            .map_err(|_| EngineError::internal("llama.cpp worker is unavailable"))?;
        Ok(receiver)
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            engine: self.name().to_string(),
            formats: vec![ModelFormat::Gguf],
            supports: Supports {
                tools: false,
                grammar: true,
                constrained: true,
                embeddings: false,
            },
            ram_budget_bytes: ram_budget_bytes(),
        }
    }

    fn memory_report(&self) -> MemoryReport {
        let loaded_models: Vec<ModelHandle> =
            self.loaded.lock().unwrap().clone().into_iter().collect();
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

impl Drop for LlamaCppEngine {
    fn drop(&mut self) {
        let _ = self.commands.send(WorkerCommand::Shutdown);
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

fn run_worker(backend: LlamaBackend, commands: std_mpsc::Receiver<WorkerCommand>) {
    let mut loaded: Option<LoadedModel> = None;
    while let Ok(command) = commands.recv() {
        match command {
            WorkerCommand::Load {
                path,
                params,
                reply,
            } => match load_model(&backend, &path, params) {
                Ok((model, handle)) => {
                    loaded = Some(LoadedModel {
                        model,
                        handle: handle.clone(),
                    });
                    let _ = reply.send(Ok(handle));
                }
                Err(error) => {
                    let _ = reply.send(Err(error));
                }
            },
            WorkerCommand::Unload { id, reply } => {
                let result = match loaded.as_ref() {
                    Some(current) if current.handle.id == id => {
                        loaded = None;
                        Ok(())
                    }
                    _ => Err(EngineError::not_found(format!("model {id} is not loaded"))),
                };
                let _ = reply.send(result);
            }
            WorkerCommand::Chat { request, deltas } => match loaded.as_ref() {
                Some(model) => generate(&backend, model, &request, &deltas),
                None => {
                    let _ = deltas.blocking_send(Err(EngineError::conflict("no model is loaded")));
                }
            },
            WorkerCommand::Shutdown => break,
        }
    }
}

fn load_model(
    backend: &LlamaBackend,
    path: &Path,
    params: LoadParams,
) -> Result<(LlamaModel, ModelHandle), EngineError> {
    if !path.is_file() {
        return Err(EngineError::not_found(format!(
            "model file does not exist: {}",
            path.display()
        )));
    }
    let path = std::fs::canonicalize(path).map_err(|error| {
        EngineError::invalid(format!("resolve model path {}: {error}", path.display()))
    })?;
    let model = LlamaModel::load_from_file(backend, &path, &model_params())
        .map_err(|error| EngineError::invalid(format!("load GGUF {}: {error}", path.display())))?;
    let architecture = model.meta_val_str("general.architecture").ok();
    let name = model.meta_val_str("general.name").unwrap_or_else(|_| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("model")
            .to_string()
    });
    let id = model_id(&path);
    let handle = ModelHandle {
        id,
        name,
        path: path.clone(),
        metadata: ModelMetadata {
            context_length: params.context_length,
            context_length_is_advisory: false,
            quant: quant_from_path(&path),
            architecture,
        },
        footprint_bytes: model.size(),
    };
    Ok((model, handle))
}

#[cfg(target_os = "macos")]
fn model_params() -> LlamaModelParams {
    LlamaModelParams::default().with_n_gpu_layers(u32::MAX)
}

#[cfg(all(target_os = "windows", feature = "modeld-vulkan"))]
fn model_params() -> LlamaModelParams {
    LlamaModelParams::default().with_n_gpu_layers(u32::MAX)
}

#[cfg(all(target_os = "windows", not(feature = "modeld-vulkan")))]
fn model_params() -> LlamaModelParams {
    LlamaModelParams::default()
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn model_params() -> LlamaModelParams {
    LlamaModelParams::default()
}

fn model_id(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("model")
        .to_string()
}

fn quant_from_path(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?.to_ascii_uppercase();
    const QUANTS: [&str; 17] = [
        "Q2_K", "Q3_K_S", "Q3_K_M", "Q3_K_L", "Q4_0", "Q4_1", "Q4_K_S", "Q4_K_M", "Q5_0", "Q5_1",
        "Q5_K_S", "Q5_K_M", "Q6_K", "Q8_0", "IQ2_XXS", "IQ3_XXS", "IQ4_XS",
    ];
    QUANTS
        .into_iter()
        .find(|quant| name.contains(quant))
        .map(str::to_string)
}

fn generate(
    backend: &LlamaBackend,
    loaded: &LoadedModel,
    request: &EngineChatRequest,
    deltas: &mpsc::Sender<Result<ChatDelta, EngineError>>,
) {
    if let Err(error) = generate_inner(backend, loaded, request, deltas) {
        let _ = deltas.blocking_send(Err(error));
    }
}

fn generate_inner(
    backend: &LlamaBackend,
    loaded: &LoadedModel,
    request: &EngineChatRequest,
    deltas: &mpsc::Sender<Result<ChatDelta, EngineError>>,
) -> Result<(), EngineError> {
    let prompt = format_chat(&loaded.model, &loaded.handle, &request.messages)?;
    let tokens = loaded
        .model
        .str_to_token(&prompt, AddBos::Never)
        .map_err(|error| EngineError::invalid(format!("tokenize chat prompt: {error}")))?;
    let context_length = loaded.handle.metadata.context_length;
    if tokens.is_empty() {
        return Err(EngineError::invalid(
            "chat template produced an empty prompt",
        ));
    }
    if tokens.len() >= context_length as usize {
        return Err(EngineError::invalid(format!(
            "prompt uses {} tokens but the loaded context is {context_length}",
            tokens.len()
        )));
    }
    let n_batch = u32::try_from(tokens.len())
        .unwrap_or(u32::MAX)
        .max(1)
        .min(context_length);
    let context_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(context_length))
        .with_n_batch(n_batch);
    let mut context = loaded
        .model
        .new_context(backend, context_params)
        .map_err(|error| EngineError::internal(format!("create inference context: {error}")))?;
    let mut batch = LlamaBatch::new(tokens.len().max(1), 1);
    batch
        .add_sequence(&tokens, 0, false)
        .map_err(|error| EngineError::internal(format!("build prompt batch: {error}")))?;
    context
        .decode(&mut batch)
        .map_err(|error| EngineError::internal(format!("decode prompt: {error}")))?;

    let mut samplers = Vec::new();
    if let Some(grammar) = request.grammar.as_deref() {
        samplers.push(
            LlamaSampler::grammar(&loaded.model, grammar, "root")
                .map_err(|error| EngineError::invalid(format!("invalid GBNF grammar: {error}")))?,
        );
    }
    samplers.push(LlamaSampler::top_k(40));
    samplers.push(LlamaSampler::top_p(request.sampling.top_p, 1));
    if request.sampling.temperature <= 0.0 {
        samplers.push(LlamaSampler::greedy());
    } else {
        samplers.push(LlamaSampler::temp(request.sampling.temperature));
        samplers.push(LlamaSampler::dist(request.sampling.seed));
    }
    let mut sampler = LlamaSampler::chain_simple(samplers);
    let available = context_length.saturating_sub(tokens.len() as u32);
    let max_tokens = request.sampling.max_tokens.min(available);
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut completion_tokens = 0_u32;
    let prompt_tokens = i32::try_from(tokens.len())
        .map_err(|_| EngineError::invalid("prompt token count exceeds llama.cpp position range"))?;
    let started = Instant::now();
    let mut finish_reason = "length";

    for offset in 0..max_tokens {
        // llama_sampler_sample applies and accepts the selected token; accepting
        // again would advance a grammar twice and invalidate its stack.
        let token = sampler.sample(&context, batch.n_tokens() - 1);
        if loaded.model.is_eog_token(token) {
            finish_reason = "stop";
            break;
        }
        let piece = loaded
            .model
            .token_to_piece(token, &mut decoder, true, None)
            .map_err(|error| EngineError::internal(format!("decode token: {error}")))?;
        completion_tokens += 1;
        if !piece.is_empty() && deltas.blocking_send(Ok(ChatDelta::content(piece))).is_err() {
            return Ok(());
        }
        batch.clear();
        let position = prompt_tokens
            .checked_add(i32::try_from(offset).map_err(|_| {
                EngineError::invalid("generated token count exceeds llama.cpp position range")
            })?)
            .ok_or_else(|| EngineError::invalid("llama.cpp position overflow"))?;
        batch
            .add(token, position, &[0], true)
            .map_err(|error| EngineError::internal(format!("build decode batch: {error}")))?;
        context
            .decode(&mut batch)
            .map_err(|error| EngineError::internal(format!("decode generated token: {error}")))?;
    }

    let seconds = started.elapsed().as_secs_f64();
    let tokens_per_second =
        (completion_tokens > 0 && seconds > 0.0).then_some(f64::from(completion_tokens) / seconds);
    let _ = deltas.blocking_send(Ok(ChatDelta::finished(
        finish_reason,
        completion_tokens,
        tokens_per_second,
    )));
    Ok(())
}

fn format_chat(
    model: &LlamaModel,
    handle: &ModelHandle,
    messages: &[super::engine::ChatMessage],
) -> Result<String, EngineError> {
    let chat = messages
        .iter()
        .map(|message| LlamaChatMessage::new(message.role.clone(), message.content.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| EngineError::invalid(format!("invalid chat message: {error}")))?;

    if let Ok(template) = model.chat_template(None) {
        if let Ok(prompt) = model.apply_chat_template(&template, &chat, true) {
            return Ok(prompt);
        }
    }

    // M14b/M14e can grow this identity-based fallback into the community
    // template-fix registry without changing callers or the engine trait.
    let fallback = fallback_template(handle.metadata.architecture.as_deref());
    let template = LlamaChatTemplate::new(fallback)
        .map_err(|error| EngineError::internal(format!("build fallback template: {error}")))?;
    model
        .apply_chat_template(&template, &chat, true)
        .map_err(|error| EngineError::invalid(format!("apply {fallback} chat template: {error}")))
}

fn fallback_template(architecture: Option<&str>) -> &'static str {
    match architecture.map(str::to_ascii_lowercase) {
        Some(architecture) if architecture.contains("llama") => "llama3",
        _ => "chatml",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_templates_are_keyed_by_model_architecture() {
        assert_eq!(fallback_template(Some("llama")), "llama3");
        assert_eq!(fallback_template(Some("qwen2")), "chatml");
        assert_eq!(fallback_template(None), "chatml");
    }

    #[test]
    fn quant_is_inferred_from_common_gguf_names() {
        assert_eq!(
            quant_from_path(Path::new("Qwen-0.5B-Q8_0.gguf")).as_deref(),
            Some("Q8_0")
        );
        assert_eq!(
            quant_from_path(Path::new("Llama-3B-Q4_K_M.gguf")).as_deref(),
            Some("Q4_K_M")
        );
    }
}
