// Tauri command surface — the invoke-able half of the typed IPC contract.
// Each command is a thin pass-through to the PtyManager; no logic here.
// spawn wraps the manager's output/exit sinks so they become Tauri events.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

#[cfg(any(target_os = "windows", test))]
use std::ffi::OsString;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::agent::{AgentManager, AgentSpawn};
use crate::config::{self, ConfigScan};
use crate::configguard::{Access, ConfigGuard};
use crate::detect;
use crate::fs::{self, DirEntry, FileRead, WatchHandle};
use crate::git::{self, GitOutput};
use crate::github::{self, GhOutput};
use crate::modeld::{model_path_bytes, ModelFormat};
use crate::pathguard;
use crate::pty::PtyManager;
use crate::shell::ShellEnvironment;
use crate::ssh::{self, SshDetectResult, SshExecResult};
use crate::storage;

fn development_feature_access(enabled: bool, name: &str) -> Result<(), String> {
    if enabled {
        Ok(())
    } else {
        Err(format!("{name} is unavailable in the public release"))
    }
}

pub(crate) fn require_development_feature(name: &str) -> Result<(), String> {
    development_feature_access(cfg!(feature = "development-features") || cfg!(test), name)
}

#[cfg(test)]
mod release_feature_tests {
    use super::development_feature_access;

    #[test]
    fn public_native_feature_commands_fail_closed() {
        assert_eq!(
            development_feature_access(false, "KödSSH"),
            Err("KödSSH is unavailable in the public release".to_string())
        );
    }
}

// Event names — the Rust half of the typed IPC contract. Frontend mirrors these.
pub const EVENT_OUTPUT: &str = "pty://output";
pub const EVENT_EXIT: &str = "pty://exit";
pub const EVENT_FS_CHANGED: &str = "fs://changed";
// KödChat headless agent runs (issue #163).
pub const EVENT_AGENT_EVENT: &str = "agent://event";
pub const EVENT_AGENT_EXIT: &str = "agent://exit";

// Holds the single active project watcher. Switching projects stops the old
// one and starts a new one, so only one recursive watch runs at a time.
#[derive(Default)]
struct WatchState {
    generation: u64,
    current: Option<WatchHandle>,
    root: Option<String>,
}

#[derive(Default)]
pub struct WatchManager {
    state: Mutex<WatchState>,
}

const LOCAL_MODELD_PORT: u16 = 4_470;
const LOCAL_HEALTH_TIMEOUT: Duration = Duration::from_millis(250);

enum ModeldLifecycle {
    Stopped,
    Starting { child: Option<Child> },
    Running { child: Option<Child> },
    Stopping { child: Option<Child> },
}

struct ModeldState {
    lifecycle: ModeldLifecycle,
    port: u16,
}

impl Default for ModeldState {
    fn default() -> Self {
        Self {
            lifecycle: ModeldLifecycle::Stopped,
            port: LOCAL_MODELD_PORT,
        }
    }
}

// This manager intentionally does not kill its child on app exit. The daemon
// is shared resident-model infrastructure; only the explicit stop command
// ends a daemon this desktop process started.
#[derive(Default)]
pub struct ModeldManager {
    state: Mutex<ModeldState>,
}

impl ModeldManager {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDaemonStatus {
    running: bool,
    managed: bool,
    port: u16,
    binary_path: Option<String>,
    cli_path: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDownloadResult {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelPathInfo {
    path: String,
    bytes: u64,
    format: String,
}

fn modeld_binary_name() -> &'static str {
    if cfg!(windows) {
        "kodade-modeld.exe"
    } else {
        "kodade-modeld"
    }
}

fn local_cli_name() -> &'static str {
    "kodade-local.mjs"
}

const LOCAL_BIN_RESOURCE_DIR: &str = "kodade-local/bin";
const LOCAL_CLI_RESOURCE_PATH: &str = "kodade-local/kodade-local.mjs";
const KODSKILLS_RESOURCE_DIR: &str = "kodskills";
// llama.cpp initializes Metal before binding the health endpoint. A cold
// Apple Silicon launch can take around nine seconds, so the desktop manager
// must not reap a healthy daemon on the old four-second budget.
const LOCAL_MODELD_START_ATTEMPTS: usize = 300;
const LOCAL_MODELD_START_DELAY: Duration = Duration::from_millis(100);

fn dev_target_dir(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|ancestor| ancestor.file_name().is_some_and(|name| name == "target"))
        .map(Path::to_path_buf)
}

fn bundled_modeld_path(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join(LOCAL_BIN_RESOURCE_DIR)
        .join(modeld_binary_name())
}

fn bundled_local_cli_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join(LOCAL_CLI_RESOURCE_PATH)
}

fn resolve_kodskills_resource(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|root| root.join(KODSKILLS_RESOURCE_DIR));
    if let Some(path) = bundled
        .as_ref()
        .filter(|path| path.join("pack.json").is_file())
    {
        return Ok(path.clone());
    }
    let development = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join("resources").join(KODSKILLS_RESOURCE_DIR))
        .ok_or_else(|| "cannot resolve the KödSkills development resource path".to_string())?;
    if development.join("pack.json").is_file() {
        return Ok(development);
    }
    Err("KödSkills pack was not found in app resources or resources/kodskills".to_string())
}

fn resolve_modeld_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("KODADE_MODELD_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "KODADE_MODELD_PATH does not point to a file: {}",
            path.display()
        ));
    }
    let resource = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| bundled_modeld_path(&dir));
    if let Some(path) = resource.as_ref().filter(|candidate| candidate.is_file()) {
        return Ok(path.clone());
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("cannot locate the running Kodade executable: {error}"))?;
    let debug =
        dev_target_dir(&executable).map(|target| target.join("debug").join(modeld_binary_name()));
    if let Some(path) = debug.as_ref().filter(|candidate| candidate.is_file()) {
        return Ok(path.clone());
    }
    let debug_hint = debug
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "<workspace>/src-tauri/target/debug/kodade-modeld".into());
    Err(format!(
        "kodade-modeld was not found in the bundled {LOCAL_BIN_RESOURCE_DIR} resource or at {debug_hint}; run `pnpm build:modeld` for a package build",
    ))
}

fn resolve_local_cli(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("KODADE_LOCAL_CLI_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "KODADE_LOCAL_CLI_PATH does not point to a file: {}",
            path.display()
        ));
    }
    let resource = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| bundled_local_cli_path(&dir));
    if let Some(path) = resource.as_ref().filter(|candidate| candidate.is_file()) {
        return Ok(path.clone());
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("cannot locate the running Kodade executable: {error}"))?;
    let sibling = executable
        .parent()
        .map(|dir| dir.join(local_cli_name()))
        .filter(|path| path.is_file());
    if let Some(path) = sibling {
        return Ok(path);
    }
    let debug = dev_target_dir(&executable).and_then(|target| {
        target
            .parent()
            .and_then(Path::parent)
            .map(|workspace| workspace.join("dist-cli").join(local_cli_name()))
    });
    if let Some(path) = debug.as_ref().filter(|candidate| candidate.is_file()) {
        return Ok(path.clone());
    }
    Err("kodade-local.mjs was not found; run `pnpm build:cli`".to_string())
}

#[derive(Deserialize)]
struct ModeldHealth {
    service: String,
    protocol: u8,
}

fn modeld_healthy(port: u16) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(LOCAL_HEALTH_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let Ok(response) = client
        .get(format!("http://127.0.0.1:{port}/kod/health"))
        .send()
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .text()
        .ok()
        .and_then(|body| serde_json::from_str::<ModeldHealth>(&body).ok())
        .is_some_and(|health| health.service == "kodade-modeld" && health.protocol == 1)
}

