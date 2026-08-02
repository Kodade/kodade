use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::{fs::OpenOptions, io::Write as _};

use axum::extract::{DefaultBodyLimit, State as AxumState};
use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter as _, Manager as _, State};
use tokio::sync::{mpsc, oneshot, watch};

use crate::browser;
use crate::browser_protocol::{
    browser_descriptor_path, BrowserAgentCommand, BrowserBridgeDescriptor, BrowserBridgeReply,
    BROWSER_BRIDGE_VERSION,
};

const EVENT_AGENT_ACTIVATE: &str = "browser://agent-activate";
const MAX_COMMAND_BYTES: usize = 128 * 1024;

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("system RNG must be available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Clone)]
struct BridgeState {
    token: String,
    commands: mpsc::Sender<CommandEnvelope>,
}

struct CommandEnvelope {
    command: BrowserAgentCommand,
    reply: oneshot::Sender<BrowserBridgeReply>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserAgentActivate {
    project_root: String,
    url: Option<String>,
}

pub struct BrowserBridgeManager {
    descriptor_path: PathBuf,
    token: String,
}

pub struct BrowserBridgeReadiness {
    active_project: watch::Sender<String>,
}

impl Drop for BrowserBridgeManager {
    fn drop(&mut self) {
        let owned = std::fs::read(&self.descriptor_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<BrowserBridgeDescriptor>(&bytes).ok())
            .is_some_and(|descriptor| descriptor.token == self.token);
        if owned {
            let _ = std::fs::remove_file(&self.descriptor_path);
        }
    }
}

fn authorized(state: &BridgeState, headers: &HeaderMap) -> bool {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == state.token)
}

async fn health(AxumState(state): AxumState<BridgeState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({ "ok": true, "version": BROWSER_BRIDGE_VERSION })).into_response()
}

async fn command(
    AxumState(state): AxumState<BridgeState>,
    headers: HeaderMap,
    Json(command): Json<BrowserAgentCommand>,
) -> Response {
    if !authorized(&state, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let (reply, receive) = oneshot::channel();
    let envelope = CommandEnvelope { command, reply };
    if state.commands.send(envelope).await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(BrowserBridgeReply::failure(
                "Kodade's internal browser controller is stopping",
            )),
        )
            .into_response();
    }
    match tokio::time::timeout(std::time::Duration::from_secs(20), receive).await {
        Ok(Ok(reply)) => Json(reply).into_response(),
        Ok(Err(_)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(BrowserBridgeReply::failure(
                "Kodade's internal browser controller stopped",
            )),
        )
            .into_response(),
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(BrowserBridgeReply::failure(
                "Kodade's internal browser action timed out",
            )),
        )
            .into_response(),
    }
}

fn router(state: BridgeState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/command", post(command))
        .layer(DefaultBodyLimit::max(MAX_COMMAND_BYTES))
        .with_state(state)
}

fn secure_descriptor(path: &Path, descriptor: &BrowserBridgeDescriptor) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "browser bridge descriptor has no parent directory".to_owned())?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "create browser bridge directory {}: {error}",
            parent.display()
        )
    })?;
    if std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "refusing to write browser bridge descriptor through a symlink: {}",
            path.display()
        ));
    }
    let contents = serde_json::to_vec(descriptor)
        .map_err(|error| format!("serialize browser bridge descriptor: {error}"))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("open browser bridge descriptor {}: {error}", path.display()))?;
    file.write_all(&contents).map_err(|error| {
        format!(
            "write browser bridge descriptor {}: {error}",
            path.display()
        )
    })?;
    file.sync_all()
        .map_err(|error| format!("sync browser bridge descriptor {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "secure browser bridge descriptor {}: {error}",
                    path.display()
                )
            },
        )?;
    }
    Ok(())
}

pub fn readiness() -> (BrowserBridgeReadiness, watch::Receiver<String>) {
    let (active_project, ready) = watch::channel(String::new());
    (BrowserBridgeReadiness { active_project }, ready)
}

