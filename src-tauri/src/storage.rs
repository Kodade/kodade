// Thin persistence: JSON documents on disk. No shape or versioning logic here —
// the TypeScript side owns the schema; Rust just moves bytes atomically.
//
// Two surfaces: the single main document (kodade.json), and named side
// documents (KödChat transcripts at chats/<threadId>.json) that are too big and
// too private to belong in the main doc. Named docs are confined to the app data
// dir by a strict name validator — Rust never interprets their contents.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

const DOC_NAME: &str = "kodade.json";

// A named document may only be a short relative `.json` path built from safe
// characters. This rejects absolute paths, `..`, `.`, backslashes, drive
// letters, and anything that could escape the app data dir.
const MAX_DOC_NAME: usize = 200;

fn validate_doc_name(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.len() > MAX_DOC_NAME {
        return Err(format!("invalid document name: {name}"));
    }
    if !name.ends_with(".json") {
        return Err(format!("document name must end in .json: {name}"));
    }
    let mut path = PathBuf::new();
    let mut segments = 0;
    for segment in name.split('/') {
        segments += 1;
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!("invalid document name: {name}"));
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(format!("invalid document name: {name}"));
        }
        path.push(segment);
    }
    // One optional subdirectory ("chats/<id>.json") is all any caller needs.
    if segments > 2 {
        return Err(format!("document name is too deeply nested: {name}"));
    }
    Ok(path)
}

// Read one named side document, or None if it doesn't exist yet.
pub fn read_named_doc(dir: &Path, name: &str) -> Result<Option<String>, String> {
    let path = dir.join(validate_doc_name(name)?);
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

// Write one named side document with the same atomic + durable discipline as
// the main document, creating its parent directory on first use.
pub fn write_named_doc(dir: &Path, name: &str, contents: &str) -> Result<(), String> {
    let relative = validate_doc_name(name)?;
    let path = dir.join(&relative);
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid document name: {name}"))?
        .to_path_buf();
    write_atomic(&parent, &path, contents)
}

// Delete one named side document. Missing is success — deleting a thread that
// was never persisted must not fail the caller.
pub fn delete_named_doc(dir: &Path, name: &str) -> Result<(), String> {
    let path = dir.join(validate_doc_name(name)?);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {e}", path.display())),
    }
}

// Read the document from `dir`, or None if it doesn't exist yet.
pub fn read_doc(dir: &Path) -> Result<Option<String>, String> {
    let path = dir.join(DOC_NAME);
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

// Write the document atomically and durably: unique temp file in the same dir,
// fsync it, rename over the real one, then best-effort fsync the dir so the
// rename itself survives a crash. A failure can never leave a partial document.
pub fn write_doc(dir: &Path, contents: &str) -> Result<(), String> {
    write_atomic(dir, &dir.join(DOC_NAME), contents)
}

// Shared atomic-write mechanics for both the main and named documents.
fn write_atomic(dir: &Path, path: &Path, contents: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let (mut file, tmp) = crate::fs::create_temp_excl(dir, "kodade.json.tmp")?;

    let result = (|| {
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        // Durability: the temp file's bytes must be on disk before the rename
        // makes them the real document.
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
        drop(file);
        crate::fs::atomic_replace(&tmp, path)
            .map_err(|e| format!("rename to {}: {e}", path.display()))
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp); // don't litter temp files on failure
    } else {
        // Best-effort: fsync the directory so the rename is durable too. Some
        // platforms refuse to sync directories — ignore, the write succeeded.
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kodade-storage-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn named_docs_round_trip_and_delete() {
        let dir = temp_dir("named");
        assert_eq!(read_named_doc(&dir, "chats/abc.json").unwrap(), None);
        write_named_doc(&dir, "chats/abc.json", "{\"a\":1}").unwrap();
        assert_eq!(
            read_named_doc(&dir, "chats/abc.json").unwrap().as_deref(),
            Some("{\"a\":1}")
        );
        // Overwrite is atomic and replaces the prior bytes wholesale.
        write_named_doc(&dir, "chats/abc.json", "{\"a\":2}").unwrap();
        assert_eq!(
            read_named_doc(&dir, "chats/abc.json").unwrap().as_deref(),
            Some("{\"a\":2}")
        );
        delete_named_doc(&dir, "chats/abc.json").unwrap();
        assert_eq!(read_named_doc(&dir, "chats/abc.json").unwrap(), None);
        // Deleting again is success, not an error.
        delete_named_doc(&dir, "chats/abc.json").unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn document_names_cannot_escape_the_data_directory() {
        for name in [
            "",
            "kodade.json/..",
            "../kodade.json",
            "chats/../../secret.json",
            "/etc/passwd.json",
            "chats/a/b/c.json",
            "chats/abc.txt",
            "chats/ab c.json",
            "C:\\temp\\x.json",
            "chats/./x.json",
        ] {
            assert!(validate_doc_name(name).is_err(), "accepted {name:?}");
        }
        for name in ["kodade.json", "chats/abc.json", "chats/a-b_c.1.json"] {
            assert!(validate_doc_name(name).is_ok(), "rejected {name:?}");
        }
    }

    #[test]
    fn the_main_document_still_round_trips() {
        let dir = temp_dir("main");
        assert_eq!(read_doc(&dir).unwrap(), None);
        write_doc(&dir, "{}").unwrap();
        assert_eq!(read_doc(&dir).unwrap().as_deref(), Some("{}"));
        let _ = fs::remove_dir_all(dir);
    }
}