fn request_modeld_shutdown(port: u16) -> bool {
    // A port can be occupied by any local service. Only a marker-verified
    // modeld may ever receive the shutdown route, even if another caller uses
    // this helper in the future.
    if !modeld_healthy(port) {
        return false;
    }
    let client = match reqwest::blocking::Client::builder()
        .timeout(LOCAL_HEALTH_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .post(format!("http://127.0.0.1:{port}/kod/shutdown"))
        .header("x-kodade-modeld", "1")
        .send()
        .is_ok_and(|response| response.status().is_success())
}

trait ModeldHttp {
    fn healthy(&self, port: u16) -> bool;
    fn request_shutdown(&self, port: u16) -> bool;
}

struct SystemModeldHttp;

impl ModeldHttp for SystemModeldHttp {
    fn healthy(&self, port: u16) -> bool {
        modeld_healthy(port)
    }

    fn request_shutdown(&self, port: u16) -> bool {
        request_modeld_shutdown(port)
    }
}

fn lifecycle_has_child(lifecycle: &ModeldLifecycle) -> bool {
    matches!(
        lifecycle,
        ModeldLifecycle::Starting { child: Some(_) }
            | ModeldLifecycle::Running { child: Some(_) }
            | ModeldLifecycle::Stopping { child: Some(_) }
    )
}

fn reap_exited_locked(state: &mut ModeldState) {
    let exited = match &mut state.lifecycle {
        ModeldLifecycle::Running { child: Some(child) } => {
            child.try_wait().ok().flatten().is_some()
        }
        _ => false,
    };
    if exited {
        state.lifecycle = ModeldLifecycle::Stopped;
    }
}

fn reserve_start(manager: &ModeldManager, port: u16) -> Result<Option<Child>, String> {
    let mut state = manager.state.lock().expect("modeld manager lock");
    reap_exited_locked(&mut state);
    let previous = std::mem::replace(
        &mut state.lifecycle,
        ModeldLifecycle::Starting { child: None },
    );
    match previous {
        ModeldLifecycle::Stopped => {
            state.port = port;
            Ok(None)
        }
        ModeldLifecycle::Running { child } => {
            state.port = port;
            Ok(child)
        }
        ModeldLifecycle::Starting { child } => {
            state.lifecycle = ModeldLifecycle::Starting { child };
            Err("KödLocal daemon is already starting".to_string())
        }
        ModeldLifecycle::Stopping { child } => {
            state.lifecycle = ModeldLifecycle::Stopping { child };
            Err("KödLocal daemon is stopping; wait for it to finish".to_string())
        }
    }
}

fn finish_start(manager: &ModeldManager) -> Result<(), String> {
    let mut state = manager.state.lock().expect("modeld manager lock");
    let previous = std::mem::replace(&mut state.lifecycle, ModeldLifecycle::Stopped);
    match previous {
        ModeldLifecycle::Starting { child } => {
            state.lifecycle = ModeldLifecycle::Running { child };
            Ok(())
        }
        other => {
            state.lifecycle = other;
            Err("KödLocal daemon lifecycle changed while starting".to_string())
        }
    }
}

fn set_starting_child(manager: &ModeldManager, child: Child) -> Result<(), (String, Child)> {
    let mut state = manager.state.lock().expect("modeld manager lock");
    match &mut state.lifecycle {
        ModeldLifecycle::Starting { child: slot @ None } => {
            *slot = Some(child);
            Ok(())
        }
        _ => Err((
            "KödLocal daemon lifecycle changed before the child was registered".to_string(),
            child,
        )),
    }
}

fn restore_running_child(manager: &ModeldManager, child: Child) {
    let mut state = manager.state.lock().expect("modeld manager lock");
    state.lifecycle = ModeldLifecycle::Running { child: Some(child) };
}

fn set_stopped(manager: &ModeldManager) {
    manager.state.lock().expect("modeld manager lock").lifecycle = ModeldLifecycle::Stopped;
}

fn kill_and_reap(child: &mut Child) -> Result<std::process::ExitStatus, String> {
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("inspect kodade-modeld: {error}"))?
    {
        return Ok(status);
    }
    child
        .kill()
        .map_err(|error| format!("stop kodade-modeld: {error}"))?;
    child
        .wait()
        .map_err(|error| format!("wait for kodade-modeld to stop: {error}"))
}

fn abort_start_and_reap(
    manager: &ModeldManager,
) -> Result<Option<std::process::ExitStatus>, String> {
    let child = {
        let mut state = manager.state.lock().expect("modeld manager lock");
        let previous = std::mem::replace(
            &mut state.lifecycle,
            ModeldLifecycle::Stopping { child: None },
        );
        match previous {
            ModeldLifecycle::Starting { child } => child,
            other => {
                state.lifecycle = other;
                return Err("KödLocal daemon lifecycle changed while starting".to_string());
            }
        }
    };
    match child {
        Some(mut child) => match kill_and_reap(&mut child) {
            Ok(status) => {
                set_stopped(manager);
                Ok(Some(status))
            }
            Err(error) => {
                // Retain the handle so a failed kill or wait never turns a
                // live child into an orphaned process.
                restore_running_child(manager, child);
                Err(error)
            }
        },
        None => {
            set_stopped(manager);
            Ok(None)
        }
    }
}

fn start_modeld_with<H, F>(
    manager: &ModeldManager,
    port: u16,
    binary: &Path,
    http: &H,
    attempts: usize,
    delay: Duration,
    spawn: F,
) -> Result<(), String>
where
    H: ModeldHttp,
    F: FnOnce(&Path, u16) -> Result<Child, String>,
{
    let existing_child = reserve_start(manager, port)?;
    if http.healthy(port) {
        if let Some(child) = existing_child {
            if let Err((error, child)) = set_starting_child(manager, child) {
                restore_running_child(manager, child);
                return Err(error);
            }
        }
        return finish_start(manager);
    }

    if let Some(mut child) = existing_child {
        if let Err(error) = kill_and_reap(&mut child) {
            restore_running_child(manager, child);
            return Err(error);
        }
    }

    let child = match spawn(binary, port) {
        Ok(child) => child,
        Err(error) => {
            set_stopped(manager);
            return Err(error);
        }
    };
    if let Err((error, child)) = set_starting_child(manager, child) {
        restore_running_child(manager, child);
        return Err(error);
    }

    for _ in 0..attempts {
        if http.healthy(port) {
            return finish_start(manager);
        }
        thread::sleep(delay);
    }

    let detail = abort_start_and_reap(manager)?
        .map(|status| format!(" (process exited with {status})"))
        .unwrap_or_default();
    Err(format!(
        "kodade-modeld did not become healthy on port {port}{detail}"
    ))
}

fn begin_stop(manager: &ModeldManager) -> Result<(u16, bool), String> {
    let mut state = manager.state.lock().expect("modeld manager lock");
    reap_exited_locked(&mut state);
    let port = state.port;
    let previous = std::mem::replace(
        &mut state.lifecycle,
        ModeldLifecycle::Stopping { child: None },
    );
    match previous {
        ModeldLifecycle::Running { child } => {
            let managed = child.is_some();
            state.lifecycle = ModeldLifecycle::Stopping { child };
            Ok((port, managed))
        }
        ModeldLifecycle::Stopped => {
            state.lifecycle = ModeldLifecycle::Stopped;
            Ok((port, false))
        }
        ModeldLifecycle::Starting { child } => {
            state.lifecycle = ModeldLifecycle::Starting { child };
            Err("KödLocal daemon is starting; wait for it to finish".to_string())
        }
        ModeldLifecycle::Stopping { child } => {
            state.lifecycle = ModeldLifecycle::Stopping { child };
            Err("KödLocal daemon is already stopping".to_string())
        }
    }
}

fn restore_running(manager: &ModeldManager) {
    let mut state = manager.state.lock().expect("modeld manager lock");
    let previous = std::mem::replace(&mut state.lifecycle, ModeldLifecycle::Stopped);
    state.lifecycle = match previous {
        ModeldLifecycle::Stopping { child } => ModeldLifecycle::Running { child },
        other => other,
    };
}

fn stopping_child_exited(manager: &ModeldManager) -> Result<bool, String> {
    let mut state = manager.state.lock().expect("modeld manager lock");
    let exited = match &mut state.lifecycle {
        ModeldLifecycle::Stopping { child: Some(child) } => child
            .try_wait()
            .map_err(|error| format!("inspect kodade-modeld while stopping: {error}"))?
            .is_some(),
        ModeldLifecycle::Stopping { child: None } => false,
        _ => return Err("KödLocal daemon lifecycle changed while stopping".to_string()),
    };
    if exited {
        state.lifecycle = ModeldLifecycle::Stopped;
    }
    Ok(exited)
}

fn take_stopping_child(manager: &ModeldManager) -> Result<Option<Child>, String> {
    let mut state = manager.state.lock().expect("modeld manager lock");
    let previous = std::mem::replace(
        &mut state.lifecycle,
        ModeldLifecycle::Stopping { child: None },
    );
    match previous {
        ModeldLifecycle::Stopping { child } => Ok(child),
        other => {
            state.lifecycle = other;
            Err("KödLocal daemon lifecycle changed while stopping".to_string())
        }
    }
}

