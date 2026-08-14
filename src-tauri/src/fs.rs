// Thin filesystem module for the file-tree pane. All product logic (tree
// shape, lazy expansion, refresh policy) lives in the TypeScript store; this
// module only lists one directory level, reads a file with a size/binary cap,
// and runs a recursive debounced watcher.
//
// Like the PTY manager, change events are delivered through a caller-supplied
// closure (a sink), so the watcher has no Tauri dependency and can be driven
// by integration tests that assert on emitted paths.

use std::collections::HashSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::document;

// Directory names skipped in both listing and watching. Simple name-based skip
// list is fine for v1 — these are the heavy dirs that would flood the watcher
// and clutter the tree.
pub const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build"];

// Read cap: files larger than this are reported as "too large" rather than
// loaded into the editor (~1MB).
pub const MAX_FILE_BYTES: u64 = 1_048_576;

// Debounce window: fs events arriving within this window collapse into one
// emission carrying the union of affected paths.
const DEBOUNCE_MS: u64 = 150;

// One directory entry (one level; the frontend expands children lazily).
// camelCase is the IPC contract: the frontend reads `isDir` — without the
// rename this crossed the boundary as `is_dir` and every directory looked
// like a file (the original "folders don't open" bug).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

// Result of reading a file. The editor renders `Text`, or a placeholder for the
// two failure modes, so a huge or binary file never hangs or crashes the UI.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileRead {
    Text { content: String },
    TooLarge { bytes: u64 },
    Binary { bytes: u64 },
}

// Sink the caller wires to a Tauri event (or, in tests, to a channel).
pub type ChangeSink = Arc<dyn Fn(Vec<String>) + Send + Sync>;

fn is_ignored_name(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

// List a single directory level. Directories sort before files, then by name
// (case-insensitive) — a stable, predictable tree. Ignored dirs are omitted.
pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    list_dir_inner(path, None)
}

pub(crate) fn list_dir_bounded(
    path: &str,
    max_entries: usize,
    max_serialized_bytes: usize,
) -> Result<Vec<DirEntry>, String> {
    list_dir_inner(path, Some((max_entries, max_serialized_bytes)))
}

fn list_dir_inner(path: &str, limits: Option<(usize, usize)>) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(path);
    let read = std::fs::read_dir(dir).map_err(|e| format!("read_dir {path}: {e}"))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut serialized_bytes = 2_usize; // opening and closing JSON brackets
    for item in read {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue, // skip unreadable entries rather than fail the whole listing
        };
        let name = item.file_name().to_string_lossy().to_string();
        // file_type() doesn't follow symlinks; path().is_dir() does — so a
        // symlink to a directory still lists (and expands) as a directory.
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false) || item.path().is_dir();
        if is_dir && is_ignored_name(&name) {
            continue;
        }
        let entry = DirEntry {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir,
        };
        if let Some((max_entries, max_serialized_bytes)) = limits {
            if entries.len() >= max_entries {
                return Err(format!(
                    "directory listing exceeds the {max_entries}-entry tool limit"
                ));
            }
            let entry_bytes = serde_json::to_vec(&entry)
                .map_err(|error| format!("serialize directory entry: {error}"))?
                .len();
            let separator = usize::from(!entries.is_empty());
            if serialized_bytes
                .saturating_add(separator)
                .saturating_add(entry_bytes)
                > max_serialized_bytes
            {
                return Err(format!(
                    "directory listing exceeds the {max_serialized_bytes}-byte tool limit"
                ));
            }
            serialized_bytes += separator + entry_bytes;
        }
        entries.push(entry);
    }

    entries.sort_by(|a, b| match b.is_dir.cmp(&a.is_dir) {
        std::cmp::Ordering::Equal => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        other => other,
    });
    Ok(entries)
}

