use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tao::{
    event_loop::EventLoopBuilder, platform::windows::EventLoopBuilderExtWindows,
    window::WindowBuilder,
};
use webview2_com::WebMessageReceivedEventHandler;
use windows::{
    Win32::Foundation::HWND,
    Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, IsWindow, PeekMessageW, TranslateMessage, MSG, PM_REMOVE, WM_QUIT,
    },
};
use wry::{dpi::LogicalSize, WebView, WebViewExtWindows};

use super::{back, build_child, forward, rect, smoke_observer, BrowserBounds};

const STEP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_MESSAGES_PER_PUMP: usize = 256;

#[test]
fn win32_message_pump_returns_without_input() {
    let (finished_tx, finished_rx) = mpsc::channel();
    thread::spawn(move || {
        pump_once();
        let _ = finished_tx.send(());
    });
    assert!(
        finished_rx.recv_timeout(Duration::from_secs(1)).is_ok(),
        "Win32 message pump blocked while its queue was empty"
    );
}

#[test]
#[ignore = "run explicitly on a Windows desktop with WebView2"]
fn real_webview2_child_enforces_lifecycle_and_remote_ipc_boundary() {
    milestone("starting loopback fixture and Win32 parent");
    smoke_observer::reset();
    let fixture = FixtureServer::start();
    let policy_url = fixture.url("/policy");
    let second_url = fixture.url("/second");

    let mut event_loop_builder = EventLoopBuilder::<()>::with_user_event();
    event_loop_builder.with_any_thread(true);
    let event_loop = event_loop_builder.build();
    let window = WindowBuilder::new()
        .with_title("Kodade browser child smoke")
        .with_inner_size(LogicalSize::new(700.0, 500.0))
        .build(&event_loop)
        .expect("create a real Win32 parent window");

    let (navigation_tx, navigation_rx) = mpsc::channel();
    let initial_bounds = BrowserBounds {
        x: 9.0,
        y: 11.0,
        width: 420.0,
        height: 280.0,
    };
    let mut webview = Some(
        build_child(&window, initial_bounds, move |url| {
            let _ = navigation_tx.send(url);
        })
        .expect("create a real Wry child WebView2 with Kodade policy"),
    );
    milestone("created child WebView2 and installed Kodade policy");

    let native_messages = Arc::new(AtomicUsize::new(0));
    install_native_message_sentinel(webview.as_ref().unwrap(), native_messages.clone());
    assert_web_messages_disabled(webview.as_ref().unwrap());

    webview
        .as_ref()
        .unwrap()
        .load_url(&policy_url)
        .expect("navigate the isolated child to the loopback fixture");

    let mut policy_finished = false;
    let policy_ready = pump_until(STEP_TIMEOUT, || {
        policy_finished |= navigation_rx.try_iter().any(|url| url == policy_url);
        let requests = fixture.requests();
        let events = smoke_observer::snapshot();
        policy_finished
            && has_request(&requests, "/report?tauri=undefined")
            && has_request(&requests, "/report?guard=locked")
            && has_request(&requests, "/report?chrome=")
            && has_request(&requests, "/report?wry=")
            && has_request(&requests, "/report?about-tauri=undefined")
            && has_request(&requests, "/report?about-guard=locked")
            && has_request(&requests, "/report?about-chrome=")
            && has_request(&requests, "/report?about-wry=")
            && has_request(&requests, "/report?srcdoc-tauri=undefined")
            && has_request(&requests, "/report?srcdoc-guard=locked")
            && has_request(&requests, "/report?srcdoc-chrome=")
            && has_request(&requests, "/report?srcdoc-wry=")
            && events
                .iter()
                .any(|event| event.starts_with("frame-navigation:deny:data:"))
            && events.iter().any(|event| event.starts_with("popup:deny:"))
            && events
                .iter()
                .any(|event| event.starts_with("download:deny:"))
    });
    assert!(
        policy_ready,
        "fixture policy proof timed out; requests={:?}; native_events={:?}",
        fixture.requests(),
        smoke_observer::snapshot()
    );
    milestone("proved frame/popup/download policy and main/about:blank/srcdoc isolation");
    pump_for(Duration::from_millis(250));
    assert_eq!(
        native_messages.load(Ordering::SeqCst),
        0,
        "remote WebView2 messages reached a native WebMessageReceived handler"
    );
    assert!(
        !has_request(&fixture.requests(), "/popup"),
        "denied popup unexpectedly reached the HTTP fixture"
    );

    let view = webview.as_ref().unwrap();
    view.load_url("file:///C:/kodade-browser-smoke-top.html")
        .expect("attempt a native non-HTTP top-level navigation");
    assert!(
        pump_until(STEP_TIMEOUT, || {
            smoke_observer::snapshot()
                .iter()
                .any(|event| event.starts_with("navigation:deny:file:"))
        }),
        "native non-HTTP top-level navigation did not reach the policy gate"
    );
    assert_eq!(
        view.url().expect("read URL after denied navigation"),
        policy_url,
        "denied top-level navigation changed the active document"
    );
    milestone("proved native non-HTTP top-level navigation denial");

    let changed_bounds = BrowserBounds {
        x: 27.0,
        y: 31.0,
        width: 333.0,
        height: 222.0,
    };
    view.set_bounds(rect(changed_bounds))
        .expect("change child bounds through Wry");
    assert_controller_size(view, &window, changed_bounds);
    view.set_visible(false).expect("hide child WebView2");
    assert!(
        !controller_visible(view),
        "native controller stayed visible"
    );
    view.set_visible(true).expect("show child WebView2");
    assert!(controller_visible(view), "native controller stayed hidden");
    milestone("proved native bounds and visibility");

    view.load_url(&second_url)
        .expect("navigate to the second fixture page");
    assert!(
        wait_for_navigation(&navigation_rx, &second_url),
        "second-page navigation did not finish"
    );
    milestone("loaded second history entry");

    assert_history_available(view, true, false);
    back(view).expect("go back through native WebView2 history");
    assert!(
        wait_for_navigation(&navigation_rx, &policy_url),
        "native back navigation did not finish"
    );
    milestone("completed native back navigation");

    assert_history_available(view, false, true);
    forward(view).expect("go forward through native WebView2 history");
    assert!(
        wait_for_navigation(&navigation_rx, &second_url),
        "native forward navigation did not finish"
    );
    milestone("completed native forward navigation");

    view.reload().expect("reload the WebView2 child");
    assert!(
        wait_for_navigation(&navigation_rx, &second_url),
        "reload navigation did not finish"
    );
    milestone("completed native reload");

    let child_hwnd = controller_parent(view);
    assert!(
        unsafe { IsWindow(Some(child_hwnd)) }.as_bool(),
        "Wry child HWND was not alive before teardown"
    );
    milestone("captured a live Wry child HWND");

    drop(webview.take());
    milestone("WebView drop returned");
    pump_for(Duration::from_millis(250));
    assert!(
        !unsafe { IsWindow(Some(child_hwnd)) }.as_bool(),
        "Wry child HWND still existed after WebView teardown"
    );
    milestone("proved Win32 child destruction");
    assert_eq!(
        native_messages.load(Ordering::SeqCst),
        0,
        "native IPC sentinel fired after the full lifecycle"
    );
}