fn stop_modeld_with<H>(
    manager: &ModeldManager,
    http: &H,
    attempts: usize,
    delay: Duration,
) -> Result<(), String>
where
    H: ModeldHttp,
{
    let (port, managed) = begin_stop(manager)?;
    if !managed {
        // A stopped manager must not issue a shutdown request merely because an
        // unrelated loopback service happens to occupy its remembered port.
        if !http.healthy(port) {
            set_stopped(manager);
            return Ok(());
        }
    }
    if !http.healthy(port) {
        if let Some(mut child) = take_stopping_child(manager)? {
            return match kill_and_reap(&mut child) {
                Ok(_) => {
                    set_stopped(manager);
                    Ok(())
                }
                Err(error) => {
                    restore_running_child(manager, child);
                    Err(error)
                }
            };
        }
        set_stopped(manager);
        return Err("refusing to stop an unverified process on the KödLocal port".to_string());
    }
    if !http.request_shutdown(port) {
        // Keep the actual handle in the state machine: a transient HTTP
        // failure must not orphan a child we are still responsible for.
        restore_running(manager);
        return Err("kodade-modeld refused the shutdown request".to_string());
    }

    if managed {
        for _ in 0..attempts {
            if stopping_child_exited(manager)? {
                return Ok(());
            }
            thread::sleep(delay);
        }
        return match take_stopping_child(manager)? {
            Some(mut child) => match kill_and_reap(&mut child) {
                Ok(_) => {
                    set_stopped(manager);
                    Ok(())
                }
                Err(error) => {
                    restore_running_child(manager, child);
                    Err(error)
                }
            },
            None => {
                set_stopped(manager);
                Ok(())
            }
        };
    }

    for _ in 0..attempts {
        if !http.healthy(port) {
            set_stopped(manager);
            return Ok(());
        }
        thread::sleep(delay);
    }
    restore_running(manager);
    Err("kodade-modeld did not stop after accepting the shutdown request".to_string())
}

fn daemon_status(app: &AppHandle, manager: &ModeldManager) -> LocalDaemonStatus {
    let (managed, port) = {
        let mut state = manager.state.lock().expect("modeld manager lock");
        reap_exited_locked(&mut state);
        (lifecycle_has_child(&state.lifecycle), state.port)
    };
    let binary = resolve_modeld_binary(app);
    let cli = resolve_local_cli(app);
    let message = binary
        .as_ref()
        .err()
        .cloned()
        .or_else(|| cli.as_ref().err().cloned());
    LocalDaemonStatus {
        running: modeld_healthy(port),
        managed,
        port,
        binary_path: binary.ok().map(|path| path.to_string_lossy().to_string()),
        cli_path: cli.ok().map(|path| path.to_string_lossy().to_string()),
        message,
    }
}

fn local_model_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("models").join("local"))
        .map_err(|error| format!("resolve local model directory: {error}"))
}

// Mirror the webview's activated token into app data for the
// kodade-local CLI. Rust remains tier-blind: verification and feature selection
// stay in the one shared TypeScript license module.
#[tauri::command]
pub fn license_token_write(app: AppHandle, token: Option<String>) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve app data directory: {error}"))?;
    crate::license::write_shared_token(&data_dir, token.as_deref())
}

fn valid_local_file_name(file_name: &str) -> bool {
    Path::new(file_name)
        .file_name()
        .is_some_and(|name| name == file_name)
        && file_name.to_ascii_lowercase().ends_with(".gguf")
}

impl WatchManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn active_root(&self) -> Option<String> {
        self.state.lock().unwrap().root.clone()
    }

    // A delayed IPC request from an older root generation must never replace the
    // active root. Root and watcher move together under one lock so URI requests
    // cannot observe a mismatched pair.
    fn replace(&self, generation: u64, root: String, handle: WatchHandle) {
        let previous = {
            let mut state = self.state.lock().unwrap();
            if generation < state.generation {
                return; // stale watcher drops with `handle`
            }
            state.generation = generation;
            state.root = Some(root);
            state.current.replace(handle)
        };
        if let Some(previous) = previous {
            previous.stop();
        }
    }

    fn clear(&self, generation: u64) {
        let previous = {
            let mut state = self.state.lock().unwrap();
            if generation < state.generation {
                return;
            }
            state.generation = generation;
            state.root = None;
            state.current.take()
        };
        if let Some(handle) = previous {
            handle.stop();
        }
    }
}

// Affected paths from one debounced burst of filesystem changes.
#[derive(Clone, Serialize)]
struct FsChanged {
    paths: Vec<String>,
}

// One base64 output chunk from a PTY. base64 survives arbitrary binary escapes.
#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    data: String,
}

// Emitted once when the child process exits.
#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
    code: Option<i32>,
}

// Spawn a login shell PTY with the given id, working dir, and initial size.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let out_app = app.clone();
    let on_output = Arc::new(move |id: String, data: String| {
        let _ = out_app.emit(EVENT_OUTPUT, PtyOutput { id, data });
    });
    let exit_app = app.clone();
    let on_exit = Arc::new(move |id: String, code: Option<i32>| {
        let _ = exit_app.emit(EVENT_EXIT, PtyExit { id, code });
    });
    manager.spawn(id, cwd, cols, rows, on_output, on_exit)
}

// Write base64-encoded input bytes to a PTY (base64 survives binary sequences).
#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    manager.write(&id, &bytes)
}

// Resize a PTY to cols x rows.
#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows)
}

// Kill a PTY's child process.
#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.kill(&id)
}

// Name of the process in the foreground of a PTY (the shell when idle, the
// running command otherwise). Drives session auto-naming and the status dot's
// running pulse. Cheap (a tcgetpgrp + one proc lookup); the frontend polls it
// lightly for visible sessions only. None for unknown ids or unresolved names.
#[tauri::command]
pub fn pty_foreground(manager: State<'_, PtyManager>, id: String) -> Option<String> {
    manager.foreground(&id)
}

// --- KödChat headless agent runs ---
//
// The chat counterpart to the pty_* surface. Thin pass-throughs: TypeScript
// builds the argv (from providers/catalog.ts) and parses every line it gets
// back (src/agents/), so no CLI dialect knowledge exists in Rust.

// One raw stdout line from a run. Parsing is entirely TypeScript's job.
#[derive(Clone, Serialize)]
struct AgentEvent {
    id: String,
    line: String,
}

// Emitted once when a run's process exits, carrying its captured stderr tail.
#[derive(Clone, Serialize)]
struct AgentExit {
    id: String,
    code: Option<i32>,
    stderr: String,
}

// Start a headless agent run. `bin` is resolved through the login shell so the
// CLI inherits the user's real PATH — and therefore its own credentials.
#[tauri::command]
pub fn agent_start(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    id: String,
    cwd: String,
    bin: String,
    args: Vec<String>,
    stdin: Option<String>,
) -> Result<(), String> {
    let line_app = app.clone();
    let on_line = Arc::new(move |id: String, line: String| {
        let _ = line_app.emit(EVENT_AGENT_EVENT, AgentEvent { id, line });
    });
    let exit_app = app.clone();
    let on_exit = Arc::new(move |id: String, code: Option<i32>, stderr: String| {
        let _ = exit_app.emit(EVENT_AGENT_EXIT, AgentExit { id, code, stderr });
    });
    manager.start(
        AgentSpawn {
            id,
            cwd,
            bin,
            args,
            stdin,
        },
        on_line,
        on_exit,
    )
}

// Write to a run whose stdin is still open (interactive stream-input dialects).
#[tauri::command]
pub fn agent_send(
    manager: State<'_, AgentManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    manager.send(&id, &data)
}

// Kill a run's process group. Its exit event still arrives.
#[tauri::command]
pub fn agent_cancel(manager: State<'_, AgentManager>, id: String) -> Result<(), String> {
    manager.cancel(&id)
}

// --- KödLocal daemon control plane ---
//
// The webview talks to the loopback HTTP data plane directly. These commands
// only resolve files and manage the long-lived resident daemon process.

#[tauri::command]
pub fn local_modeld_status(
    app: AppHandle,
    manager: State<'_, ModeldManager>,
) -> Result<LocalDaemonStatus, String> {
    require_development_feature("KödLocal")?;
    Ok(daemon_status(&app, &manager))
}

#[tauri::command]
pub fn local_modeld_start(
    app: AppHandle,
    manager: State<'_, ModeldManager>,
    port: Option<u16>,
) -> Result<LocalDaemonStatus, String> {
    require_development_feature("KödLocal")?;
    let port = port.unwrap_or(LOCAL_MODELD_PORT);
    if port == 0 {
        return Err("KödLocal daemon port must be between 1 and 65535".to_string());
    }
    let binary = resolve_modeld_binary(&app)?;
    let http = SystemModeldHttp;
    start_modeld_with(
        &manager,
        port,
        &binary,
        &http,
        LOCAL_MODELD_START_ATTEMPTS,
        LOCAL_MODELD_START_DELAY,
        |binary, port| {
            let port_string = port.to_string();
            Command::new(binary)
                .args(["--host", "127.0.0.1", "--port", &port_string])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("start kodade-modeld at {}: {error}", binary.display()))
        },
    )?;
    Ok(daemon_status(&app, &manager))
}