pub fn start(
    app: AppHandle,
    ready: watch::Receiver<String>,
) -> Result<BrowserBridgeManager, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("bind Kodade browser bridge: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("configure Kodade browser bridge: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("inspect Kodade browser bridge: {error}"))?
        .port();
    let token = random_token();
    let descriptor = BrowserBridgeDescriptor {
        version: BROWSER_BRIDGE_VERSION,
        port,
        token: token.clone(),
        pid: std::process::id(),
    };
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve Kodade app data directory: {error}"))?;
    let descriptor_path = browser_descriptor_path(&data_dir);
    secure_descriptor(&descriptor_path, &descriptor)?;

    let (commands, receiver) = mpsc::channel(32);
    tauri::async_runtime::spawn(executor(app, receiver, ready));
    let state = BridgeState {
        token: token.clone(),
        commands,
    };
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("kodade: browser bridge listener failed: {error}");
                return;
            }
        };
        if let Err(error) = axum::serve(listener, router(state)).await {
            eprintln!("kodade: browser bridge stopped: {error}");
        }
    });

    Ok(BrowserBridgeManager {
        descriptor_path,
        token,
    })
}

#[tauri::command]
pub fn browser_agent_ready(
    readiness: State<'_, BrowserBridgeReadiness>,
    project_root: Option<String>,
) -> Result<(), String> {
    let Some(project_root) = project_root else {
        readiness.active_project.send_replace(String::new());
        return Ok(());
    };
    if !Path::new(&project_root).is_absolute() {
        return Err("browser agent project root must be absolute".to_owned());
    }
    readiness.active_project.send_replace(project_root);
    Ok(())
}

async fn executor(
    app: AppHandle,
    mut receiver: mpsc::Receiver<CommandEnvelope>,
    mut ready: watch::Receiver<String>,
) {
    while let Some(envelope) = receiver.recv().await {
        let result = execute(&app, &mut ready, envelope.command).await;
        let reply = match result {
            Ok(result) => BrowserBridgeReply::success(result),
            Err(error) => BrowserBridgeReply::failure(error),
        };
        let _ = envelope.reply.send(reply);
    }
}

async fn execute(
    app: &AppHandle,
    ready: &mut watch::Receiver<String>,
    command: BrowserAgentCommand,
) -> Result<Value, String> {
    let project_root = command.project_root().to_owned();
    if !Path::new(&project_root).is_absolute() {
        return Err("browser tool project root must be absolute".to_owned());
    }
    let requested_url = match &command {
        BrowserAgentCommand::Navigate { url, .. } => Some(browser::agent_url(url)?.to_string()),
        _ => None,
    };
    app.emit(
        EVENT_AGENT_ACTIVATE,
        BrowserAgentActivate {
            project_root: project_root.clone(),
            url: requested_url.clone(),
        },
    )
    .map_err(|error| format!("show Kodade browser pane: {error}"))?;

    wait_for_project_ready(ready, &project_root).await?;
    let webview_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Kodade's main window is unavailable".to_owned())?;
    let window = webview_window.as_ref().window();
    let script = automation_script(&command)?;
    if script.is_some() {
        wait_for_document(window.clone()).await?;
    }
    let result = match script {
        None => {
            let url = requested_url.expect("navigate URL was validated");
            let result = browser::agent_navigate(window.clone(), url).await?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            result
        }
        Some(script) => browser::agent_evaluate(window, script).await?,
    };
    Ok(result)
}

fn automation_script(command: &BrowserAgentCommand) -> Result<Option<String>, String> {
    match command {
        BrowserAgentCommand::Navigate { .. } => Ok(None),
        BrowserAgentCommand::Snapshot { .. } => Ok(Some(snapshot_script().to_owned())),
        BrowserAgentCommand::Click { element_ref, .. } => click_script(element_ref).map(Some),
        BrowserAgentCommand::Fill {
            element_ref,
            text,
            submit,
            ..
        } => fill_script(element_ref, text, *submit).map(Some),
        BrowserAgentCommand::Press { key, .. } => press_script(key).map(Some),
    }
}