// Read a file for the editor. Enforces the size cap up front (stat, not read)
// and sniffs the first chunk for a null byte to reject binaries — so neither a
// huge nor a binary file is ever fully loaded.
pub fn read_file(path: &str) -> Result<FileRead, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let bytes = meta.len();
    let max_bytes = document::max_document_bytes(path).unwrap_or(MAX_FILE_BYTES);
    if bytes > max_bytes {
        return Ok(FileRead::TooLarge { bytes });
    }

    // Viewer documents go straight to the confined URI handler. Avoid loading
    // their bytes through IPC only to discover that they are binary.
    if document::max_document_bytes(path).is_some() {
        return Ok(FileRead::Binary { bytes });
    }

    // Capped read (not fs::read): a file that grew or was swapped after the
    // stat above must still never pull more than the cap into memory.
    use std::io::Read as _;
    let mut data = Vec::new();
    let file = std::fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    file.take(max_bytes + 1)
        .read_to_end(&mut data)
        .map_err(|e| format!("read {path}: {e}"))?;
    if data.len() as u64 > max_bytes {
        return Ok(FileRead::TooLarge {
            bytes: data.len() as u64,
        });
    }
    // Null byte anywhere in the (capped) contents = binary. Cheap and correct
    // for source files, which never contain NUL.
    if data.contains(&0) {
        return Ok(FileRead::Binary {
            bytes: data.len() as u64,
        });
    }
    // Non-UTF8 text (rare for source) is also treated as unviewable binary.
    let data_len = data.len() as u64;
    match String::from_utf8(data) {
        Ok(content) => Ok(FileRead::Text { content }),
        Err(_) => Ok(FileRead::Binary { bytes: data_len }),
    }
}

// Unique temp names per write, so concurrent writers never collide on a shared
// scratch file (and a stale temp from a crash never blocks a write).
static WRITE_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

// Write `contents` to `path` atomically and durably: a uniquely-named temp file
// (O_EXCL) in the target's directory, fsync'd, then renamed over the target. A
// failure (read-only file/dir, missing parent) can never truncate or corrupt the
// existing file, since the real file is only ever replaced by an atomic rename of
// a fully-written temp. Returns clear error strings so the editor can surface
// read-only/missing-dir failures.
//
// Symlinks: the path is canonicalized first, so saving a symlinked file updates
// its referent and leaves the link in place. Permissions: the original file's
// mode is applied to the temp file (unix) so the mode survives the rename; ACLs
// and xattrs are not preserved (acceptable for v1, same as many editors).
pub fn write_file(path: &str, contents: &str) -> Result<(), String> {
    // Resolve symlinks first: if `path` is a symlink we want to update the file
    // it points AT (keeping the link intact), and the temp+rename must happen in
    // the referent's directory — a rename can't cross filesystems, and renaming
    // over the link itself would replace the link rather than its target.
    // canonicalize only works when the file exists; for a new file we write the
    // literal path (nothing to resolve yet).
    let target: PathBuf = match std::fs::canonicalize(path) {
        Ok(canon) => canon,
        Err(_) => PathBuf::from(path),
    };
    let target = target.as_path();

    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("no parent directory for {path}"))?;
    if !parent.is_dir() {
        return Err(format!("directory does not exist: {}", parent.display()));
    }
    // If the target exists and isn't writable, fail up front with a clear error
    // rather than writing a temp file we can't rename into place. (On Unix a
    // rename can succeed over a read-only file if the dir is writable, so the
    // explicit check is what makes a read-only file a visible error.)
    // Also captures the original mode so we can preserve it on the temp file
    // below (permission bits only; ACLs and xattrs are NOT preserved — acceptable
    // for v1, matching the behavior of many editors' atomic saves).
    let orig_meta = std::fs::metadata(target).ok();
    if let Some(meta) = &orig_meta {
        if meta.permissions().readonly() {
            return Err(format!("file is read-only: {path}"));
        }
    }

    // Create the temp file with O_EXCL semantics (create_new) so a precreated
    // symlink/file sitting at our predictable temp path can never be followed or
    // truncated — the create fails and we retry with a fresh sequence number.
    let (mut file, tmp) = create_temp_excl(parent, ".kodade.tmp")?;

    let result = (|| {
        // Preserve the original file's permission bits on the temp file so the
        // atomic rename doesn't silently reset the mode (e.g. drop an exec bit).
        #[cfg(unix)]
        if let Some(meta) = &orig_meta {
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode();
            let _ = file.set_permissions(std::fs::Permissions::from_mode(mode));
        }
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        // Durability: the temp bytes must land before the rename makes them real.
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
        drop(file);
        atomic_replace(&tmp, target).map_err(|e| format!("rename to {path}: {e}"))
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp); // don't litter temp files on failure
    } else if let Ok(d) = std::fs::File::open(parent) {
        // Best-effort dir fsync so the rename survives a crash; some platforms
        // refuse to sync dirs — log and move on, the write already succeeded.
        if let Err(e) = d.sync_all() {
            eprintln!(
                "kodade: parent dir fsync failed for {}: {e}",
                parent.display()
            );
        }
    }
    result
}