#[tauri::command]
pub fn local_modeld_stop(manager: State<'_, ModeldManager>) -> Result<(), String> {
    require_development_feature("KödLocal")?;
    stop_modeld_with(&manager, &SystemModeldHttp, 20, Duration::from_millis(50))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_download_model(
    app: AppHandle,
    url: String,
    file_name: String,
    expected_sha256: String,
    on_progress: Channel<crate::vox::VoxDownloadProgress>,
) -> Result<LocalDownloadResult, String> {
    require_development_feature("KödLocal")?;
    if !valid_local_file_name(&file_name) {
        return Err("local model file name must be a plain .gguf file name".to_string());
    }
    let root = local_model_root(&app)?;
    let destination = root.join(&file_name);
    tauri::async_runtime::spawn_blocking(move || {
        crate::download::download_model(
            &url,
            &root,
            &destination,
            Some(&expected_sha256),
            |progress| {
                let _ = on_progress.send(progress);
            },
        )
        .map(|result| LocalDownloadResult {
            path: destination.to_string_lossy().to_string(),
            sha256: result.sha256,
            bytes: result.bytes,
        })
    })
    .await
    .map_err(|error| format!("local model download task failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_model_path(app: AppHandle, file_name: String) -> Result<String, String> {
    require_development_feature("KödLocal")?;
    if !valid_local_file_name(&file_name) {
        return Err("local model file name must be a plain .gguf file name".to_string());
    }
    Ok(local_model_root(&app)?
        .join(file_name)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn local_validate_model(path: String) -> Result<LocalModelPathInfo, String> {
    require_development_feature("KödLocal")?;
    let candidate = PathBuf::from(path);
    if !candidate.is_absolute() {
        return Err(
            "custom local model must be an absolute GGUF file or MLX model directory".to_string(),
        );
    }
    // The manager and daemon use this same format detector: .gguf files map
    // to llama.cpp; a directory requires config.json plus a safetensors weight
    // before it is accepted as an MLX snapshot.
    let format = ModelFormat::from_path(&candidate).map_err(|error| error.to_string())?;
    validate_local_model_platform(format, cfg!(target_os = "macos"))?;
    let path = std::fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "resolve custom local model {}: {error}",
            candidate.display()
        )
    })?;
    let bytes = model_path_bytes(&path, format).map_err(|error| error.to_string())?;
    Ok(LocalModelPathInfo {
        path: path.to_string_lossy().to_string(),
        bytes,
        format: match format {
            ModelFormat::Gguf => "gguf",
            ModelFormat::Mlx => "mlx",
        }
        .to_string(),
    })
}

fn validate_local_model_platform(format: ModelFormat, is_macos: bool) -> Result<(), String> {
    if format == ModelFormat::Mlx && !is_macos {
        Err(
            "MLX custom models are available only on macOS; use a GGUF model on this platform."
                .to_string(),
        )
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod local_model_validation_tests {
    use super::{validate_local_model_platform, ModelFormat};

    #[cfg(target_os = "macos")]
    use super::local_validate_model;

    #[cfg(target_os = "macos")]
    #[test]
    fn validates_an_mlx_snapshot_with_the_daemon_format_rule() {
        let temp = tempfile::tempdir().unwrap();
        let model = temp.path().join("qwen-mlx");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), "{}").unwrap();
        std::fs::write(model.join("model.safetensors"), "weights").unwrap();

        let info = local_validate_model(model.to_string_lossy().to_string()).unwrap();
        assert_eq!(info.format, "mlx");
        assert!(info.bytes >= 9);
    }

    #[test]
    fn rejects_mlx_custom_paths_on_non_macos_platforms() {
        let error = validate_local_model_platform(ModelFormat::Mlx, false).unwrap_err();

        assert_eq!(
            error,
            "MLX custom models are available only on macOS; use a GGUF model on this platform."
        );
        assert!(validate_local_model_platform(ModelFormat::Gguf, false).is_ok());
    }
}

#[cfg(test)]
mod modeld_lifecycle_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};

    struct FakeHttp {
        healthy: AtomicBool,
        shutdown_succeeds: AtomicBool,
        shutdown_calls: AtomicUsize,
    }

    struct DelayedStartupHttp {
        health_checks: AtomicUsize,
        ready_after: usize,
    }

    impl FakeHttp {
        fn new(healthy: bool, shutdown_succeeds: bool) -> Self {
            Self {
                healthy: AtomicBool::new(healthy),
                shutdown_succeeds: AtomicBool::new(shutdown_succeeds),
                shutdown_calls: AtomicUsize::new(0),
            }
        }
    }

    impl ModeldHttp for FakeHttp {
        fn healthy(&self, _port: u16) -> bool {
            self.healthy.load(Ordering::SeqCst)
        }

        fn request_shutdown(&self, _port: u16) -> bool {
            self.shutdown_calls.fetch_add(1, Ordering::SeqCst);
            self.shutdown_succeeds.load(Ordering::SeqCst)
        }
    }

    impl ModeldHttp for DelayedStartupHttp {
        fn healthy(&self, _port: u16) -> bool {
            self.health_checks.fetch_add(1, Ordering::SeqCst) + 1 >= self.ready_after
        }

        fn request_shutdown(&self, _port: u16) -> bool {
            false
        }
    }

    #[cfg(unix)]
    fn long_lived_child() -> Child {
        Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .spawn()
            .expect("spawn test child")
    }

    #[cfg(windows)]
    fn long_lived_child() -> Child {
        Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .spawn()
            .expect("spawn test child")
    }

    fn state_is_stopped(manager: &ModeldManager) -> bool {
        matches!(
            &manager.state.lock().expect("modeld manager lock").lifecycle,
            ModeldLifecycle::Stopped
        )
    }

    fn install_running_child(manager: &ModeldManager, port: u16) {
        let mut state = manager.state.lock().expect("modeld manager lock");
        state.port = port;
        state.lifecycle = ModeldLifecycle::Running {
            child: Some(long_lived_child()),
        };
    }

    #[test]
    fn packaged_helpers_resolve_from_the_stable_resource_paths() {
        let resources = Path::new("/Applications/kodade.app/Contents/Resources");
        assert_eq!(
            bundled_local_cli_path(resources),
            resources.join("kodade-local/kodade-local.mjs")
        );
        assert_eq!(
            bundled_modeld_path(resources),
            resources
                .join("kodade-local/bin")
                .join(modeld_binary_name())
        );
    }

    #[test]
    fn packaged_startup_budget_allows_a_slow_cold_engine_init() {
        let manager = ModeldManager::new();
        let http = DelayedStartupHttp {
            health_checks: AtomicUsize::new(0),
            ready_after: 90,
        };

        start_modeld_with(
            &manager,
            44_699,
            Path::new("modeld"),
            &http,
            LOCAL_MODELD_START_ATTEMPTS,
            Duration::ZERO,
            |_, _| {
                #[cfg(unix)]
                let child = Command::new("sh").args(["-c", "exit 0"]).spawn();
                #[cfg(windows)]
                let child = Command::new("cmd").args(["/C", "exit 0"]).spawn();
                child.map_err(|error| error.to_string())
            },
        )
        .expect("the packaged startup budget must cover cold Metal initialization");
    }

    #[test]
    fn double_start_is_rejected_while_the_first_start_owns_the_lifecycle() {
        let manager = Arc::new(ModeldManager::new());
        let http = Arc::new(FakeHttp::new(false, false));
        let (spawned_tx, spawned_rx) = mpsc::channel();
        let first_manager = manager.clone();
        let first_http = http.clone();
        let first = thread::spawn(move || {
            start_modeld_with(
                &first_manager,
                44_700,
                Path::new("modeld"),
                first_http.as_ref(),
                50,
                Duration::from_millis(5),
                move |_, _| {
                    let child = long_lived_child();
                    spawned_tx.send(()).unwrap();
                    Ok(child)
                },
            )
        });
        spawned_rx.recv().unwrap();

        let second = start_modeld_with(
            &manager,
            44_700,
            Path::new("modeld"),
            http.as_ref(),
            1,
            Duration::ZERO,
            |_, _| Ok(long_lived_child()),
        )
        .expect_err("a second start must not race the first");
        assert!(second.contains("already starting"));
        assert!(first.join().unwrap().is_err());
        assert!(state_is_stopped(&manager));
    }

    #[test]
    fn stop_during_start_is_rejected_without_losing_the_child() {
        let manager = Arc::new(ModeldManager::new());
        let http = Arc::new(FakeHttp::new(false, false));
        let (spawned_tx, spawned_rx) = mpsc::channel();
        let first_manager = manager.clone();
        let first_http = http.clone();
        let first = thread::spawn(move || {
            start_modeld_with(
                &first_manager,
                44_701,
                Path::new("modeld"),
                first_http.as_ref(),
                50,
                Duration::from_millis(5),
                move |_, _| {
                    let child = long_lived_child();
                    spawned_tx.send(()).unwrap();
                    Ok(child)
                },
            )
        });
        spawned_rx.recv().unwrap();

        let error = stop_modeld_with(&manager, http.as_ref(), 1, Duration::ZERO)
            .expect_err("stop must not race an in-flight start");
        assert!(error.contains("is starting"));
        assert!(first.join().unwrap().is_err());
        assert!(state_is_stopped(&manager));
    }

    #[test]
    fn start_during_stop_is_rejected_until_the_owned_child_is_reaped() {
        let manager = Arc::new(ModeldManager::new());
        let http = Arc::new(FakeHttp::new(true, true));
        install_running_child(&manager, 44_702);
        let stop_manager = manager.clone();
        let stop_http = http.clone();
        let stop = thread::spawn(move || {
            stop_modeld_with(
                &stop_manager,
                stop_http.as_ref(),
                20,
                Duration::from_millis(5),
            )
        });
        for _ in 0..100 {
            if http.shutdown_calls.load(Ordering::SeqCst) != 0 {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert_ne!(http.shutdown_calls.load(Ordering::SeqCst), 0);

        let error = start_modeld_with(
            &manager,
            44_702,
            Path::new("modeld"),
            http.as_ref(),
            1,
            Duration::ZERO,
            |_, _| Ok(long_lived_child()),
        )
        .expect_err("start must not race stop");
        assert!(error.contains("is stopping"));
        stop.join().unwrap().unwrap();
        assert!(state_is_stopped(&manager));
    }

    #[test]
    fn startup_timeout_kills_and_reaps_the_spawned_child() {
        let manager = ModeldManager::new();
        let http = FakeHttp::new(false, false);
        let child_pid = Arc::new(AtomicUsize::new(0));
        let recorded_pid = child_pid.clone();

        let error = start_modeld_with(
            &manager,
            44_703,
            Path::new("modeld"),
            &http,
            1,
            Duration::ZERO,
            move |_, _| {
                let child = long_lived_child();
                recorded_pid.store(child.id() as usize, Ordering::SeqCst);
                Ok(child)
            },
        )
        .expect_err("an unhealthy child must time out");

        assert!(error.contains("did not become healthy"));
        assert!(state_is_stopped(&manager));
        #[cfg(unix)]
        assert_eq!(
            unsafe { libc::kill(child_pid.load(Ordering::SeqCst) as i32, 0) },
            -1,
            "the timed-out child must be reaped, not dropped alive"
        );
    }

    #[test]
    fn shutdown_request_failure_restores_running_child_ownership() {
        let manager = ModeldManager::new();
        let http = FakeHttp::new(true, false);
        install_running_child(&manager, 44_704);

        let error = stop_modeld_with(&manager, &http, 1, Duration::ZERO)
            .expect_err("a rejected shutdown must preserve ownership");
        assert!(error.contains("refused the shutdown request"));
        assert!(matches!(
            &manager.state.lock().expect("modeld manager lock").lifecycle,
            ModeldLifecycle::Running { child: Some(_) }
        ));

        let child = {
            let mut state = manager.state.lock().expect("modeld manager lock");
            let previous = std::mem::replace(&mut state.lifecycle, ModeldLifecycle::Stopped);
            match previous {
                ModeldLifecycle::Running { child: Some(child) } => child,
                _ => panic!("test child ownership was not restored"),
            }
        };
        let mut child = child;
        kill_and_reap(&mut child).unwrap();
    }

    #[test]
    fn fake_openai_server_is_never_attached_or_sent_shutdown() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = Arc::new(AtomicUsize::new(0));
        let server_received = received.clone();
        let server = thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let until = std::time::Instant::now() + Duration::from_millis(250);
            while std::time::Instant::now() < until {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0_u8; 512];
                        let _ = stream.read(&mut request);
                        server_received.fetch_add(1, Ordering::SeqCst);
                        stream
                            .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 27\r\n\r\n{\"object\":\"list\",\"data\":[]}")
                            .unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("fake server accept: {error}"),
                }
            }
        });

        assert!(!modeld_healthy(port));
        assert!(!request_modeld_shutdown(port));
        server.join().unwrap();
        assert_eq!(
            received.load(Ordering::SeqCst),
            2,
            "only marker health checks may reach a non-modeld service"
        );
    }
}

