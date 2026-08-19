use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Emitter as _;
use tauri::{AppHandle, Window};
use url::Url;

use crate::commands::require_development_feature;

pub const EVENT_NAVIGATED: &str = "browser://navigated";
pub const EDITOR_BROWSER_ID: &str = "editor-browser";
const MAX_AGENT_SCRIPT_BYTES: usize = 64 * 1024;
const MAX_AGENT_RESULT_BYTES: usize = 512 * 1024;

// Tauri's command bridge is never registered on a browser child. The guard also
// makes that absence explicit to remote documents before their own scripts run.
// On macOS creation removes Wry's inert `window.ipc` shim first. WebView2 does
// not expose Wry's script registration id, so its shim remains on Windows.
// Windows disables WebView2 messaging before the first remote load, so the shim
// cannot cross the page/native boundary even when JavaScript sees a normal return.
const IPC_GUARD_SCRIPT: &str = r#"
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: undefined,
  configurable: false,
  enumerable: false,
  writable: false
});
try {
  delete window.ipc;
  Object.defineProperty(window, "ipc", {
    value: undefined,
    configurable: false,
    enumerable: false,
    writable: false
  });
} catch (_) {}
"#;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize)]
struct BrowserNavigated {
    id: String,
    url: String,
}

pub(crate) fn http_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "invalid browser url".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("browser url must use http or https".to_owned());
    }
    Ok(url)
}

pub(crate) fn agent_url(value: &str) -> Result<Url, String> {
    let value = value.trim();
    let candidate = if value.contains("://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    http_url(&candidate)
}

fn checked_bounds(bounds: BrowserBounds) -> Result<BrowserBounds, String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite()) || bounds.width <= 0.0 || bounds.height <= 0.0
    {
        return Err("browser bounds must be finite and non-empty".to_owned());
    }
    Ok(bounds)
}