// Atomically move a fully-written sibling temp file over `target`. Unix rename
// already replaces. Windows rename does not, so use ReplaceFileW for an
// existing target and MoveFileExW for the first save.
#[cfg(not(windows))]
pub(crate) fn atomic_replace(temp: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::rename(temp, target)
}

#[cfg(windows)]
pub(crate) fn atomic_replace(temp: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let target_exists = target.exists();
    let backup = target_exists
        .then(|| unused_sibling_path(target, ".kodade.backup"))
        .transpose()?;
    let temp_w = wide(temp);
    let target_w = wide(target);
    let backup_w = backup.as_deref().map(wide);
    let replaced = unsafe {
        if target_exists {
            ReplaceFileW(
                target_w.as_ptr(),
                temp_w.as_ptr(),
                backup_w
                    .as_ref()
                    .expect("existing target has backup")
                    .as_ptr(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } else {
            MoveFileExW(temp_w.as_ptr(), target_w.as_ptr(), MOVEFILE_WRITE_THROUGH)
        }
    };
    if replaced == 0 {
        let error = std::io::Error::last_os_error();
        recover_replace_failure(backup.as_deref(), target, error, |backup, target| {
            let backup = wide(backup);
            let target = wide(target);
            let restored =
                unsafe { MoveFileExW(backup.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
            if restored == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        })
    } else {
        if let Some(backup) = backup {
            let _ = std::fs::remove_file(backup);
        }
        Ok(())
    }
}

#[cfg(test)]
const ERROR_UNABLE_TO_MOVE_REPLACEMENT: i32 = 1176;
#[cfg(any(windows, test))]
const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: i32 = 1177;

#[cfg(any(windows, test))]
fn recover_replace_failure<F>(
    backup: Option<&Path>,
    target: &Path,
    error: std::io::Error,
    mut restore: F,
) -> std::io::Result<()>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    match error.raw_os_error() {
        // 1177 means ReplaceFileW moved the original to the requested backup
        // name but could not move the replacement into place. Restore it.
        Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2) => {
            let Some(backup) = backup else {
                return Err(error);
            };
            restore(backup, target).map_err(|restore_error| {
                std::io::Error::other(format!(
                        "ReplaceFileW failed ({error}); restoring {} to {} also failed ({restore_error})",
                        backup.display(),
                        target.display()
                    ))
            })?;
            Err(error)
        }
        // 1176 with a backup name, 1175, and unexpected errors all promise or
        // are treated as retaining the original names. Preserve every artifact
        // instead of attempting a restore that could move the wrong file.
        _ => Err(error),
    }
}

#[cfg(windows)]
fn unused_sibling_path(target: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    let dir = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "target has no parent")
    })?;
    for _ in 0..64 {
        let candidate = dir.join(format!(
            "{prefix}.{}.{}",
            std::process::id(),
            WRITE_TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        match std::fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!(
            "could not reserve a backup name beside {}",
            target.display()
        ),
    ))
}