// Resolve the app-data dir for the single JSON storage document.
fn storage_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

// Read the persisted JSON document (None if it doesn't exist yet).
// All shape/versioning logic lives in TypeScript.
#[tauri::command]
pub fn storage_read(app: AppHandle) -> Result<Option<String>, String> {
    storage::read_doc(&storage_dir(&app)?)
}

// Atomically write the persisted JSON document.
#[tauri::command]
pub fn storage_write(app: AppHandle, contents: String) -> Result<(), String> {
    storage::write_doc(&storage_dir(&app)?, &contents)
}

// Named side documents (KödChat transcripts at chats/<threadId>.json). Kept out
// of the main document because transcripts are large, per-thread, and loaded
// lazily. `name` crosses a strict validator in storage.rs — it can never escape
// the app data dir — and, as with the main document, Rust never reads the shape.
#[tauri::command]
pub fn storage_read_doc(app: AppHandle, name: String) -> Result<Option<String>, String> {
    storage::read_named_doc(&storage_dir(&app)?, &name)
}

#[tauri::command]
pub fn storage_write_doc(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    storage::write_named_doc(&storage_dir(&app)?, &name, &contents)
}

#[tauri::command]
pub fn storage_delete_doc(app: AppHandle, name: String) -> Result<(), String> {
    storage::delete_named_doc(&storage_dir(&app)?, &name)
}

// True if `path` is an existing directory (validates drag-and-dropped paths).
#[tauri::command]
pub fn fs_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

// Canonical form of `path` (resolves symlinks, /tmp vs /private/tmp, case),
// so project dedupe compares real locations. Falls back to the input if the
// path can't be resolved.
#[tauri::command]
pub fn fs_canonicalize(path: String) -> String {
    std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(path)
}

// List one directory level for the file tree (frontend expands lazily).
#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    fs::list_dir(&path)
}

// Read a file for the editor pane, with the size/binary cap applied.
#[tauri::command]
pub fn fs_read_file(path: String) -> Result<FileRead, String> {
    fs::read_file(&path)
}

// Write the editor buffer back to disk atomically (temp file + rename). Returns
// a clear error string on failure (read-only file, missing directory) so the
// editor can show it without ever truncating the existing file.
#[tauri::command]
pub fn fs_write_file(path: String, contents: String) -> Result<(), String> {
    fs::write_file(&path, &contents)
}

// --- File-manager mutations (v1.1) ---
//
// Every mutating command takes the active project `root` and confines the
// target to it (pathguard::confine) BEFORE touching the filesystem, so a
// create/rename/trash can never escape the project — unlike v1's read paths,
// these mutate. The confinement check is the pure, tested pathguard function;
// the fs module does the thin filesystem work on the already-confined path.

// Create an empty file at `path`, confined to `root`.
#[tauri::command]
pub fn fs_create_file(root: String, path: String) -> Result<(), String> {
    let target = pathguard::confine_mutation(&root, &path)?;
    fs::create_file(&target)
}

// Create a directory at `path`, confined to `root`.
#[tauri::command]
pub fn fs_create_dir(root: String, path: String) -> Result<(), String> {
    let target = pathguard::confine_mutation(&root, &path)?;
    fs::create_dir(&target)
}

// Rename/move `from` to `to`; BOTH endpoints are confined to `root`.
#[tauri::command]
pub fn fs_rename(root: String, from: String, to: String) -> Result<(), String> {
    let from_c = pathguard::confine_mutation(&root, &from)?;
    let to_c = pathguard::confine_mutation(&root, &to)?;
    fs::rename(&from_c, &to_c)
}

// Move `path` to the OS trash (recoverable), confined to `root`.
#[tauri::command]
pub fn fs_trash(root: String, path: String) -> Result<(), String> {
    let target = pathguard::confine_mutation(&root, &path)?;
    fs::trash(&target)
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, PartialEq, Eq)]
struct DesktopCommand {
    program: &'static str,
    args: Vec<OsString>,
}