fn browser_download_allowed() -> bool {
    false
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod platform {
    use std::{cell::RefCell, collections::HashMap, sync::mpsc::sync_channel};

    #[cfg(target_os = "macos")]
    use objc2::{MainThreadMarker, MainThreadOnly};
    #[cfg(target_os = "macos")]
    use objc2_foundation::NSString;
    #[cfg(target_os = "macos")]
    use objc2_web_kit::{WKUserScript, WKUserScriptInjectionTime};
    use tauri::Window;
    #[cfg(target_os = "windows")]
    use webview2_com::{take_pwstr, NavigationStartingEventHandler};
    #[cfg(target_os = "macos")]
    use wry::WebViewExtMacOS;
    #[cfg(target_os = "windows")]
    use wry::WebViewExtWindows;
    use wry::{
        dpi::{LogicalPosition, LogicalSize},
        raw_window_handle::HasWindowHandle,
        NewWindowResponse, PageLoadEvent, Rect, WebView, WebViewBuilder,
    };

    use super::{browser_download_allowed, http_url, BrowserBounds, IPC_GUARD_SCRIPT};

    thread_local! {
        // Wry WebViews are main-thread objects. Keeping the registry thread-local
        // makes that invariant structural and avoids unsafe Send wrappers.
        static BROWSERS: RefCell<HashMap<String, WebView>> = RefCell::new(HashMap::new());
    }

    #[cfg(all(test, target_os = "windows"))]
    mod smoke_observer {
        use std::sync::{Mutex, OnceLock};

        static EVENTS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

        fn events() -> &'static Mutex<Vec<String>> {
            EVENTS.get_or_init(|| Mutex::new(Vec::new()))
        }

        pub(super) fn reset() {
            events().lock().unwrap().clear();
        }

        pub(super) fn record(event: String) {
            events().lock().unwrap().push(event);
        }

        pub(super) fn snapshot() -> Vec<String> {
            events().lock().unwrap().clone()
        }
    }

    pub(super) fn rect(bounds: BrowserBounds) -> Rect {
        Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        }
    }

    #[cfg(target_os = "macos")]
    fn install_ipc_guard(view: &WebView) -> Result<(), String> {
        let mtm =
            MainThreadMarker::new().ok_or_else(|| "browser is not on main thread".to_owned())?;
        let manager = view.manager();
        unsafe {
            // Wry's own script is non-configurable once it runs, so remove it
            // before loading any URL and replace it with our immutable guard.
            manager.removeAllUserScripts();
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                WKUserScript::alloc(mtm),
                &NSString::from_str(IPC_GUARD_SCRIPT),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
            );
            manager.addUserScript(&script);
        }
        Ok(())
    }

    fn builder(
        bounds: BrowserBounds,
        on_navigated: impl Fn(String) + Send + 'static,
    ) -> WebViewBuilder<'static> {
        WebViewBuilder::new()
            .with_bounds(rect(bounds))
            .with_initialization_script(IPC_GUARD_SCRIPT)
            .with_navigation_handler(|candidate| {
                let allowed = http_url(&candidate).is_ok();
                #[cfg(all(test, target_os = "windows"))]
                smoke_observer::record(format!(
                    "navigation:{}:{candidate}",
                    if allowed { "allow" } else { "deny" }
                ));
                allowed
            })
            .with_download_started_handler(|_url, _| {
                let allowed = browser_download_allowed();
                #[cfg(all(test, target_os = "windows"))]
                smoke_observer::record(format!(
                    "download:{}:{_url}",
                    if allowed { "allow" } else { "deny" }
                ));
                allowed
            })
            .with_new_window_req_handler(|_url, _| {
                #[cfg(all(test, target_os = "windows"))]
                smoke_observer::record(format!("popup:deny:{_url}"));
                NewWindowResponse::Deny
            })
            .with_on_page_load_handler(move |event, loaded_url| {
                if matches!(event, PageLoadEvent::Finished) && http_url(&loaded_url).is_ok() {
                    on_navigated(loaded_url);
                }
            })
    }

    #[cfg(target_os = "macos")]
    fn build_child<W: HasWindowHandle>(
        window: &W,
        bounds: BrowserBounds,
        on_navigated: impl Fn(String) + Send + 'static,
    ) -> Result<WebView, String> {
        let view = builder(bounds, on_navigated)
            .build_as_child(window)
            .map_err(|error| error.to_string())?;
        install_ipc_guard(&view)?;
        Ok(view)
    }

    #[cfg(target_os = "windows")]
    fn install_windows_policy(view: &WebView) -> Result<(), String> {
        let mut token = 0;
        let webview = view.webview();
        // Wry registers an inert WebMessageReceived callback even without an
        // IPC closure. Disable the WebView2 facility itself so arbitrary remote
        // pages cannot send any page-to-native messages through
        // window.chrome.webview or Wry's non-configurable window.ipc shim.
        let settings = unsafe { webview.Settings() }.map_err(|error| error.to_string())?;
        unsafe { settings.SetIsWebMessageEnabled(false) }.map_err(|error| error.to_string())?;
        unsafe {
            webview.add_FrameNavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut uri = Default::default();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    let allowed = http_url(&uri).is_ok();
                    #[cfg(all(test, target_os = "windows"))]
                    smoke_observer::record(format!(
                        "frame-navigation:{}:{uri}",
                        if allowed { "allow" } else { "deny" }
                    ));
                    args.SetCancel(!allowed)?;
                    Ok(())
                })),
                &mut token,
            )
        }
        .map_err(|error| error.to_string())
    }

    #[cfg(target_os = "windows")]
    fn build_child<W: HasWindowHandle>(
        window: &W,
        bounds: BrowserBounds,
        on_navigated: impl Fn(String) + Send + 'static,
    ) -> Result<WebView, String> {
        let view = builder(bounds, on_navigated)
            .build_as_child(window)
            .map_err(|error| {
                format!(
                    "could not start the embedded browser through WebView2: {error}. Install or repair the Microsoft Edge WebView2 Runtime, then try again"
                )
            })?;
        install_windows_policy(&view)?;
        Ok(view)
    }

    pub fn on_main<T: Send + 'static>(
        window: Window,
        task: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = sync_channel(1);
        window
            .run_on_main_thread(move || {
                let _ = tx.send(task());
            })
            .map_err(|error| error.to_string())?;
        rx.recv()
            .map_err(|_| "browser main-thread task ended".to_owned())?
    }

    pub fn create(
        window: Window,
        id: String,
        url: String,
        bounds: BrowserBounds,
        on_navigated: impl Fn(String) + Send + 'static,
    ) -> Result<(), String> {
        on_main(window.clone(), move || {
            let reused = BROWSERS.with(|registry| {
                let registry = registry.borrow();
                registry.get(&id).map(|view| {
                    view.set_bounds(rect(bounds))
                        .map_err(|error| error.to_string())?;
                    if view.url().map_err(|error| error.to_string())? != url {
                        view.load_url(&url).map_err(|error| error.to_string())?;
                    }
                    view.set_visible(true).map_err(|error| error.to_string())
                })
            });
            if let Some(result) = reused {
                return result;
            }

            let view = build_child(&window, bounds, on_navigated)?;
            // Loading only after platform isolation setup guarantees no remote
            // page can observe Tauri internals during its earliest page script.
            view.load_url(&url).map_err(|error| error.to_string())?;
            BROWSERS.with(|registry| registry.borrow_mut().insert(id, view));
            Ok(())
        })
    }

    pub fn with_view(
        window: Window,
        id: String,
        action: impl FnOnce(&WebView) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        on_main(window, move || {
            BROWSERS.with(|registry| {
                let registry = registry.borrow();
                let view = registry
                    .get(&id)
                    .ok_or_else(|| "browser is not open".to_owned())?;
                action(view)
            })
        })
    }

    pub fn exists(window: Window, id: String) -> Result<bool, String> {
        on_main(window, move || {
            Ok(BROWSERS.with(|registry| registry.borrow().contains_key(&id)))
        })
    }

    pub fn evaluate(
        window: Window,
        id: String,
        script: String,
        callback: impl Fn(String) + Send + 'static,
    ) -> Result<(), String> {
        on_main(window, move || {
            BROWSERS.with(|registry| {
                let registry = registry.borrow();
                let view = registry
                    .get(&id)
                    .ok_or_else(|| "browser is not open".to_owned())?;
                view.evaluate_script_with_callback(&script, callback)
                    .map_err(|error| error.to_string())
            })
        })
    }

    #[cfg(target_os = "macos")]
    pub fn back(view: &WebView) -> Result<(), String> {
        // Wry does not expose history at its cross-platform layer; this is the
        // native WKWebView history API and does not evaluate page script.
        unsafe {
            let _ = view.webview().goBack();
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    pub fn back(view: &WebView) -> Result<(), String> {
        // Use WebView2 history directly; browser commands never evaluate code
        // inside the remote page.
        unsafe { view.webview().GoBack() }.map_err(|error| error.to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn forward(view: &WebView) -> Result<(), String> {
        unsafe {
            let _ = view.webview().goForward();
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    pub fn forward(view: &WebView) -> Result<(), String> {
        unsafe { view.webview().GoForward() }.map_err(|error| error.to_string())
    }

    pub fn destroy(window: Window, id: String) -> Result<(), String> {
        on_main(window, move || {
            BROWSERS.with(|registry| {
                registry.borrow_mut().remove(&id);
            });
            Ok(())
        })
    }

    #[cfg(all(test, target_os = "windows"))]
    #[path = "browser_windows_smoke.rs"]
    mod windows_smoke;
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn wait_for_agent_browser(window: &Window) -> Result<(), String> {
    for _ in 0..50 {
        if platform::exists(window.clone(), EDITOR_BROWSER_ID.to_owned())? {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("Kodade's internal browser did not become visible".to_owned())
}

pub(crate) async fn agent_navigate(window: Window, url: String) -> Result<Value, String> {
    let url = agent_url(&url)?.to_string();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        wait_for_agent_browser(&window).await?;
        let loaded = url.clone();
        platform::with_view(window, EDITOR_BROWSER_ID.to_owned(), move |view| {
            view.load_url(&loaded).map_err(|error| error.to_string())
        })?;
        Ok(serde_json::json!({ "url": url }))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, url);
        unsupported()?;
        unreachable!()
    }
}

pub(crate) async fn agent_evaluate(window: Window, script: String) -> Result<Value, String> {
    if script.len() > MAX_AGENT_SCRIPT_BYTES {
        return Err("browser automation script exceeds the size limit".to_owned());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        wait_for_agent_browser(&window).await?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        platform::evaluate(
            window,
            EDITOR_BROWSER_ID.to_owned(),
            script,
            move |result| {
                if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                    let _ = sender.send(result);
                }
            },
        )?;
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
            .await
            .map_err(|_| "the internal browser page did not answer in time".to_owned())?
            .map_err(|_| "the internal browser page ended before answering".to_owned())?;
        if result.len() > MAX_AGENT_RESULT_BYTES {
            return Err("the internal browser page result exceeded 512 KiB".to_owned());
        }
        let value: Value = serde_json::from_str(&result)
            .map_err(|_| "the internal browser page returned invalid data".to_owned())?;
        if let Some(error) = value
            .as_object()
            .and_then(|object| object.get("_kodadeError"))
            .and_then(Value::as_str)
        {
            return Err(error.to_owned());
        }
        Ok(value)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, script);
        unsupported()?;
        unreachable!()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn unsupported() -> Result<(), String> {
    Err("embedded browser is currently available on macOS and Windows".to_owned())
}

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    window: Window,
    id: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    let url = http_url(&url)?.to_string();
    let bounds = checked_bounds(bounds)?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let event_id = id.clone();
        platform::create(window, id, url, bounds, move |loaded_url| {
            let _ = app.emit(
                EVENT_NAVIGATED,
                BrowserNavigated {
                    id: event_id.clone(),
                    url: loaded_url,
                },
            );
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, window, id, url, bounds);
        unsupported()
    }
}

#[tauri::command]
pub async fn browser_navigate(window: Window, id: String, url: String) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    let url = http_url(&url)?.to_string();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::with_view(window, id, move |view| {
            view.load_url(&url).map_err(|error| error.to_string())
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, id, url);
        unsupported()
    }
}

#[tauri::command]
pub async fn browser_back(window: Window, id: String) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::with_view(window, id, platform::back)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, id);
        unsupported()
    }
}

#[tauri::command]
pub async fn browser_forward(window: Window, id: String) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::with_view(window, id, platform::forward)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, id);
        unsupported()
    }
}