// Create a fresh temp file in `dir` using create_new (O_EXCL) so we never open
// through a precreated symlink or truncate an existing file at the path. On a
// collision (name already taken), retry with the next sequence number, bounded.
pub(crate) fn create_temp_excl(
    dir: &Path,
    prefix: &str,
) -> Result<(std::fs::File, PathBuf), String> {
    for _ in 0..64 {
        let tmp = dir.join(format!(
            "{prefix}.{}.{}",
            std::process::id(),
            WRITE_TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true) // O_EXCL: fail if anything already exists at tmp
            .open(&tmp)
        {
            Ok(file) => return Ok((file, tmp)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("create {}: {e}", tmp.display())),
        }
    }
    Err(format!(
        "could not create a unique temp file in {}",
        dir.display()
    ))
}

// --- File-manager mutations (v1.1) ---
//
// These create/rename/trash/reveal on behalf of the tree's toolbar and context
// menu. Path confinement lives in the pathguard module and is applied by the
// command layer (commands.rs) BEFORE these run — these functions take an
// already-confined, canonicalized target and just do the filesystem work, so
// they stay thin and the security check has one home.

// Create an empty file at `path`. Fails if anything already exists there
// (create_new / O_EXCL) so a "new file" never clobbers an existing sibling.
pub fn create_file(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            return Err(format!("directory does not exist: {}", parent.display()));
        }
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("already exists: {}", path.display())
            }
            _ => format!("create file {}: {e}", path.display()),
        })
}

// Create a directory at `path`. Fails if it already exists (create_dir, not
// create_dir_all — the parent must already be there and we don't clobber).
pub fn create_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            return Err(format!("directory does not exist: {}", parent.display()));
        }
    }
    std::fs::create_dir(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("already exists: {}", path.display()),
        _ => format!("create dir {}: {e}", path.display()),
    })
}

// Rename (or move) `from` to `to`. Refuses to overwrite an existing target so a
// rename can't silently destroy a sibling. Both paths are already confined.
//
// Source existence is checked with symlink_metadata (not exists()) so a DANGLING
// symlink — whose referent is gone but the link itself is a real dir entry — can
// still be renamed/moved.
//
// Collision handling is race-free on macOS: renamex_np(RENAME_EXCL) fails with
// EEXIST if `to` already exists, so there is no exists()+rename TOCTOU window. On
// other unix we fall back to an advisory exists() check.
pub fn rename(from: &Path, to: &Path) -> Result<(), String> {
    // symlink_metadata succeeds for a dangling symlink (exists() would report
    // false and wrongly refuse to operate on it).
    if std::fs::symlink_metadata(from).is_err() {
        return Err(format!("no such file or directory: {}", from.display()));
    }

    // Case-only rename (e.g. Foo.txt -> foo.txt): on a case-insensitive volume
    // (default APFS) `from` and `to` are the SAME inode, so a no-replace rename
    // sees the destination as already-existing and fails with EEXIST. Detect that
    // situation up front and use a plain rename, which the OS handles as an
    // in-place case change. Only the final component may differ (by ASCII case).
    if is_case_only_rename(from, to) {
        return std::fs::rename(from, to)
            .map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()));
    }

    rename_no_replace(from, to)
}

// True when `from` and `to` share the same parent and their final components
// differ ONLY by ASCII case (so they collide on a case-insensitive volume).
#[cfg(not(windows))]
fn is_case_only_rename(from: &Path, to: &Path) -> bool {
    if from.parent() != to.parent() {
        return false;
    }
    match (from.file_name(), to.file_name()) {
        (Some(a), Some(b)) => match (a.to_str(), b.to_str()) {
            (Some(a), Some(b)) => a != b && a.eq_ignore_ascii_case(b),
            _ => false,
        },
        _ => false,
    }
}

