// KödLocal's shared inference daemon: OpenAI-compatible loopback transport over
// an engine registry that selects native implementations by model format.

pub mod cli;
mod engine;
mod http;
#[cfg(feature = "modeld")]
mod llama;
#[cfg(all(feature = "modeld", target_os = "macos"))]
mod mlx;

pub use engine::{
    model_path_bytes, Capabilities, ChatDelta, ChatMessage, DeltaReceiver, EngineChatRequest,
    EngineError, EngineErrorKind, EngineRegistry, InferenceEngine, LoadParams, MemoryReport,
    ModelFormat, ModelHandle, ModelMetadata, SamplingParams, Supports,
};
pub use http::{router, AppState};

#[cfg(feature = "modeld")]
pub use llama::LlamaCppEngine;
#[cfg(all(feature = "modeld", target_os = "macos"))]
pub use mlx::MlxEngine;

#[cfg(feature = "modeld")]
pub async fn serve(config: cli::ServeConfig) -> Result<(), String> {
    use std::net::SocketAddr;
    use std::sync::Arc;

    if !config.host.is_loopback() {
        return Err(format!(
            "refusing non-loopback host {}; kodade-modeld is local-only",
            config.host
        ));
    }
    let engines: Vec<Arc<dyn InferenceEngine>> = vec![Arc::new(
        LlamaCppEngine::new().map_err(|error| error.to_string())?,
    )];
    #[cfg(target_os = "macos")]
    let engines = {
        let mut engines = engines;
        engines.push(Arc::new(MlxEngine::new()));
        engines
    };
    let registry = Arc::new(EngineRegistry::new(engines).map_err(|error| error.to_string())?);
    if let Some(model) = config.model {
        let loaded = registry
            .load(
                model,
                LoadParams {
                    context_length: config.context_length,
                },
            )
            .map_err(|error| error.to_string())?;
        println!("kodade-modeld: loaded {} ({})", loaded.name, loaded.id);
    }

    let addr = SocketAddr::new(config.host, config.port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| format!("bind {addr}: {error}"))?;
    let bound = listener.local_addr().map_err(|error| error.to_string())?;
    println!("kodade-modeld listening on http://{bound}");
    let state = AppState::new(Arc::clone(&registry));
    let requested_shutdown = state.shutdown_receiver();
    let result = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal(requested_shutdown, Arc::clone(&registry)))
        .await
        .map_err(|error| format!("server error: {error}"));
    // The router has stopped accepting work. Explicitly unload before the
    // registry drops so managed MLX sidecars are reaped on every shutdown path.
    registry.shutdown();
    result
}

#[cfg(feature = "modeld")]
async fn shutdown_signal(
    mut requested_shutdown: tokio::sync::watch::Receiver<bool>,
    registry: std::sync::Arc<EngineRegistry>,
) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
        _ = requested_shutdown.changed() => {}
    }
    eprintln!("kodade-modeld: shutting down");
    // Begin native/sidecar teardown as soon as shutdown is requested. The
    // detached blocking task runs alongside axum's graceful HTTP drain; the
    // idempotent call after serve returns remains a final join-side safety net.
    let _teardown = tokio::task::spawn_blocking(move || registry.shutdown());
}

#[cfg(feature = "modeld")]
pub(crate) fn hardware_ram_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut value: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        let result = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&mut value as *mut u64).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (result == 0).then_some(value)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        (pages > 0 && page_size > 0).then_some((pages as u64).saturating_mul(page_size as u64))
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        let succeeded = unsafe { GlobalMemoryStatusEx(&mut status) } != 0;
        succeeded.then_some(status.ullTotalPhys)
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        None
    }
}

#[cfg(feature = "modeld")]
pub(crate) fn ram_budget_bytes() -> Option<u64> {
    hardware_ram_bytes().map(|bytes| bytes.saturating_mul(9) / 10)
}