// Explorer's /select option and the path form one argv item. Keeping the path
// in OsString avoids lossy conversion and Command bypasses cmd.exe entirely.
#[cfg(any(target_os = "windows", test))]
fn windows_reveal_command(path: &std::path::Path) -> DesktopCommand {
    let mut select = OsString::from("/select,");
    select.push(path.as_os_str());
    DesktopCommand {
        program: "explorer.exe",
        args: vec![select],
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_open_url_command(url: &str) -> DesktopCommand {
    DesktopCommand {
        program: "explorer.exe",
        args: vec![OsString::from(url)],
    }
}

#[cfg(target_os = "windows")]
fn spawn_desktop(command: DesktopCommand, context: &str) -> Result<(), String> {
    std::process::Command::new(command.program)
        .args(command.args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{context}: {e}"))
}

fn validated_http_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|_| "invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("URL scheme is not allowed".to_string()),
    }
}

// Reveal `path` in the OS file manager (Finder or Explorer). Confined to `root`.
// This only launches the reveal; it never mutates, but confinement keeps the
// surface uniform and avoids revealing arbitrary paths outside the project.
#[tauri::command]
pub fn fs_reveal(root: String, path: String) -> Result<(), String> {
    let target = pathguard::confine_mutation(&root, &path)?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("reveal {}: {e}", target.display()))
    }
    #[cfg(target_os = "windows")]
    {
        spawn_desktop(windows_reveal_command(&target), "reveal in Explorer")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err(format!(
            "reveal in file manager is unsupported on this platform: {}",
            target.display()
        ))
    }
}

// Open a rendered Markdown link with the OS handler, never inside the app
// webview. The scheme allowlist is intentionally small at this process boundary.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let parsed = validated_http_url(&url)?;
    // http/https ONLY: an OS handler on a file:// URL can LAUNCH the target
    // (an .app, an installer) — a click inside rendered document content must
    // never have that power.
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(parsed.as_str())
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open URL: {e}"))
    }
    #[cfg(target_os = "windows")]
    {
        spawn_desktop(
            windows_open_url_command(parsed.as_str()),
            "open URL with Windows handler",
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("opening URLs is unsupported on this platform".to_string())
    }
}

// Deep-link into the OS microphone-privacy pane when KödWhisper's capture is
// denied (macOS TCC / Windows privacy settings). Unlike open_url, the target
// is a fixed constant per platform — never attacker- or caller-supplied — so
// the http/https scheme guard does not apply here.
#[tauri::command]
pub fn open_microphone_privacy_settings() -> Result<(), String> {
    require_development_feature("KödWhisper")?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open microphone privacy settings: {e}"))
    }
    #[cfg(target_os = "windows")]
    {
        spawn_desktop(
            windows_open_url_command("ms-settings:privacy-microphone"),
            "open microphone privacy settings",
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("opening privacy settings is unsupported on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::Path;

    use super::{validated_http_url, windows_open_url_command, windows_reveal_command};

    #[test]
    fn open_url_rejects_disallowed_schemes_before_launching() {
        assert!(validated_http_url("javascript:alert(1)").is_err());
        assert!(validated_http_url("data:text/html,nope").is_err());
        // file:// could launch apps/installers via `open` — must be refused.
        assert!(validated_http_url("file:///Applications/Calculator.app").is_err());
    }

    #[test]
    fn windows_reveal_keeps_spaces_and_unicode_in_one_argument() {
        let command = windows_reveal_command(Path::new(r"C:\Users\Keith\设计 & bids\takeoff.pdf"));
        assert_eq!(command.program, "explorer.exe");
        assert_eq!(command.args.len(), 1);
        assert_eq!(
            command.args[0].to_string_lossy(),
            r"/select,C:\Users\Keith\设计 & bids\takeoff.pdf"
        );
    }

    #[test]
    fn windows_url_keeps_shell_metacharacters_in_one_argument() {
        let url = "https://example.com/search?q=a&next=b%20c";
        let command = windows_open_url_command(url);
        assert_eq!(command.program, "explorer.exe");
        assert_eq!(command.args, vec![OsString::from(url)]);
    }

    #[test]
    fn microphone_privacy_settings_target_is_a_fixed_ms_settings_uri() {
        // The command is a hardcoded constant, never caller-supplied — this
        // pins the exact URI Windows' privacy pane expects.
        let command = windows_open_url_command("ms-settings:privacy-microphone");
        assert_eq!(command.program, "explorer.exe");
        assert_eq!(
            command.args,
            vec![OsString::from("ms-settings:privacy-microphone")]
        );
    }
}

// Start (or replace) the recursive watcher on the active project root.
// Debounced change bursts are emitted as `fs://changed` with affected paths.
#[tauri::command]
pub fn fs_watch(
    app: AppHandle,
    manager: State<'_, WatchManager>,
    root: String,
    generation: u64,
) -> Result<(), String> {
    let emit_app = app.clone();
    let sink: fs::ChangeSink = Arc::new(move |paths: Vec<String>| {
        let _ = emit_app.emit(EVENT_FS_CHANGED, FsChanged { paths });
    });
    let handle = fs::watch(&root, sink)?;
    manager.replace(generation, root, handle);
    Ok(())
}

// Stop the active watcher (project deselected / app teardown). Idempotent.
#[tauri::command]
pub fn fs_unwatch(manager: State<'_, WatchManager>, generation: u64) -> Result<(), String> {
    manager.clear(generation);
    Ok(())
}

// Basename of the user's selected platform shell, for default session names.
#[tauri::command]
pub fn shell_name() -> String {
    ShellEnvironment::current().display_name()
}

// Detect an agent CLI: raw `<bin> --version` stdout if installed, else None.
// Runs in the user's login shell so PATH matches their real env; TypeScript
// trims the output to a short version token. Never auth-related — this only
// probes availability.
#[tauri::command]
pub fn detect_provider(bin: String) -> Option<String> {
    let shell = ShellEnvironment::current();
    detect::detect_version(&shell, &bin)
}

// Run the user's authenticated gh CLI in the active project. kodade supplies
// only a constrained argv and never handles GitHub credentials itself.
#[tauri::command]
pub fn run_gh(project_root: String, args: Vec<String>) -> Result<GhOutput, String> {
    let shell = ShellEnvironment::current();
    github::run_gh(&shell, std::path::Path::new(&project_root), args)
}

// Run the user's own git in the active project. Like run_gh, kodade supplies
// only a constrained, read-only argv (validated in git::run_git) and never
// writes to the repository — KödPR is a reading surface.
#[tauri::command]
pub fn run_git(project_root: String, args: Vec<String>) -> Result<GitOutput, String> {
    let shell = ShellEnvironment::current();
    git::run_git(&shell, std::path::Path::new(&project_root), args)
}

// --- KödHarness config surface (M10, read side) ---
//
// Both commands build the per-call configguard allowlist from the login-shell
// home plus the active project root, then apply it before touching the
// filesystem. Rust never parses artifact bytes — config_read reuses the fs read
// caps/tagging and TypeScript does all format/shape interpretation.

// Scan one harness config directory: a shallow listing with a one-level recurse
// into subdirectories and per-entry symlink resolution. A missing directory is a
// normal empty state; a guard rejection or read failure becomes Unreadable —
// never a throw, so one bad location never fails the whole harness scan.
#[tauri::command]
pub fn config_scan(root: String, project_root: String) -> Result<ConfigScan, String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), std::path::Path::new(&project_root));
    if std::fs::symlink_metadata(&root).is_err() {
        return Ok(ConfigScan::Missing { root });
    }
    let root_is_symlink = std::fs::symlink_metadata(&root)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false);
    let dir = match guard.authorize(&root, Access::ScanDir) {
        Ok(dir) => dir,
        Err(error) => {
            return Ok(ConfigScan::Unreadable {
                root,
                root_is_symlink,
                error,
            })
        }
    };
    match config::scan_dir(&dir) {
        Ok(entries) => Ok(ConfigScan::Listing {
            root,
            root_is_symlink,
            entries,
        }),
        Err(error) => Ok(ConfigScan::Unreadable {
            root,
            root_is_symlink,
            error,
        }),
    }
}

// Read one harness config file with the existing fs size/binary caps, after the
// guard confirms it canonicalizes inside an allowlisted root and matches a known
// artifact shape.
#[tauri::command]
pub fn config_read(path: String, project_root: String) -> Result<FileRead, String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), std::path::Path::new(&project_root));
    let file = guard.authorize(&path, Access::ReadFile)?;
    fs::read_file(&file.to_string_lossy())
}