async fn wait_for_document(window: tauri::Window) -> Result<(), String> {
    for _ in 0..50 {
        let state = browser::agent_evaluate(
            window.clone(),
            "({ readyState: document.readyState, url: location.href })".to_owned(),
        )
        .await?;
        if state
            .get("readyState")
            .and_then(Value::as_str)
            .is_some_and(|ready| ready != "loading")
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("Kodade's internal browser page did not finish loading".to_owned())
}

async fn wait_for_project_ready(
    ready: &mut watch::Receiver<String>,
    project_root: &str,
) -> Result<(), String> {
    if project_ready(ready.borrow().as_str(), project_root) {
        return Ok(());
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            ready
                .changed()
                .await
                .map_err(|_| "Kodade's browser pane stopped".to_owned())?;
            if project_ready(ready.borrow().as_str(), project_root) {
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| "Kodade could not activate the requesting project's browser pane".to_owned())?
}

fn project_ready(open_project: &str, requesting_root: &str) -> bool {
    !open_project.is_empty()
        && (open_project == requesting_root
            || Path::new(requesting_root).starts_with(Path::new(open_project)))
}

fn snapshot_script() -> &'static str {
    r#"(() => {
  try {
    const selector = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]';
    const elements = Array.from(document.querySelectorAll(selector)).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }).slice(0, 200);
    const interactive = elements.map((element, index) => {
      const ref = `kd-${index + 1}`;
      element.setAttribute('data-kodade-agent-ref', ref);
      const safeValue = element instanceof HTMLInputElement && element.type === 'password'
        ? ''
        : element.value;
      const label = (
        element.getAttribute('aria-label') ||
        element.getAttribute('placeholder') ||
        element.innerText ||
        safeValue ||
        element.getAttribute('name') ||
        ''
      ).trim().replace(/\s+/g, ' ').slice(0, 240);
      return {
        ref,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type'),
        label,
        href: element.href || null,
        disabled: Boolean(element.disabled)
      };
    });
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 65536),
      interactive
    };
  } catch (error) {
    return { _kodadeError: String(error) };
  }
})()"#
}

fn click_script(element_ref: &str) -> Result<String, String> {
    if element_ref.is_empty() || element_ref.len() > 128 {
        return Err("browser element ref is invalid".to_owned());
    }
    let element_ref = serde_json::to_string(element_ref)
        .map_err(|error| format!("encode element ref: {error}"))?;
    Ok(format!(
        r#"(() => {{
  try {{
    const wanted = {element_ref};
    const element = Array.from(document.querySelectorAll('[data-kodade-agent-ref]'))
      .find((candidate) => candidate.getAttribute('data-kodade-agent-ref') === wanted);
    if (!element) return {{ _kodadeError: `browser element ref ${{wanted}} is stale; take a new snapshot` }};
    element.scrollIntoView({{ block: 'center', inline: 'center' }});
    element.focus();
    element.click();
    return {{ clicked: wanted, url: location.href }};
  }} catch (error) {{
    return {{ _kodadeError: String(error) }};
  }}
}})()"#
    ))
}

fn fill_script(element_ref: &str, text: &str, submit: bool) -> Result<String, String> {
    if element_ref.is_empty() || element_ref.len() > 128 {
        return Err("browser element ref is invalid".to_owned());
    }
    if text.len() > 64 * 1024 {
        return Err("browser fill text exceeds 64 KiB".to_owned());
    }
    let element_ref = serde_json::to_string(element_ref)
        .map_err(|error| format!("encode element ref: {error}"))?;
    let text = serde_json::to_string(text).map_err(|error| format!("encode fill text: {error}"))?;
    Ok(format!(
        r#"(() => {{
  try {{
    const wanted = {element_ref};
    const text = {text};
    const element = Array.from(document.querySelectorAll('[data-kodade-agent-ref]'))
      .find((candidate) => candidate.getAttribute('data-kodade-agent-ref') === wanted);
    if (!element) return {{ _kodadeError: `browser element ref ${{wanted}} is stale; take a new snapshot` }};
    const editable = element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element.isContentEditable;
    if (!editable) return {{ _kodadeError: `browser element ref ${{wanted}} is not editable` }};
    element.scrollIntoView({{ block: 'center', inline: 'center' }});
    element.focus();
    if (element.isContentEditable) {{
      element.textContent = text;
    }} else {{
      const prototype = element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
    }}
    element.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: text }}));
    element.dispatchEvent(new Event('change', {{ bubbles: true }}));
    if ({submit}) {{
      const form = element.closest('form');
      if (form?.requestSubmit) form.requestSubmit();
      else element.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', bubbles: true }}));
    }}
    return {{ filled: wanted, submitted: {submit}, url: location.href }};
  }} catch (error) {{
    return {{ _kodadeError: String(error) }};
  }}
}})()"#
    ))
}

