#![cfg(windows)]

// Native Windows release-candidate probes that cross the public Rust seams.
// Keep these serial: provider detection temporarily prepends a fixture to PATH.

use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kodade_lib::detect::detect_version;
use kodade_lib::document::serve;
use kodade_lib::fs::{list_dir, rename, trash, watch, write_file, ChangeSink};
use kodade_lib::shell::ShellEnvironment;
use kodade_lib::storage::{read_doc, write_doc};
use tauri::http::{header, Request, StatusCode};

type TestChangeSink = (ChangeSink, Receiver<Vec<String>>, Arc<Mutex<Vec<String>>>);

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kodade Windows RC Kødade {tag} {}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

fn request_for(path: &std::path::Path) -> Request<Vec<u8>> {
    let encoded: String =
        url::form_urlencoded::byte_serialize(path.as_os_str().as_encoded_bytes()).collect();
    Request::builder()
        .uri(format!("kodade-doc://localhost/?path={encoded}"))
        .body(Vec::new())
        .unwrap()
}

fn change_sink() -> TestChangeSink {
    let all = Arc::new(Mutex::new(Vec::<String>::new()));
    let all_sink = all.clone();
    let (tx, rx) = channel();
    let sink: ChangeSink = Arc::new(move |paths| {
        all_sink.lock().unwrap().extend(paths.clone());
        let _ = tx.send(paths);
    });
    (sink, rx, all)
}

fn wait_for_change(
    rx: &Receiver<Vec<String>>,
    all: &Arc<Mutex<Vec<String>>>,
    needle: &str,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if all.lock().unwrap().iter().any(|path| path.contains(needle)) {
            return true;
        }
        let _ = rx.recv_timeout(Duration::from_millis(200));
    }
    false
}

#[test]
fn provider_detection_executes_an_npm_cmd_shim_from_a_unicode_path() {
    let root = temp_dir("provider shim");
    let bin = root.join("Program Files").join("Kødade Tools");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(
        bin.join("kodade-rc-provider.cmd"),
        "@echo off\r\necho kodade-rc-provider 9.8.7\r\n",
    )
    .unwrap();

    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![bin];
    paths.extend(std::env::split_paths(&original_path));
    let fixture_path = std::env::join_paths(paths).unwrap();
    std::env::set_var("PATH", &fixture_path);

    let output = detect_version(&ShellEnvironment::current(), "kodade-rc-provider");

    std::env::set_var("PATH", original_path);
    assert_eq!(output.as_deref(), Some("kodade-rc-provider 9.8.7"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn unicode_project_persists_and_file_operations_reach_the_native_watcher_and_trash() {
    let root = temp_dir("project persistence").join("Project Ω with spaces");
    std::fs::create_dir_all(&root).unwrap();
    let app_data = temp_dir("app data");
    let original = root.join("notes ünicode.md");
    let renamed = root.join("renamed ünicode.md");

    let doc = serde_json::json!({
        "version": 1,
        "projects": [{
            "id": "windows-rc",
            "name": "Project Ω with spaces",
            "path": root.to_string_lossy()
        }],
        "activeProjectId": "windows-rc"
    })
    .to_string();
    write_doc(&app_data, &doc).expect("persist project document");
    assert_eq!(read_doc(&app_data).unwrap().as_deref(), Some(doc.as_str()));

    let (sink, rx, all) = change_sink();
    let watcher = watch(root.to_str().unwrap(), sink).expect("watch unicode project");
    std::thread::sleep(Duration::from_millis(300));

    write_file(
        original.to_str().unwrap(),
        "# Kødade\n\nSaved on Windows.\n",
    )
    .expect("save unicode file");
    assert!(wait_for_change(&rx, &all, "notes ünicode.md"));
    assert_eq!(
        std::fs::read_to_string(&original).unwrap(),
        "# Kødade\n\nSaved on Windows.\n"
    );

    all.lock().unwrap().clear();
    rename(&original, &renamed).expect("rename unicode file");
    assert!(wait_for_change(&rx, &all, "renamed ünicode.md"));
    assert!(list_dir(root.to_str().unwrap())
        .unwrap()
        .iter()
        .any(|entry| entry.name == "renamed ünicode.md"));

    trash(&renamed).expect("move unicode file to the Windows Recycle Bin");
    assert!(
        !renamed.exists(),
        "trashed file must leave its project path"
    );

    watcher.stop();
    let _ = std::fs::remove_dir_all(app_data);
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn document_viewers_serve_confined_unicode_files_and_reject_escape_paths() {
    let base = temp_dir("document security");
    let root = base.join("Project Ω with spaces");
    std::fs::create_dir_all(&root).unwrap();
    let image = root.join("diagram ünicode.png");
    let pdf = root.join("drawing ünicode.pdf");
    let outside = base.join("outside.png");
    std::fs::write(&image, b"png fixture").unwrap();
    std::fs::write(&pdf, b"%PDF-1.7 fixture").unwrap();
    std::fs::write(&outside, b"private fixture").unwrap();

    let image_response = serve(Some(root.to_str().unwrap()), &request_for(&image));
    assert_eq!(image_response.status(), StatusCode::OK);
    assert_eq!(image_response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(
        image_response.headers()["X-Content-Type-Options"],
        "nosniff"
    );

    let mut pdf_request = request_for(&pdf);
    pdf_request
        .headers_mut()
        .insert(header::RANGE, "bytes=5-9".parse().unwrap());
    let pdf_response = serve(Some(root.to_str().unwrap()), &pdf_request);
    assert_eq!(pdf_response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        pdf_response.headers()[header::CONTENT_TYPE],
        "application/pdf"
    );
    assert_eq!(pdf_response.body(), b"1.7 f");

    let escape = root.join("..").join("outside.png");
    let escape_response = serve(Some(root.to_str().unwrap()), &request_for(&escape));
    assert_eq!(escape_response.status(), StatusCode::FORBIDDEN);

    let _ = std::fs::remove_dir_all(base);
}
