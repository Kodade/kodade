// Integration tests for the JSON-document storage against real temp dirs.

use kodade_lib::storage::{read_doc, write_doc};

// A unique temp dir per test so parallel tests never collide.
fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("kodade-storage-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn read_missing_doc_is_none() {
    let dir = temp_dir("missing");
    assert_eq!(read_doc(&dir).unwrap(), None);
}

#[test]
fn write_then_read_round_trips() {
    let dir = temp_dir("roundtrip");
    let doc = r#"{"version":1,"projects":[]}"#;

    // Dir doesn't exist yet — write must create it.
    write_doc(&dir, doc).expect("write ok");
    assert_eq!(read_doc(&dir).unwrap().as_deref(), Some(doc));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn write_over_existing_replaces_cleanly() {
    let dir = temp_dir("overwrite");
    write_doc(&dir, "first").expect("first write ok");
    write_doc(&dir, "second-longer-content").expect("overwrite ok");
    assert_eq!(
        read_doc(&dir).unwrap().as_deref(),
        Some("second-longer-content")
    );
    // No temp file (unique-named "kodade.json.tmp.*") may linger after renames.
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("kodade.json.tmp"))
        .collect();
    assert!(leftovers.is_empty(), "lingering temp files: {leftovers:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn repeated_persistence_replaces_the_same_document() {
    let dir = temp_dir("repeated");
    for index in 0..16 {
        let doc = format!(r#"{{"version":1,"save":{index}}}"#);
        write_doc(&dir, &doc).expect("every persistence replacement succeeds");
        assert_eq!(read_doc(&dir).unwrap().as_deref(), Some(doc.as_str()));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn write_failure_leaves_existing_doc_intact() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp_dir("atomic");
    write_doc(&dir, "precious").expect("seed write ok");

    // Sabotage: a read-only dir makes the temp-file creation fail before any
    // rename can happen.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    assert!(write_doc(&dir, "new-data").is_err());
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

    // The original document is untouched — no partial/clobbered file.
    assert_eq!(read_doc(&dir).unwrap().as_deref(), Some("precious"));

    let _ = std::fs::remove_dir_all(&dir);
}
