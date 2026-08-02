mod actor;
mod audio;
pub(crate) mod download;
mod transcriber;

use std::sync::Arc;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::require_development_feature;
use actor::{ActorHandle, ActorReply, StartOptions, VoxController};
use audio::{AudioSource, CpalAudioSource};
use transcriber::WhisperFactory;

pub const EVENT_ERROR: &str = "vox://error";

pub(crate) type EventSink = Arc<dyn Fn(VoxEvent) + Send + Sync>;
pub(crate) type ErrorSink = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxCapabilities {
    pub device: Option<String>,
    pub backend: String,
    pub model_path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxFinal {
    pub utterance_id: String,
    pub text: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoxCaptureState {
    Capturing,
    Transcribing,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum VoxEvent {
    Level { rms: f32 },
    State { state: VoxCaptureState },
    // Streaming partial hypothesis (KödWhisper Pro). Only emitted for a capture
    // started with streaming enabled; the text is the stabilized prefix.
    Partial { text: String },
    Error { message: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxDownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxDownloadResult {
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Default)]
pub struct VoxManager {
    actor: Mutex<Option<ActorHandle>>,
}

#[derive(Clone, Serialize)]
struct VoxErrorPayload {
    message: String,
}

impl VoxManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn controller(&self, app: AppHandle) -> Result<VoxController, String> {
        let mut actor = self
            .actor
            .lock()
            .map_err(|_| "transcription manager lock is poisoned".to_string())?;
        if actor.is_none() {
            let error_app = app.clone();
            let on_error: ErrorSink = Arc::new(move |message| {
                let _ = error_app.emit(EVENT_ERROR, VoxErrorPayload { message });
            });
            *actor = Some(ActorHandle::spawn(
                Box::new(WhisperFactory),
                Box::new(CpalAudioSource),
                on_error,
            )?);
        }
        actor
            .as_ref()
            .map(ActorHandle::controller)
            .ok_or_else(|| "transcription actor is unavailable".to_string())
    }
}

async fn wait_for_actor<T>(reply: ActorReply<T>) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        reply
            .recv()
            .map_err(|_| "transcription actor stopped before responding".to_string())?
    })
    .await
    .map_err(|e| format!("transcription command task failed: {e}"))?
}

#[tauri::command]
pub async fn vox_init(
    app: AppHandle,
    manager: State<'_, VoxManager>,
    model_path: String,
    device_name: Option<String>,
) -> Result<VoxCapabilities, String> {
    require_development_feature("KödWhisper")?;
    let controller = manager.controller(app)?;
    let reply = controller.enqueue_init(model_path, device_name)?;
    wait_for_actor(reply).await
}

// Expert input-device picker (Settings): every microphone name the host
// currently exposes. Enumeration can block briefly on some platforms, so it
// runs off the async runtime like the other vox commands.
#[tauri::command(rename_all = "camelCase")]
pub async fn vox_list_input_devices() -> Result<Vec<String>, String> {
    require_development_feature("KödWhisper")?;
    tauri::async_runtime::spawn_blocking(|| CpalAudioSource.list_input_devices())
        .await
        .map_err(|e| format!("list microphone devices task failed: {e}"))
}

// initial_prompt / streaming carry KödWhisper Pro intelligence (vocabulary bias
// + streaming partials). The engine stays tier-blind: TS decides whether to set
// them, and an absent flag simply means the classic free-tier decode.
#[tauri::command(rename_all = "camelCase")]
pub async fn vox_start(
    app: AppHandle,
    manager: State<'_, VoxManager>,
    language: Option<String>,
    initial_prompt: Option<String>,
    streaming: Option<bool>,
    on_event: Channel<VoxEvent>,
) -> Result<String, String> {
    require_development_feature("KödWhisper")?;
    let controller = manager.controller(app)?;
    let sink: EventSink = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    let reply = controller.enqueue_start(
        StartOptions {
            language,
            initial_prompt,
            streaming: streaming.unwrap_or(false),
        },
        sink,
    )?;
    wait_for_actor(reply).await
}

#[tauri::command]
pub async fn vox_stop(app: AppHandle, manager: State<'_, VoxManager>) -> Result<VoxFinal, String> {
    require_development_feature("KödWhisper")?;
    let controller = manager.controller(app)?;
    let reply = controller.enqueue_stop()?;
    wait_for_actor(reply).await
}

#[tauri::command]
pub async fn vox_cancel(app: AppHandle, manager: State<'_, VoxManager>) -> Result<(), String> {
    require_development_feature("KödWhisper")?;
    let controller = manager.controller(app)?;
    let reply = controller.enqueue_cancel()?;
    wait_for_actor(reply).await
}

#[tauri::command]
pub async fn vox_teardown(app: AppHandle, manager: State<'_, VoxManager>) -> Result<(), String> {
    require_development_feature("KödWhisper")?;
    let controller = manager.controller(app)?;
    let reply = controller.enqueue_teardown()?;
    wait_for_actor(reply).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn vox_download_model(
    app: AppHandle,
    url: String,
    dest_path: String,
    expected_sha256: Option<String>,
    // Expert storage-location override (an absolute directory the user picked
    // via the native folder dialog). None keeps the default appDataDir/models
    // root. Either way download::download_model confines dest_path inside it.
    model_root: Option<String>,
    on_progress: Channel<VoxDownloadProgress>,
) -> Result<VoxDownloadResult, String> {
    require_development_feature("KödWhisper")?;
    let model_root = match model_root {
        Some(root) => std::path::PathBuf::from(root),
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("resolve app data directory: {e}"))?
            .join("models"),
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::download::download_model(
            &url,
            &model_root,
            std::path::Path::new(&dest_path),
            expected_sha256.as_deref(),
            |progress| {
                let _ = on_progress.send(progress);
            },
        )
    })
    .await
    .map_err(|e| format!("model download task failed: {e}"))?
}

#[cfg(test)]
mod ipc_tests {
    use super::*;

    #[test]
    fn events_serialize_to_frozen_tagged_contract() {
        assert_eq!(
            serde_json::to_value(VoxEvent::Level { rms: 0.25 }).unwrap(),
            serde_json::json!({ "type": "level", "rms": 0.25 })
        );
        assert_eq!(
            serde_json::to_value(VoxEvent::State {
                state: VoxCaptureState::Transcribing,
            })
            .unwrap(),
            serde_json::json!({ "type": "state", "state": "transcribing" })
        );
        assert_eq!(
            serde_json::to_value(VoxEvent::Partial {
                text: "add a test".to_string(),
            })
            .unwrap(),
            serde_json::json!({ "type": "partial", "text": "add a test" })
        );
        assert_eq!(
            serde_json::to_value(VoxEvent::Error {
                message: "denied".to_string(),
            })
            .unwrap(),
            serde_json::json!({ "type": "error", "message": "denied" })
        );
    }

    #[test]
    fn result_structs_serialize_with_camel_case_fields() {
        let capabilities = VoxCapabilities {
            device: None,
            backend: "cpu".to_string(),
            model_path: "/tmp/model.bin".to_string(),
        };
        assert_eq!(
            serde_json::to_value(capabilities).unwrap(),
            serde_json::json!({
                "device": null,
                "backend": "cpu",
                "modelPath": "/tmp/model.bin"
            })
        );
        let progress = VoxDownloadProgress {
            downloaded: 12,
            total: Some(24),
        };
        assert_eq!(
            serde_json::to_value(progress).unwrap(),
            serde_json::json!({ "downloaded": 12, "total": 24 })
        );
    }
}