#[tauri::command]
pub async fn browser_reload(window: Window, id: String) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::with_view(window, id, |view| {
            view.reload().map_err(|error| error.to_string())
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, id);
        unsupported()
    }
}

#[tauri::command]
pub async fn browser_set_bounds(
    window: Window,
    id: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    let bounds = checked_bounds(bounds)?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::with_view(window, id, move |view| {
            view.set_bounds(platform::rect(bounds))
                .map_err(|error| error.to_string())
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, id, bounds);
        unsupported()
    }
}

#[tauri::command]
pub async fn browser_show(window: Window, id: String) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::with_view(window, id, |view| {
            view.set_visible(true).map_err(|error| error.to_string())
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, id);
        unsupported()
    }
}

#[tauri::command]
pub async fn browser_hide(window: Window, id: String) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::with_view(window, id, |view| {
            view.set_visible(false).map_err(|error| error.to_string())
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, id);
        unsupported()
    }
}

#[tauri::command]
pub async fn browser_destroy(window: Window, id: String) -> Result<(), String> {
    require_development_feature("KödBrowser")?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::destroy(window, id)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, id);
        unsupported()
    }
}

#[cfg(test)]
mod tests {
    use super::{agent_url, browser_download_allowed, checked_bounds, http_url, BrowserBounds};