fn press_script(key: &str) -> Result<String, String> {
    if key.is_empty() || key.len() > 64 || key.chars().any(char::is_control) {
        return Err("browser key is invalid".to_owned());
    }
    let key = serde_json::to_string(key).map_err(|error| format!("encode key: {error}"))?;
    Ok(format!(
        r#"(() => {{
  try {{
    const key = {key};
    const target = document.activeElement || document.body;
    if (key === 'Enter' && target.closest?.('form')?.requestSubmit) {{
      target.closest('form').requestSubmit();
    }} else if (key === 'Escape') {{
      target.blur?.();
    }} else if (key === 'Tab') {{
      const focusable = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]'))
        .filter((element) => !element.disabled && element.tabIndex >= 0);
      const index = focusable.indexOf(target);
      focusable[(index + 1) % focusable.length]?.focus();
    }} else {{
      target.dispatchEvent(new KeyboardEvent('keydown', {{ key, bubbles: true }}));
      target.dispatchEvent(new KeyboardEvent('keyup', {{ key, bubbles: true }}));
    }}
    return {{ pressed: key, url: location.href }};
  }} catch (error) {{
    return {{ _kodadeError: String(error) }};
  }}
}})()"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_state() -> (BridgeState, mpsc::Receiver<CommandEnvelope>) {
        let (commands, receiver) = mpsc::channel(2);
        (
            BridgeState {
                token: "secret".into(),
                commands,
            },
            receiver,
        )
    }

    #[tokio::test]
    async fn rejects_unauthenticated_commands_before_forwarding() {
        let (state, mut receiver) = test_state();
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"action":"snapshot","project_root":"/work/app"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn forwards_an_authenticated_command_and_returns_its_reply() {
        let (state, mut receiver) = test_state();
        let worker = tokio::spawn(async move {
            let command = receiver.recv().await.unwrap();
            assert_eq!(command.command.project_root(), "/work/app");
            command
                .reply
                .send(BrowserBridgeReply::success(json!({"title": "Kodade"})))
                .unwrap();
        });
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer secret")
                    .body(Body::from(
                        r#"{"action":"snapshot","project_root":"/work/app"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 8 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"result": {"title": "Kodade"}})
        );
        worker.await.unwrap();
    }

    #[test]
    fn automation_scripts_json_quote_untrusted_values() {
        let click = click_script(r#"kd-1"; alert(1); //"#).unwrap();
        assert!(click.contains(r#"const wanted = "kd-1\"; alert(1); //";"#));
        let fill = fill_script("kd-2", "line\n\"quoted\"", false).unwrap();
        assert!(fill.contains(r#"const text = "line\n\"quoted\"";"#));
        assert!(!fill.contains("line\n\"quoted\""));
    }

    #[test]
    fn every_browser_action_routes_to_its_native_adapter_behavior() {
        let root = "/work/app".to_owned();
        assert!(automation_script(&BrowserAgentCommand::Navigate {
            project_root: root.clone(),
            url: "example.com".into(),
        })
        .unwrap()
        .is_none());
        let snapshot = automation_script(&BrowserAgentCommand::Snapshot {
            project_root: root.clone(),
        })
        .unwrap()
        .unwrap();
        assert!(snapshot.contains("document.querySelectorAll"));
        let click = automation_script(&BrowserAgentCommand::Click {
            project_root: root.clone(),
            element_ref: "kd-1".into(),
        })
        .unwrap()
        .unwrap();
        assert!(click.contains("element.click()"));
        let fill = automation_script(&BrowserAgentCommand::Fill {
            project_root: root.clone(),
            element_ref: "kd-2".into(),
            text: "Keith".into(),
            submit: true,
        })
        .unwrap()
        .unwrap();
        assert!(fill.contains("requestSubmit"));
        let press = automation_script(&BrowserAgentCommand::Press {
            project_root: root,
            key: "Enter".into(),
        })
        .unwrap()
        .unwrap();
        assert!(press.contains("KeyboardEvent"));
    }

    #[test]
    fn descriptor_is_private_on_unix() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("browser.json");
        secure_descriptor(
            &path,
            &BrowserBridgeDescriptor {
                version: 1,
                port: 42,
                token: "secret".into(),
                pid: 1,
            },
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn an_agent_started_in_a_project_subdirectory_uses_that_project_browser() {
        assert!(project_ready("/work/app", "/work/app/packages/ui"));
        assert!(project_ready("/work/app", "/work/app"));
        assert!(!project_ready("/work/other", "/work/app"));
        assert!(!project_ready("", "/work/app"));
    }
}