#[cfg(windows)]
fn is_case_only_rename(from: &Path, to: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};

    fn ordinal_eq(left: &[u16], right: &[u16]) -> bool {
        left.len() <= i32::MAX as usize
            && right.len() <= i32::MAX as usize
            && unsafe {
                CompareStringOrdinal(
                    left.as_ptr(),
                    left.len() as i32,
                    right.as_ptr(),
                    right.len() as i32,
                    1,
                ) == CSTR_EQUAL
            }
    }

    let (Some(from_parent), Some(to_parent), Some(from_name), Some(to_name)) =
        (from.parent(), to.parent(), from.file_name(), to.file_name())
    else {
        return false;
    };
    let from_parent = from_parent.as_os_str().encode_wide().collect::<Vec<_>>();
    let to_parent = to_parent.as_os_str().encode_wide().collect::<Vec<_>>();
    let from_name = from_name.encode_wide().collect::<Vec<_>>();
    let to_name = to_name.encode_wide().collect::<Vec<_>>();
    ordinal_eq(&from_parent, &to_parent) && from_name != to_name && ordinal_eq(&from_name, &to_name)
}

// Rename `from` to `to`, refusing to clobber an existing `to`.
#[cfg(target_os = "macos")]
fn rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from_c = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| format!("invalid path (embedded NUL): {}", from.display()))?;
    let to_c = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| format!("invalid path (embedded NUL): {}", to.display()))?;

    // SAFETY: renamex_np is the macOS syscall wrapper for an atomic, no-replace
    // rename. Both C strings are NUL-terminated and live for the duration of the
    // call. RENAME_EXCL makes the kernel fail with EEXIST if `to` already exists,
    // giving a race-free "refuse to overwrite" with no exists()+rename TOCTOU.
    let rc = unsafe { libc::renamex_np(from_c.as_ptr(), to_c.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EEXIST) {
        return Err(format!("already exists: {}", to.display()));
    }
    Err(format!(
        "rename {} -> {}: {err}",
        from.display(),
        to.display()
    ))
}

// Non-macOS unix: no atomic no-replace primitive here, so the exists() check is
// advisory (a racing create between the check and the rename could still be
// clobbered — acceptable on the non-primary platform, documented as such).
#[cfg(all(unix, not(target_os = "macos")))]
fn rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("already exists: {}", to.display()));
    }
    std::fs::rename(from, to)
        .map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))
}

// MoveFileExW without REPLACE_EXISTING is a kernel-enforced no-clobber rename.
#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let from_w: Vec<u16> = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to_w: Vec<u16> = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let moved = unsafe { MoveFileExW(from_w.as_ptr(), to_w.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if moved != 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    if err.kind() == std::io::ErrorKind::AlreadyExists {
        return Err(format!("already exists: {}", to.display()));
    }
    Err(format!(
        "rename {} -> {}: {err}",
        from.display(),
        to.display()
    ))
}

// Move `path` to the OS trash (recoverable) rather than deleting it. Uses the
// `trash` crate, the standard cross-platform trash implementation (macOS
// NSFileManager trashItem, XDG trash on Linux, Recycle Bin on Windows) — the
// point of "delete" here is that it's undoable, which a raw remove is not.
pub fn trash(path: &Path) -> Result<(), String> {
    // symlink_metadata (not exists()) so a DANGLING symlink — a real dir entry
    // whose referent is gone — can still be trashed rather than wrongly reported
    // as missing.
    if std::fs::symlink_metadata(path).is_err() {
        return Err(format!("no such file or directory: {}", path.display()));
    }
    trash::delete(path).map_err(|e| format!("trash {}: {e}", path.display()))
}

// A running recursive watcher for one project root. Dropping it (or calling
// stop()) tears down the notify watcher and the debounce thread.
pub struct WatchHandle {
    // Held solely to keep watching alive. Taken (dropped) FIRST in shutdown:
    // that disconnects the event channel, so the debounce thread exits even
    // under a continuous event flood — join can never hang on live events.
    watcher: Option<RecommendedWatcher>,
    stop: Arc<Mutex<bool>>,
    join: Option<thread::JoinHandle<()>>,
}

impl WatchHandle {
    // Explicit stop; also runs on drop.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        *self.stop.lock().unwrap() = true;
        drop(self.watcher.take()); // disconnect the channel BEFORE joining
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        if self.join.is_some() {
            self.shutdown();
        }
    }
}