// The real home dir + OS family, for KödHarness global scope (M10c). A thin
// getter — all path templating and scan logic stays in TypeScript; this just
// hands over the facts (ShellEnvironment::home(), build target, and — M10g —
// the real %APPDATA%/%LOCALAPPDATA% roots on Windows) the TS ScanContext
// needs to resolve global-scope templates for a real user.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEnv {
    home: String,
    platform: String,
    // M10g: some CLIs (opencode confirmed) keep their Windows global config
    // under %APPDATA% rather than the `home`-relative dotfile path every
    // other adapter uses — read directly from the environment (never
    // guessed as `home + "AppData/Roaming"`, since profile redirection can
    // move these) so the harness catalog can override just that one
    // template. Always None on macOS/Linux.
    app_data_roaming: Option<String>,
    app_data_local: Option<String>,
}

#[tauri::command]
pub fn config_env() -> ConfigEnv {
    let shell = ShellEnvironment::current();
    let (app_data_roaming, app_data_local) = if cfg!(windows) {
        (
            std::env::var("APPDATA").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        )
    } else {
        (None, None)
    };
    ConfigEnv {
        home: shell.home().to_string_lossy().to_string(),
        platform: if cfg!(windows) { "windows" } else { "mac" }.to_string(),
        app_data_roaming,
        app_data_local,
    }
}

#[cfg(test)]
mod config_env_tests {
    use super::*;

    #[test]
    fn app_data_fields_are_none_off_windows() {
        // On macOS/Linux CI there is no %APPDATA%, and the harness catalog
        // must never be handed a guessed value — only a real env var or None.
        if !cfg!(windows) {
            let env = config_env();
            assert!(env.app_data_roaming.is_none());
            assert!(env.app_data_local.is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn app_data_fields_read_the_real_environment_on_windows() {
        // SAFETY: test-only env mutation, single-threaded within this test's
        // own process invocation; restored immediately after reading.
        let prior_roaming = std::env::var("APPDATA").ok();
        let prior_local = std::env::var("LOCALAPPDATA").ok();
        unsafe {
            std::env::set_var("APPDATA", r"C:\Users\Keïth\AppData\Roaming");
            std::env::set_var("LOCALAPPDATA", r"C:\Users\Keïth\AppData\Local");
        }
        let env = config_env();
        assert_eq!(
            env.app_data_roaming.as_deref(),
            Some(r"C:\Users\Keïth\AppData\Roaming")
        );
        assert_eq!(
            env.app_data_local.as_deref(),
            Some(r"C:\Users\Keïth\AppData\Local")
        );
        unsafe {
            match prior_roaming {
                Some(v) => std::env::set_var("APPDATA", v),
                None => std::env::remove_var("APPDATA"),
            }
            match prior_local {
                Some(v) => std::env::set_var("LOCALAPPDATA", v),
                None => std::env::remove_var("LOCALAPPDATA"),
            }
        }
    }
}

// --- KödHarness config surface (M10d, write side) ---
//
// Every write command builds the per-call configguard allowlist from the
// login-shell home plus the frontend-supplied project root, authorizes the
// target(s), then delegates the thin filesystem work to config.rs. The guard is
// the single audit point; nothing below it trusts the incoming paths.

// The reversible enable/disable primitive: rename a skill/subagent entry to add
// or strip the `.disabled` suffix. This primitive CANNOT express an arbitrary
// rename — `new_path` must be exactly `path` ± ".disabled" — and it operates on
// the LINK entry itself (configguard's RenameEntry never follows the final
// symlink), so a dotfiles-symlinked skill renames the link, never its target.
#[tauri::command]
pub fn config_rename(path: String, new_path: String, project_root: String) -> Result<(), String> {
    let disable = new_path == format!("{path}.disabled");
    let enable = path == format!("{new_path}.disabled");
    if !disable && !enable {
        return Err(format!(
            "rename must only add or strip the .disabled suffix: {path} -> {new_path}"
        ));
    }
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), std::path::Path::new(&project_root));
    let from = guard.authorize(&path, Access::RenameEntry)?;
    let to = guard.authorize(&new_path, Access::RenameEntry)?;
    fs::rename(&from, &to)
}

// Atomic write with optimistic concurrency, backing up prior bytes first.
// Returns the backup path ("" for a new file). M10e/instruction editing consumes
// this; the skills rename path does not.
#[tauri::command]
pub fn config_write(
    path: String,
    contents: String,
    expected_hash: String,
    project_root: String,
) -> Result<String, String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), std::path::Path::new(&project_root));
    let target = guard.authorize(&path, Access::WriteFile)?;
    config::write_config(&target, &contents, &expected_hash, SystemTime::now())
}

// Explicit backup step of the receipt/restore flow: copy the file's current
// bytes to a timestamped `.kodade-bak` sibling and return its path.
#[tauri::command]
pub fn config_backup(path: String, project_root: String) -> Result<String, String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), std::path::Path::new(&project_root));
    let target = guard.authorize(&path, Access::ReadFile)?;
    config::backup_config(&target, SystemTime::now())
}

// A backup may only restore ITS OWN source file: it must be a sibling (same
// parent directory) and its pre-infix stem must equal the target's filename.
// Without this binding, any authorized `.kodade-bak-*` anywhere in the allowlist
// could be restored over any other authorized artifact (e.g. a project backup
// over the global CLAUDE.md) — independent authorization is not enough.
fn backup_belongs_to_target(
    target: &std::path::Path,
    backup: &std::path::Path,
) -> Result<(), String> {
    if target.parent() != backup.parent() {
        return Err(format!(
            "backup is not a sibling of the file it would restore: {}",
            backup.display()
        ));
    }
    let target_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("restore target has no filename: {}", target.display()))?;
    let backup_name = backup
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("backup has no filename: {}", backup.display()))?;
    let stem = backup_name
        .find(crate::configguard::BACKUP_INFIX)
        .map(|at| &backup_name[..at])
        .unwrap_or("");
    if stem != target_name {
        return Err(format!(
            "backup {backup_name} was not taken from {target_name}"
        ));
    }
    Ok(())
}

// Restore a file from a backup. The target authorizes as a writable artifact and
// the backup as a `.kodade-bak` sibling — a backup path that doesn't match that
// shape, escapes the guard, or was not taken from THIS target (wrong stem or a
// different directory) is refused before any bytes move.
#[tauri::command]
pub fn config_restore(
    path: String,
    backup_path: String,
    project_root: String,
) -> Result<(), String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), std::path::Path::new(&project_root));
    let target = guard.authorize(&path, Access::WriteFile)?;
    let backup = guard.authorize(&backup_path, Access::ReadBackup)?;
    backup_belongs_to_target(&target, &backup)?;
    config::restore_config(&target, &backup)
}

// --- KödSkills pack + skill-directory surface (M15) ---

// The native dialog and source read are one command so arbitrary filesystem
// reads are possible only for the exact directory the user selected.
#[tauri::command]
pub async fn project_skill_pick(
    app: AppHandle,
) -> Result<Option<config::ProjectSkillSourceBundle>, String> {
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|error| format!("open project skill picker: {error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("selected skill folder is not a filesystem path: {error}"))?;
    config::read_project_skill_source(&path).map(Some)
}

#[tauri::command]
pub fn kodskills_pack_read(app: AppHandle) -> Result<config::KodSkillsPackBundle, String> {
    config::read_kodskills_pack(&resolve_kodskills_resource(&app)?)
}

fn authorize_skill_target(
    guard: &ConfigGuard,
    path: &str,
    create_container: bool,
) -> Result<PathBuf, String> {
    let raw = Path::new(path);
    let parent = raw
        .parent()
        .ok_or_else(|| format!("skill directory has no parent: {path}"))?;
    let container = guard.authorize(&parent.to_string_lossy(), Access::SkillsContainer)?;
    if create_container && !container.exists() {
        std::fs::create_dir_all(&container)
            .map_err(|error| format!("create skills directory {}: {error}", container.display()))?;
        // Re-authorize after creation so a raced symlink or unexpected entry is
        // rejected before the child target is resolved.
        guard.authorize(&parent.to_string_lossy(), Access::SkillsContainer)?;
    }
    guard.authorize(path, Access::SkillDir)
}

fn skill_backup_belongs_to_target(target: &Path, backup: &Path) -> Result<(), String> {
    if target.parent() != backup.parent() {
        return Err("skill backup is not a sibling of its target".to_string());
    }
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let backup_name = backup
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if !backup_name.starts_with(&format!(
        "{target_name}{}",
        crate::configguard::BACKUP_INFIX
    )) {
        return Err("skill backup does not belong to its target".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn config_dir_snapshot(
    path: String,
    project_root: String,
) -> Result<config::ConfigDirSnapshot, String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), Path::new(&project_root));
    let target = authorize_skill_target(&guard, &path, false)?;
    config::snapshot_dir(&target)
}

#[tauri::command]
pub fn config_install_dir(
    path: String,
    files: Vec<config::ConfigInstallFile>,
    expected_files: Option<Vec<config::ConfigFileHash>>,
    project_root: String,
) -> Result<String, String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), Path::new(&project_root));
    let target = authorize_skill_target(&guard, &path, true)?;
    config::install_dir(
        &target,
        &files,
        expected_files.as_deref(),
        SystemTime::now(),
    )
}