    #[test]
    fn accepts_only_http_urls_with_hosts() {
        assert!(http_url("https://example.com/path").is_ok());
        assert!(http_url("http://localhost:3000").is_ok());
        assert!(http_url("file:///tmp/a").is_err());
        assert!(http_url("javascript:alert(1)").is_err());
        assert!(http_url("kodade-doc://localhost/repo/secret.pdf").is_err());
        assert!(http_url("tauri://localhost").is_err());
        assert!(http_url("data:text/html,<script>alert(1)</script>").is_err());
        assert!(http_url("https://").is_err());
    }

    #[test]
    fn parses_userinfo_as_credentials_not_the_host() {
        let url = http_url("https://good.example@evil.example/path").unwrap();
        assert_eq!(url.username(), "good.example");
        assert_eq!(url.host_str(), Some("evil.example"));
    }

    #[test]
    fn agent_navigation_adds_https_to_a_bare_host() {
        assert_eq!(
            agent_url(" example.com/docs ").unwrap().as_str(),
            "https://example.com/docs"
        );
        assert!(agent_url("file:///tmp/a").is_err());
    }

    #[test]
    fn denies_every_download() {
        assert!(!browser_download_allowed());
    }

    #[test]
    fn rejects_empty_or_non_finite_bounds() {
        let valid = BrowserBounds {
            x: 0.0,
            y: 10.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(checked_bounds(valid).is_ok());
        assert!(checked_bounds(BrowserBounds {
            width: 0.0,
            ..valid
        })
        .is_err());
        assert!(checked_bounds(BrowserBounds {
            x: f64::NAN,
            ..valid
        })
        .is_err());
    }
}