// Skip events whose path passes through an ignored directory INSIDE the
// watched root — only components below the root count, so a project that
// happens to live under an ancestor named "build" or "dist" still gets its
// events. A path that doesn't sit under the root (e.g. a prefix mismatch we
// didn't anticipate) is delivered rather than starving the tree.
fn path_is_ignored(path: &Path, root: &Path) -> bool {
    let comparable = canonical_watch_path(path);
    let comparable_root = canonical_watch_path(root);
    let Ok(rel) = comparable.strip_prefix(&comparable_root) else {
        return false;
    };
    if is_git_checkpoint_path(rel) {
        return false;
    }
    rel.components()
        .any(|c| c.as_os_str().to_str().map(is_ignored_name).unwrap_or(false))
}

fn is_git_checkpoint_path(relative: &Path) -> bool {
    let parts = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    parts.first() == Some(&".git")
        && (parts.get(1) == Some(&"HEAD")
            || parts.get(1) == Some(&"packed-refs")
            || parts.get(1) == Some(&"refs"))
}

// Watch backends may report a normal Windows path while canonicalize(root)
// carries a verbatim prefix. Canonicalize the longest existing ancestor and
// reattach any deleted suffix so both create and delete events compare against
// the same root representation.
fn canonical_watch_path(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut suffix = Vec::new();
    loop {
        if let Ok(mut canonical) = std::fs::canonicalize(existing) {
            for component in suffix.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else {
            return path.to_path_buf();
        };
        suffix.push(name.to_os_string());
        existing = parent;
    }
}

// Start watching `root` recursively. Coalesces bursts of events within a short
// debounce window and emits the union of affected paths through `sink`. The
// paths are the parent directories that need re-listing plus the changed paths
// themselves — the frontend decides what to re-list.
pub fn watch(root: &str, sink: ChangeSink) -> Result<WatchHandle, String> {
    watch_inner(root, sink, true)
}

// KödWork needs visibility into generated and otherwise tree-hidden output.
// Its bounded snapshot decides what can be previewed; the watcher must not
// silently discard a changed path just because the Files pane hides it.
pub(crate) fn watch_unfiltered(root: &str, sink: ChangeSink) -> Result<WatchHandle, String> {
    watch_inner(root, sink, false)
}

fn watch_inner(root: &str, sink: ChangeSink, filter_ignored: bool) -> Result<WatchHandle, String> {
    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| format!("watcher init: {e}"))?;
    watcher
        .watch(Path::new(root), RecursiveMode::Recursive)
        .map_err(|e| format!("watch {root}: {e}"))?;

    let stop = Arc::new(Mutex::new(false));
    let stop_thread = stop.clone();
    // Canonical root: FSEvents reports canonical paths (/private/tmp vs /tmp),
    // so the relative-ignore check must strip against the same form.
    let root_path = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));

    // Debounce thread: accumulate affected paths, flush after a quiet window.
    let join = thread::spawn(move || {
        let mut pending: HashSet<String> = HashSet::new();
        loop {
            if *stop_thread.lock().unwrap() {
                break;
            }
            // Wait for the first event (or a short poll to re-check stop).
            match rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
                Ok(res) => {
                    collect_paths(res, &mut pending, &root_path, filter_ignored);
                    // Drain any events already queued behind it, then flush.
                    drain_ready(&rx, &mut pending, &root_path, filter_ignored);
                    if !pending.is_empty() {
                        let paths: Vec<String> = pending.drain().collect();
                        sink(paths);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    // No events this window: loop back to re-check stop.
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break, // watcher dropped
            }
        }
    });

    Ok(WatchHandle {
        watcher: Some(watcher),
        stop,
        join: Some(join),
    })
}

// Pull every event already sitting in the channel (no waiting) into `pending`,
// so a burst of creates collapses into one emission.
fn drain_ready(
    rx: &std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
    pending: &mut HashSet<String>,
    root: &Path,
    filter_ignored: bool,
) {
    while let Ok(res) = rx.try_recv() {
        collect_paths(res, pending, root, filter_ignored);
    }
}