fn milestone(message: &str) {
    eprintln!("[browser-child-smoke] {message}");
}

fn controller_parent(view: &WebView) -> HWND {
    let mut hwnd = HWND::default();
    unsafe { view.controller().ParentWindow(&mut hwnd) }
        .expect("read the Wry child container HWND from WebView2");
    assert_ne!(hwnd, HWND::default(), "WebView2 returned a null child HWND");
    hwnd
}

fn install_native_message_sentinel(view: &WebView, messages: Arc<AtomicUsize>) {
    let mut token = 0;
    unsafe {
        view.webview()
            .add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |_, _| {
                    messages.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })),
                &mut token,
            )
            .expect("attach a native IPC sentinel");
    }
}

fn assert_web_messages_disabled(view: &WebView) {
    let settings = unsafe { view.webview().Settings() }.expect("read WebView2 settings");
    let mut enabled = Default::default();
    unsafe { settings.IsWebMessageEnabled(&mut enabled) }.expect("read IsWebMessageEnabled");
    assert!(!enabled.as_bool(), "WebView2 page messaging is enabled");
}

fn assert_controller_size(view: &WebView, window: &tao::window::Window, bounds: BrowserBounds) {
    let scale = window.scale_factor();
    let expected = LogicalSize::new(bounds.width, bounds.height).to_physical::<i32>(scale);
    let mut actual = Default::default();
    unsafe { view.controller().Bounds(&mut actual) }.expect("read native controller bounds");
    assert_eq!(
        (actual.right, actual.bottom),
        (expected.width, expected.height)
    );
}

fn controller_visible(view: &WebView) -> bool {
    let mut visible = Default::default();
    unsafe { view.controller().IsVisible(&mut visible) }
        .expect("read native controller visibility");
    visible.as_bool()
}

fn assert_history_available(view: &WebView, back_expected: bool, forward_expected: bool) {
    let webview = view.webview();
    let mut can_go_back = Default::default();
    let mut can_go_forward = Default::default();
    unsafe {
        webview.CanGoBack(&mut can_go_back).expect("read CanGoBack");
        webview
            .CanGoForward(&mut can_go_forward)
            .expect("read CanGoForward");
    }
    assert_eq!(can_go_back.as_bool(), back_expected);
    assert_eq!(can_go_forward.as_bool(), forward_expected);
}