#[tauri::command]
pub fn config_remove_dir(
    path: String,
    expected_files: Vec<config::ConfigFileHash>,
    project_root: String,
    keep_backup: bool,
) -> Result<String, String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), Path::new(&project_root));
    let target = authorize_skill_target(&guard, &path, false)?;
    config::remove_dir(&target, &expected_files, SystemTime::now(), keep_backup)
}

#[tauri::command]
pub fn config_restore_dir(
    path: String,
    backup_path: String,
    expected_files: Option<Vec<config::ConfigFileHash>>,
    project_root: String,
) -> Result<(), String> {
    let shell = ShellEnvironment::current();
    let guard = ConfigGuard::new(shell.home(), Path::new(&project_root));
    let target = authorize_skill_target(&guard, &path, false)?;
    let backup = guard.authorize(&backup_path, Access::SkillBackupDir)?;
    skill_backup_belongs_to_target(&target, &backup)?;
    config::restore_dir(
        &target,
        &backup,
        expected_files.as_deref(),
        SystemTime::now(),
    )
}

// --- KödSSH foundations (M11a) ---
//
// Thin pass-throughs to ssh.rs: locate the `ssh` executable through the login
// shell, and read one file confined to ~/.ssh. Both are read-only; Rust never
// parses config content (TypeScript owns Host/Include parsing).

#[tauri::command]
pub fn ssh_detect() -> Result<SshDetectResult, String> {
    require_development_feature("KödSSH")?;
    let shell = ShellEnvironment::current();
    ssh::detect(&shell)
}

// `path` omitted reads ~/.ssh/config; a value follows OpenSSH's own Include
// conventions (see ssh::read_config). A missing target returns `Ok(None)` —
// the frontend treats that as "no hosts here", not an error.
#[tauri::command]
pub fn ssh_config_read(path: Option<String>) -> Result<Option<String>, String> {
    require_development_feature("KödSSH")?;
    let shell = ShellEnvironment::current();
    ssh::read_config(shell.home(), path.as_deref())
}

// List file names in one directory under ~/.ssh (non-recursive, read-only) —
// the primitive the frontend uses to expand a globbed `Include` like
// `~/.ssh/config.d/*`. Glob matching lives in TypeScript; a missing dir is
// `Ok(None)`.
#[tauri::command]
pub fn ssh_list_dir(path: Option<String>) -> Result<Option<Vec<String>>, String> {
    require_development_feature("KödSSH")?;
    let shell = ShellEnvironment::current();
    ssh::list_dir(shell.home(), path.as_deref())
}

// --- KödSSH remote exec (M11c) ---
//
// Bounded, non-PTY `ssh -o BatchMode=yes <host> -- <argv…>` for remote provider
// detection and (M11d) file listing. Rust enforces the host allowlist and runs
// the argv as discrete process arguments (never a local shell string); all argv
// construction and remote-side quoting are decided and tested in TypeScript
// (src/ssh/command.ts). Output is capped and a hard timeout kills the child.
#[tauri::command]
pub fn ssh_exec(host: String, argv: Vec<String>, timeout_ms: u64) -> Result<SshExecResult, String> {
    require_development_feature("KödSSH")?;
    let shell = ShellEnvironment::current();
    ssh::exec(&shell, &host, &argv, timeout_ms)
}

#[cfg(test)]
mod config_rename_tests {
    use super::*;
    use std::path::PathBuf;

    // A canonicalized temp project with a real skills dir, so the per-call guard
    // (built from the real home plus this project root) allowlists the paths.
    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kodade-cmd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude").join("skills")).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn config_rename_rejects_an_arbitrary_rename() {
        let project = temp_project("rename-arbitrary");
        let skill = project.join(".claude").join("skills").join("code-review");
        std::fs::create_dir_all(&skill).unwrap();
        let bogus = project.join(".claude").join("skills").join("evil");
        let err = config_rename(
            skill.to_string_lossy().to_string(),
            bogus.to_string_lossy().to_string(),
            project.to_string_lossy().to_string(),
        )
        .expect_err("an arbitrary rename must be rejected");
        assert!(
            err.contains("add or strip the .disabled suffix"),
            "got: {err}"
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn config_rename_disables_then_reenables_a_skill_dir() {
        let project = temp_project("rename-toggle");
        let skills = project.join(".claude").join("skills");
        let skill = skills.join("code-review");
        std::fs::create_dir_all(skill.join("bits")).unwrap();
        let disabled = skills.join("code-review.disabled");

        config_rename(
            skill.to_string_lossy().to_string(),
            disabled.to_string_lossy().to_string(),
            project.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(!skill.exists() && disabled.is_dir());

        config_rename(
            disabled.to_string_lossy().to_string(),
            skill.to_string_lossy().to_string(),
            project.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(skill.is_dir() && !disabled.exists());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[cfg(unix)]
    #[test]
    fn config_rename_renames_the_symlink_not_its_target() {
        use std::os::unix::fs::symlink;
        let project = temp_project("rename-symlink");
        let dotfiles = project
            .parent()
            .unwrap()
            .join(format!("kodade-dotfiles-{}", std::process::id()));
        let target = dotfiles.join("x-post");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("SKILL.md"), "skill body").unwrap();
        let skills = project.join(".claude").join("skills");
        let link = skills.join("x-post");
        symlink(&target, &link).unwrap();

        let disabled = skills.join("x-post.disabled");
        config_rename(
            link.to_string_lossy().to_string(),
            disabled.to_string_lossy().to_string(),
            project.to_string_lossy().to_string(),
        )
        .unwrap();

        // The link moved; the dotfiles target keeps its name and content.
        assert!(!link.exists());
        assert!(std::fs::symlink_metadata(&disabled)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(target.is_dir(), "dotfiles target dir must be untouched");
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "skill body"
        );
        let _ = std::fs::remove_dir_all(&project);
        let _ = std::fs::remove_dir_all(&dotfiles);
    }
}

#[cfg(test)]
mod config_restore_tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kodade-restore-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn restore_accepts_the_targets_own_sibling_backup() {
        let project = temp_project("own-sibling");
        let target = project.join("CLAUDE.md");
        let backup = project.join("CLAUDE.md.kodade-bak-2026-07-14T12-00-00-000Z");
        std::fs::write(&target, "current").unwrap();
        std::fs::write(&backup, "original").unwrap();

        config_restore(
            target.to_string_lossy().to_string(),
            backup.to_string_lossy().to_string(),
            project.to_string_lossy().to_string(),
        )
        .expect("a legit sibling backup must restore");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn restore_rejects_a_backup_taken_from_a_different_file() {
        // AGENTS.md's backup must never restore over CLAUDE.md, even though both
        // authorize independently in the same directory.
        let project = temp_project("cross-file");
        let target = project.join("CLAUDE.md");
        let backup = project.join("AGENTS.md.kodade-bak-2026-07-14T12-00-00-000Z");
        std::fs::write(&target, "claude").unwrap();
        std::fs::write(&backup, "agents bytes").unwrap();

        let err = config_restore(
            target.to_string_lossy().to_string(),
            backup.to_string_lossy().to_string(),
            project.to_string_lossy().to_string(),
        )
        .expect_err("a cross-file restore must be rejected");
        assert!(err.contains("was not taken from"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "claude");
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn restore_rejects_a_same_named_backup_from_a_different_dir() {
        // Same filename (CLAUDE.md), but the backup lives in project/.claude while
        // the target is the project root's CLAUDE.md — not a sibling, so refused.
        let project = temp_project("cross-dir");
        let target = project.join("CLAUDE.md");
        let backup = project
            .join(".claude")
            .join("CLAUDE.md.kodade-bak-2026-07-14T12-00-00-000Z");
        std::fs::write(&target, "root claude").unwrap();
        std::fs::write(&backup, "other dir bytes").unwrap();

        let err = config_restore(
            target.to_string_lossy().to_string(),
            backup.to_string_lossy().to_string(),
            project.to_string_lossy().to_string(),
        )
        .expect_err("a cross-dir restore must be rejected even with a matching stem");
        assert!(err.contains("not a sibling"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "root claude");
        let _ = std::fs::remove_dir_all(&project);
    }
}