// Add the affected paths from one notify event to `pending`, skipping anything
// under an ignored directory inside the root. Emits both the changed path and
// its parent dir (the frontend re-lists parents to pick up creates/deletes).
fn collect_paths(
    res: notify::Result<notify::Event>,
    pending: &mut HashSet<String>,
    root: &Path,
    filter_ignored: bool,
) {
    let event = match res {
        Ok(e) => e,
        Err(_) => return,
    };
    for path in event.paths {
        if filter_ignored && path_is_ignored(&path, root) {
            continue;
        }
        pending.insert(path.to_string_lossy().to_string());
        if let Some(parent) = path.parent() {
            let p: PathBuf = parent.to_path_buf();
            if !filter_ignored || !path_is_ignored(&p, root) {
                pending.insert(p.to_string_lossy().to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_keeps_commit_metadata_but_still_ignores_other_git_files() {
        let root = temp_dir("git-watch-filter");
        std::fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
        for relative in [".git/HEAD", ".git/packed-refs", ".git/refs/heads/main"] {
            let path = root.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, b"commit").unwrap();
            assert!(
                !path_is_ignored(&path, &root),
                "{relative} should be observed"
            );
        }
        let config = root.join(".git/config");
        std::fs::write(&config, b"config").unwrap();
        assert!(path_is_ignored(&config, &root));
        let _ = std::fs::remove_dir_all(root);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kodade-fs-unit-{tag}-{}-{}",
            std::process::id(),
            WRITE_TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn exclusive_temps_never_reopen_or_truncate_an_existing_temp() {
        let dir = temp_dir("exclusive-temp");
        let (mut first, first_path) = create_temp_excl(&dir, "kodade.json.tmp").unwrap();
        first.write_all(b"decoy").unwrap();
        drop(first);

        let (_second, second_path) = create_temp_excl(&dir, "kodade.json.tmp").unwrap();

        assert_ne!(first_path, second_path);
        assert_eq!(std::fs::read(&first_path).unwrap(), b"decoy");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn partial_replace_failure_restores_the_original_from_its_backup() {
        let dir = temp_dir("replace-recovery");
        let target = dir.join("document.json");
        let backup = dir.join("document.backup");
        let replacement = dir.join("document.tmp");
        std::fs::write(&backup, b"original").unwrap();
        std::fs::write(&replacement, b"replacement").unwrap();
        let error = std::io::Error::from_raw_os_error(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2);

        let result = recover_replace_failure(Some(&backup), &target, error, |from, to| {
            std::fs::rename(from, to)
        });

        assert_eq!(result.unwrap_err().raw_os_error(), Some(1177));
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(std::fs::read(&replacement).unwrap(), b"replacement");
        assert!(!backup.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unable_to_rename_replacement_does_not_attempt_backup_restore() {
        let dir = temp_dir("replace-retained-names");
        let target = dir.join("document.json");
        let backup = dir.join("document.backup");
        std::fs::write(&target, b"original").unwrap();
        let mut restore_called = false;

        let result = recover_replace_failure(
            Some(&backup),
            &target,
            std::io::Error::from_raw_os_error(ERROR_UNABLE_TO_MOVE_REPLACEMENT),
            |_, _| {
                restore_called = true;
                Ok(())
            },
        );

        assert_eq!(result.unwrap_err().raw_os_error(), Some(1176));
        assert!(!restore_called);
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert!(!backup.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn non_partial_replace_failure_does_not_move_the_backup() {
        let dir = temp_dir("replace-no-recovery");
        let target = dir.join("document.json");
        let backup = dir.join("document.backup");
        std::fs::write(&target, b"original").unwrap();
        std::fs::write(&backup, b"backup").unwrap();
        let mut restore_called = false;

        let result = recover_replace_failure(
            Some(&backup),
            &target,
            std::io::Error::from_raw_os_error(1175),
            |_, _| {
                restore_called = true;
                Ok(())
            },
        );

        assert_eq!(result.unwrap_err().raw_os_error(), Some(1175));
        assert!(!restore_called);
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(std::fs::read(&backup).unwrap(), b"backup");
        let _ = std::fs::remove_dir_all(dir);
    }
}