fn wait_for_navigation(navigation_rx: &mpsc::Receiver<String>, expected: &str) -> bool {
    pump_until(STEP_TIMEOUT, || {
        navigation_rx.try_iter().any(|url| url == expected)
    })
}

fn pump_until(timeout: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ready() {
            return true;
        }
        pump_once();
        thread::sleep(Duration::from_millis(10));
    }
    ready()
}

fn pump_for(duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        pump_once();
        thread::sleep(Duration::from_millis(10));
    }
}

fn pump_once() {
    let mut message = MSG::default();
    for _ in 0..MAX_MESSAGES_PER_PUMP {
        if !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
            break;
        }
        assert_ne!(
            message.message, WM_QUIT,
            "Win32 message pump received an unexpected thread quit"
        );
        unsafe {
            let _ = TranslateMessage(&message);
            let _ = DispatchMessageW(&message);
        }
    }
}

fn has_request(requests: &[String], prefix: &str) -> bool {
    requests.iter().any(|request| request.starts_with(prefix))
}

struct FixtureServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl FixtureServer {
    fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback fixture");
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_requests = requests.clone();
        let worker_stop = stop.clone();
        let worker = thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                let Ok((stream, _)) = listener.accept() else {
                    continue;
                };
                if worker_stop.load(Ordering::SeqCst) {
                    break;
                }
                serve(stream, &worker_requests);
            }
        });
        Self {
            addr,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

fn serve(mut stream: TcpStream, requests: &Mutex<Vec<String>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buffer = [0_u8; 8192];
    let Ok(read) = stream.read(&mut buffer) else {
        return;
    };
    let request = String::from_utf8_lossy(&buffer[..read]);
    let Some(path) = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
    else {
        return;
    };
    requests.lock().unwrap().push(path.to_owned());

    let (status, content_type, extra_headers, body) = match path.split('?').next().unwrap_or(path) {
        "/policy" => ("200 OK", "text/html", "", POLICY_PAGE.as_bytes()),
        "/second" => ("200 OK", "text/html", "", SECOND_PAGE.as_bytes()),
        "/download" => (
            "200 OK",
            "application/octet-stream",
            "Content-Disposition: attachment; filename=kodade-smoke.txt\r\n",
            b"download must be cancelled".as_slice(),
        ),
        "/popup" => (
            "200 OK",
            "text/html",
            "",
            b"popup must be denied".as_slice(),
        ),
        "/report" => ("204 No Content", "text/plain", "", b"".as_slice()),
        _ => ("404 Not Found", "text/plain", "", b"not found".as_slice()),
    };
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{extra_headers}Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
}

const POLICY_PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Kodade browser policy smoke</title>
<script>
const report = (key, value) => fetch(`/report?${key}=${encodeURIComponent(value)}`, {
  cache: "no-store",
  keepalive: true
});
addEventListener("DOMContentLoaded", () => {
  const invoke = JSON.stringify({ cmd: "storage_read", callback: 1, error: 2, payload: {} });
  const probe = (scope, target) => {
    const guard = Object.getOwnPropertyDescriptor(target, "__TAURI_INTERNALS__");
    report(`${scope}tauri`, typeof target.__TAURI_INTERNALS__);
    report(`${scope}guard`, guard && guard.value === undefined &&
      !guard.configurable && !guard.enumerable && !guard.writable ? "locked" : "missing");
    try {
      target.chrome.webview.postMessage(invoke);
      report(`${scope}chrome`, "returned");
    } catch (_) {
      report(`${scope}chrome`, "threw");
    }
    try {
      target.ipc.postMessage(invoke);
      report(`${scope}wry`, "returned");
    } catch (_) {
      report(`${scope}wry`, "threw");
    }
  };
  probe("", window);

  const about = document.createElement("iframe");
  about.src = "about:blank";
  document.body.append(about);
  setTimeout(() => probe("about-", about.contentWindow), 0);

  const srcdoc = document.createElement("iframe");
  srcdoc.srcdoc = "<!doctype html><title>Kodade srcdoc isolation probe</title>";
  document.body.append(srcdoc);
  setTimeout(() => probe("srcdoc-", srcdoc.contentWindow), 50);

  const popup = window.open("/popup", "kodade-smoke-popup");
  report("popup", popup === null ? "blocked" : "returned");
  const download = document.createElement("a");
  download.href = "/download";
  download.download = "kodade-smoke.txt";
  document.body.append(download);
  download.click();
  report("download", "attempted");
  const frame = document.createElement("iframe");
  frame.src = "data:text/html,kodade-browser-smoke-frame";
  document.body.append(frame);
  report("frame", "attempted");
});
</script>
"#;

const SECOND_PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Kodade browser history smoke</title>
<p>second page</p>
"#;
