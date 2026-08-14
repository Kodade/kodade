// Native byte-snapshot boundary for KödWork output review. Product policy,
// risk ranking, prompts, and task state stay in TypeScript; this module only
// captures a bounded folder baseline, reports byte changes, and performs a
// verified reversible restore for non-git work.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::fs::{self, WatchHandle};

const MAX_FILES: usize = 50_000;
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_CHANGED_FILES: usize = 500;
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target"];

#[derive(Clone)]
struct SnapshotFile {
    hash: String,
    bytes: u64,
    binary: bool,
    text: Option<String>,
    backup: Option<PathBuf>,
    symlink_target: Option<PathBuf>,
    symlink_dir: bool,
}

struct LedgerRun {
    root: PathBuf,
    backup_root: PathBuf,
    baseline: HashMap<String, SnapshotFile>,
    finished: Option<Vec<KodworkNativeFile>>,
    finished_fingerprint: Option<String>,
    observed: std::sync::Arc<Mutex<BTreeSet<String>>>,
    watcher: Option<WatchHandle>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KodworkNativeFile {
    pub path: String,
    pub relative_path: String,
    pub change: String,
    pub binary: bool,
    pub before: Option<String>,
    pub after: Option<String>,
    pub adds: usize,
    pub dels: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KodworkNativeReview {
    pub kind: String,
    pub files: Vec<KodworkNativeFile>,
    pub fingerprint: String,
}

#[derive(Default)]
pub struct KodworkLedgerManager {
    runs: Mutex<HashMap<String, LedgerRun>>,
}

impl KodworkLedgerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(&self, app_data: &Path, task_id: &str, root: &str) -> Result<(), String> {
        validate_task_id(task_id)?;
        let root = std::fs::canonicalize(root).map_err(|e| format!("open task folder: {e}"))?;
        if !root.is_dir() {
            return Err("task folder is not a directory".into());
        }
        {
            let mut runs = self.runs.lock().unwrap();
            if let Some(run) = runs.get_mut(task_id) {
                if run.root != root {
                    return Err("cannot resume a KödWork ledger in a different folder".into());
                }
                if run.finished.is_none() || run.watcher.is_some() {
                    return Err("KödWork ledger is already active".into());
                }
                run.finished = None;
                run.finished_fingerprint = None;
                let observed = run.observed.clone();
                run.watcher = Some(fs::watch_unfiltered(
                    root.to_string_lossy().as_ref(),
                    std::sync::Arc::new(move |paths| {
                        observed.lock().unwrap().extend(paths);
                    }),
                )?);
                return Ok(());
            }
        }
        let ledger_root = app_data.join("kodwork-ledgers");
        std::fs::create_dir_all(&ledger_root)
            .map_err(|e| format!("create KödWork ledger directory: {e}"))?;
        // Keep the existing, recognizable backup convention while placing the
        // snapshot outside the user's task folder.
        let backup_root = ledger_root.join(format!("{task_id}.kodade-bak-current"));
        let baseline = if backup_root.exists() {
            let mut recovered = scan_tree(&backup_root, None)?;
            for (relative, snapshot) in &mut recovered {
                if snapshot.symlink_target.is_none() {
                    snapshot.backup = Some(backup_root.join(relative_path(relative)));
                }
            }
            recovered
        } else {
            std::fs::create_dir_all(&backup_root)
                .map_err(|e| format!("create KödWork snapshot: {e}"))?;
            scan_tree(&root, Some(&backup_root))?
        };
        // Reuse the application's recursive fs watcher for the exact run
        // window. The final bounded scan is authoritative (it also catches
        // short-lived/coalesced events), while the handle fixes ownership and
        // teardown to this task rather than the active file-tree project.
        let observed = std::sync::Arc::new(Mutex::new(BTreeSet::new()));
        let observed_sink = observed.clone();
        let watcher = fs::watch_unfiltered(
            root.to_string_lossy().as_ref(),
            std::sync::Arc::new(move |paths| {
                observed_sink.lock().unwrap().extend(paths);
            }),
        )?;
        self.runs.lock().unwrap().insert(
            task_id.to_string(),
            LedgerRun {
                root,
                backup_root,
                baseline,
                finished: None,
                finished_fingerprint: None,
                observed,
                watcher: Some(watcher),
            },
        );
        Ok(())
    }

    pub fn finish(&self, task_id: &str) -> Result<KodworkNativeReview, String> {
        validate_task_id(task_id)?;
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(task_id)
            .ok_or_else(|| "KödWork ledger is not active".to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(200));
        if let Some(watcher) = run.watcher.take() {
            watcher.stop();
        }
        let current = scan_tree(&run.root, None)?;
        let mut paths = BTreeSet::new();
        paths.extend(run.baseline.keys().cloned());
        paths.extend(current.keys().cloned());
        let mut files = Vec::new();
        for relative in paths {
            let before = run.baseline.get(&relative);
            let after = current.get(&relative);
            let change = match (before, after) {
                (None, Some(_)) => "added",
                (Some(_), None) => "deleted",
                (Some(left), Some(right)) if left.hash != right.hash => "modified",
                _ => continue,
            };
            if files.len() >= MAX_CHANGED_FILES {
                return Err(format!(
                    "task changed more than {MAX_CHANGED_FILES} files; review is blocked"
                ));
            }
            let before_lines = before
                .and_then(|file| file.text.as_deref())
                .map(line_count)
                .unwrap_or(0);
            let after_lines = after
                .and_then(|file| file.text.as_deref())
                .map(line_count)
                .unwrap_or(0);
            files.push(KodworkNativeFile {
                path: run
                    .root
                    .join(relative_path(&relative))
                    .to_string_lossy()
                    .to_string(),
                relative_path: relative,
                change: change.into(),
                binary: before.is_some_and(|file| file.binary)
                    || after.is_some_and(|file| file.binary),
                before: before.and_then(|file| file.text.clone()),
                after: after.and_then(|file| file.text.clone()),
                adds: after_lines.saturating_sub(before_lines),
                dels: before_lines.saturating_sub(after_lines),
            });
        }
        let observed_only = observed_ignored_paths(run, &current);
        for (relative, path) in &observed_only {
            if files.len() >= MAX_CHANGED_FILES {
                return Err(format!(
                    "task changed more than {MAX_CHANGED_FILES} files; review is blocked"
                ));
            }
            files.push(KodworkNativeFile {
                path: path.to_string_lossy().to_string(),
                relative_path: relative.clone(),
                change: "modified".into(),
                binary: true,
                before: None,
                after: None,
                adds: 0,
                dels: 0,
            });
        }
        let fingerprint = fingerprint_against_baseline(run, &current, &observed_only);
        let kind = if run.root.join(".git").exists() {
            "git"
        } else {
            "folder"
        };
        run.finished = Some(files.clone());
        run.finished_fingerprint = Some(fingerprint.clone());
        Ok(KodworkNativeReview {
            kind: kind.into(),
            files,
            fingerprint,
        })
    }

    pub fn accept(&self, task_id: &str) -> Result<(), String> {
        validate_task_id(task_id)?;
        let run = self
            .runs
            .lock()
            .unwrap()
            .remove(task_id)
            .ok_or_else(|| "KödWork ledger is not active".to_string())?;
        remove_snapshot(&run.backup_root)
    }

    pub fn restore(&self, app_data: &Path, task_id: &str) -> Result<(), String> {
        validate_task_id(task_id)?;
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get(task_id)
            .ok_or_else(|| "KödWork ledger is not active".to_string())?;
        if run.root.join(".git").exists() {
            return Err("git task output must be restored through git review".into());
        }
        let changed = run
            .finished
            .as_ref()
            .ok_or_else(|| "KödWork review has not been collected".to_string())?
            .clone();
        let current = scan_tree(&run.root, None)?;
        let observed_only = observed_ignored_paths(run, &current);
        let current_fingerprint = fingerprint_against_baseline(run, &current, &observed_only);
        if run.finished_fingerprint.as_deref() != Some(current_fingerprint.as_str()) {
            return Err(
                "task output changed after review; collect a fresh review before restoring".into(),
            );
        }
        let rollback_root = app_data
            .join("kodwork-ledgers")
            .join(format!("{task_id}-restore-rollback"));
        if rollback_root.exists() {
            std::fs::remove_dir_all(&rollback_root)
                .map_err(|e| format!("replace restore rollback: {e}"))?;
        }
        std::fs::create_dir_all(&rollback_root)
            .map_err(|e| format!("create restore rollback: {e}"))?;
        let rollback = capture_paths(&run.root, &rollback_root, &changed)?;

        if let Err(reason) = apply_baseline(run, &changed) {
            let rollback_result = restore_captured(&run.root, &rollback, &changed);
            let _ = std::fs::remove_dir_all(&rollback_root);
            return match rollback_result {
                Ok(()) => Err(format!(
                    "restore apply failed: {reason}; original task output was restored"
                )),
                Err(rollback_error) => Err(format!(
                    "restore apply failed: {reason}; rollback also failed: {rollback_error}"
                )),
            };
        }
        if let Err(reason) = verify_baseline(run, &changed) {
            restore_captured(&run.root, &rollback, &changed)?;
            let _ = std::fs::remove_dir_all(&rollback_root);
            return Err(format!(
                "restore verification failed: {reason}; original task output was restored"
            ));
        }
        let backup_root = run.backup_root.clone();
        runs.remove(task_id);
        remove_snapshot(&backup_root)?;
        let _ = std::fs::remove_dir_all(&rollback_root);
        Ok(())
    }
}

fn fingerprint_against_baseline(
    run: &LedgerRun,
    current: &HashMap<String, SnapshotFile>,
    observed_only: &[(String, PathBuf)],
) -> String {
    let mut paths = BTreeSet::new();
    paths.extend(run.baseline.keys().cloned());
    paths.extend(current.keys().cloned());
    let mut fingerprint = Sha256::new();
    for relative in paths {
        let before = run.baseline.get(&relative);
        let after = current.get(&relative);
        let change = match (before, after) {
            (None, Some(_)) => "added",
            (Some(_), None) => "deleted",
            (Some(left), Some(right)) if left.hash != right.hash => "modified",
            _ => continue,
        };
        fingerprint.update(relative.as_bytes());
        fingerprint.update([0]);
        fingerprint.update(change.as_bytes());
        fingerprint.update([0]);
        if let Some(snapshot) = after {
            fingerprint.update(snapshot.hash.as_bytes());
        }
    }
    for (relative, path) in observed_only {
        fingerprint.update(relative.as_bytes());
        fingerprint.update([0]);
        fingerprint.update(b"observed");
        fingerprint.update([0]);
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            fingerprint.update(meta.len().to_le_bytes());
            if let Ok(modified) = meta.modified() {
                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                    fingerprint.update(duration.as_nanos().to_le_bytes());
                }
            }
        }
    }
    format!("{:x}", fingerprint.finalize())
}

fn observed_ignored_paths(
    run: &LedgerRun,
    current: &HashMap<String, SnapshotFile>,
) -> Vec<(String, PathBuf)> {
    let observed = run.observed.lock().unwrap();
    observed
        .iter()
        .filter_map(|raw| {
            let path = PathBuf::from(raw);
            let relative = path.strip_prefix(&run.root).ok()?;
            let relative_text = portable_relative(relative);
            if current.contains_key(&relative_text) || run.baseline.contains_key(&relative_text) {
                return None;
            }
            if !relative.components().any(|component| {
                component
                    .as_os_str()
                    .to_str()
                    .is_some_and(|name| IGNORED_DIRS.contains(&name))
            }) {
                return None;
            }
            if std::fs::symlink_metadata(&path)
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
            {
                return None;
            }
            Some((relative_text, path))
        })
        .collect()
}

fn validate_task_id(task_id: &str) -> Result<(), String> {
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid KödWork task id".into());
    }
    Ok(())
}

fn scan_tree(
    root: &Path,
    backup_root: Option<&Path>,
) -> Result<HashMap<String, SnapshotFile>, String> {
    let mut files = HashMap::new();
    let mut total = 0_u64;
    let ignore_heavy = root.join(".git").exists();
    let enforce_symlink_confinement = !root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".kodade-bak-current"));
    scan_dir(
        root,
        root,
        backup_root,
        &mut files,
        &mut total,
        ignore_heavy,
        enforce_symlink_confinement,
    )?;
    Ok(files)
}

fn scan_dir(
    root: &Path,
    dir: &Path,
    backup_root: Option<&Path>,
    files: &mut HashMap<String, SnapshotFile>,
    total: &mut u64,
    ignore_heavy: bool,
    enforce_symlink_confinement: bool,
) -> Result<(), String> {
    for item in std::fs::read_dir(dir).map_err(|e| format!("scan {}: {e}", dir.display()))? {
        let item = item.map_err(|e| format!("scan {}: {e}", dir.display()))?;
        let path = item.path();
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("stat {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            if enforce_symlink_confinement {
                let resolved = std::fs::canonicalize(&path).map_err(|_| {
                    format!(
                        "task folder contains an unresolved symlink: {}",
                        path.display()
                    )
                })?;
                if !resolved.starts_with(root) {
                    return Err(format!(
                        "task folder symlink escapes its root: {}",
                        path.display()
                    ));
                }
            }
            if files.len() >= MAX_FILES {
                return Err(format!(
                    "task folder exceeds the {MAX_FILES}-file ledger limit"
                ));
            }
            let relative_path = path
                .strip_prefix(root)
                .map_err(|_| "task symlink escaped its root".to_string())?;
            let relative = portable_relative(relative_path);
            let link_target = std::fs::read_link(&path)
                .map_err(|e| format!("read symlink {}: {e}", path.display()))?;
            let symlink_dir = path.is_dir();
            let backup = if let Some(backup_root) = backup_root {
                let target = backup_root.join(relative_path);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("create snapshot directory: {e}"))?;
                }
                create_symlink(&link_target, &target, symlink_dir)?;
                Some(target)
            } else {
                None
            };
            files.insert(
                relative,
                SnapshotFile {
                    hash: hash(link_target.to_string_lossy().as_bytes()),
                    bytes: 0,
                    binary: true,
                    text: None,
                    backup,
                    symlink_target: Some(link_target),
                    symlink_dir,
                },
            );
            continue;
        }
        if meta.is_dir() {
            let name = item.file_name();
            if ignore_heavy
                && name
                    .to_str()
                    .is_some_and(|name| IGNORED_DIRS.contains(&name))
            {
                continue;
            }
            scan_dir(
                root,
                &path,
                backup_root,
                files,
                total,
                ignore_heavy,
                enforce_symlink_confinement,
            )?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        if files.len() >= MAX_FILES {
            return Err(format!(
                "task folder exceeds the {MAX_FILES}-file ledger limit"
            ));
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(format!(
                "{} exceeds the {} MiB per-file ledger limit",
                path.display(),
                MAX_FILE_BYTES / 1024 / 1024
            ));
        }
        *total = total.saturating_add(meta.len());
        if *total > MAX_TOTAL_BYTES {
            return Err("task folder exceeds the 4 GiB ledger limit".into());
        }
        let bytes =
            std::fs::read(&path).map_err(|e| format!("read task input {}: {e}", path.display()))?;
        let relative_path = path
            .strip_prefix(root)
            .map_err(|_| "task file escaped its root".to_string())?;
        let relative = portable_relative(relative_path);
        let backup = if let Some(backup_root) = backup_root {
            let target = backup_root.join(relative_path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create snapshot directory: {e}"))?;
            }
            std::fs::write(&target, &bytes)
                .map_err(|e| format!("write task snapshot {}: {e}", target.display()))?;
            Some(target)
        } else {
            None
        };
        let binary = bytes.len() > MAX_TEXT_BYTES
            || bytes.contains(&0)
            || std::str::from_utf8(&bytes).is_err();
        let text = (!binary).then(|| String::from_utf8(bytes.clone()).unwrap());
        files.insert(
            relative,
            SnapshotFile {
                hash: hash(&bytes),
                bytes: meta.len(),
                binary,
                text,
                backup,
                symlink_target: None,
                symlink_dir: false,
            },
        );
    }
    Ok(())
}

fn capture_paths(
    root: &Path,
    backup_root: &Path,
    changed: &[KodworkNativeFile],
) -> Result<HashMap<String, SnapshotFile>, String> {
    let all = scan_tree(root, None)?;
    let mut captured = HashMap::new();
    for file in changed {
        let Some(snapshot) = all.get(&file.relative_path) else {
            continue;
        };
        let source = root.join(relative_path(&file.relative_path));
        let target = backup_root.join(relative_path(&file.relative_path));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create rollback directory: {e}"))?;
        }
        if let Some(link_target) = &snapshot.symlink_target {
            create_symlink(link_target, &target, snapshot.symlink_dir)?;
        } else {
            std::fs::copy(&source, &target)
                .map_err(|e| format!("capture restore rollback {}: {e}", source.display()))?;
        }
        let mut snapshot = snapshot.clone();
        snapshot.backup = Some(target);
        captured.insert(file.relative_path.clone(), snapshot);
    }
    Ok(captured)
}

fn apply_baseline(run: &LedgerRun, changed: &[KodworkNativeFile]) -> Result<(), String> {
    for file in changed {
        let target = run.root.join(relative_path(&file.relative_path));
        if let Some(before) = run.baseline.get(&file.relative_path) {
            replace_with_snapshot(&target, before)?;
        } else {
            remove_entry(&target)?;
        }
    }
    Ok(())
}

fn verify_baseline(run: &LedgerRun, changed: &[KodworkNativeFile]) -> Result<(), String> {
    for file in changed {
        let target = run.root.join(relative_path(&file.relative_path));
        match run.baseline.get(&file.relative_path) {
            Some(before) => {
                if let Some(link_target) = &before.symlink_target {
                    let restored = std::fs::read_link(&target).map_err(|e| {
                        format!("verify restored symlink {}: {e}", target.display())
                    })?;
                    if &restored != link_target {
                        return Err(format!(
                            "{} does not match its baseline symlink",
                            target.display()
                        ));
                    }
                } else {
                    let meta = std::fs::symlink_metadata(&target)
                        .map_err(|e| format!("verify restored {}: {e}", target.display()))?;
                    if meta.file_type().is_symlink() {
                        return Err(format!("{} restored as a symlink", target.display()));
                    }
                    let bytes = std::fs::read(&target)
                        .map_err(|e| format!("verify restored {}: {e}", target.display()))?;
                    if hash(&bytes) != before.hash || bytes.len() as u64 != before.bytes {
                        return Err(format!("{} does not match its baseline", target.display()));
                    }
                }
            }
            None if std::fs::symlink_metadata(&target).is_ok() => {
                return Err(format!("new file still exists: {}", target.display()));
            }
            None => {}
        }
    }
    Ok(())
}

fn restore_captured(
    root: &Path,
    rollback: &HashMap<String, SnapshotFile>,
    changed: &[KodworkNativeFile],
) -> Result<(), String> {
    for file in changed {
        let target = root.join(relative_path(&file.relative_path));
        if let Some(current) = rollback.get(&file.relative_path) {
            replace_with_snapshot(&target, current)?;
        } else {
            remove_entry(&target)?;
        }
    }
    Ok(())
}

fn replace_with_snapshot(target: &Path, snapshot: &SnapshotFile) -> Result<(), String> {
    remove_entry(target)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("restore parent directory: {e}"))?;
    }
    if let Some(link_target) = &snapshot.symlink_target {
        return create_symlink(link_target, target, snapshot.symlink_dir);
    }
    let source = snapshot
        .backup
        .as_ref()
        .ok_or_else(|| "snapshot backup is missing".to_string())?;
    std::fs::copy(source, target)
        .map(|_| ())
        .map_err(|e| format!("restore {}: {e}", target.display()))
}

fn remove_entry(path: &Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "inspect restore target {}: {error}",
                path.display()
            ))
        }
    };
    if meta.file_type().is_symlink() || meta.is_file() {
        std::fs::remove_file(path)
            .map_err(|e| format!("remove restore target {}: {e}", path.display()))
    } else if meta.is_dir() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("remove restore directory {}: {e}", path.display()))
    } else {
        Err(format!("unsupported restore target: {}", path.display()))
    }
}

#[cfg(unix)]
fn create_symlink(source: &Path, target: &Path, _is_dir: bool) -> Result<(), String> {
    std::os::unix::fs::symlink(source, target)
        .map_err(|e| format!("create symlink {}: {e}", target.display()))
}

#[cfg(windows)]
fn create_symlink(source: &Path, target: &Path, is_dir: bool) -> Result<(), String> {
    let result = if is_dir {
        std::os::windows::fs::symlink_dir(source, target)
    } else {
        std::os::windows::fs::symlink_file(source, target)
    };
    result.map_err(|e| format!("create symlink {}: {e}", target.display()))
}

fn remove_snapshot(path: &Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_dir_all(path).map_err(|e| format!("remove KödWork snapshot: {e}"))?;
    }
    Ok(())
}

fn relative_path(value: &str) -> PathBuf {
    value.split('/').collect()
}

fn portable_relative(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.lines().count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_and_restores_modified_added_and_deleted_files() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("keep.txt"), "before\n").unwrap();
        std::fs::write(root.path().join("delete.txt"), "gone\n").unwrap();
        let manager = KodworkLedgerManager::new();
        manager
            .begin(data.path(), "task-1", root.path().to_str().unwrap())
            .unwrap();

        std::fs::write(root.path().join("keep.txt"), "after\n").unwrap();
        std::fs::write(root.path().join("new.txt"), "new\n").unwrap();
        std::fs::remove_file(root.path().join("delete.txt")).unwrap();
        let review = manager.finish("task-1").unwrap();
        assert_eq!(review.kind, "folder");
        assert_eq!(review.files.len(), 3);
        assert!(review.files.iter().any(|file| file.change == "deleted"));

        manager.restore(data.path(), "task-1").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("keep.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("delete.txt")).unwrap(),
            "gone\n"
        );
        assert!(!root.path().join("new.txt").exists());
    }

    #[test]
    fn rejects_task_ids_that_could_escape_the_snapshot_root() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let manager = KodworkLedgerManager::new();
        assert!(manager
            .begin(data.path(), "../escape", root.path().to_str().unwrap())
            .is_err());
    }

    #[test]
    fn rejected_resume_keeps_the_original_baseline() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file.txt"), "original").unwrap();
        let manager = KodworkLedgerManager::new();
        manager
            .begin(data.path(), "task-2", root.path().to_str().unwrap())
            .unwrap();
        std::fs::write(root.path().join("file.txt"), "rejected").unwrap();
        assert_eq!(manager.finish("task-2").unwrap().files.len(), 1);

        manager
            .begin(data.path(), "task-2", root.path().to_str().unwrap())
            .unwrap();
        let second = manager.finish("task-2").unwrap();
        assert_eq!(second.files.len(), 1);
        assert_eq!(second.files[0].before.as_deref(), Some("original"));
        assert_eq!(second.files[0].after.as_deref(), Some("rejected"));
        manager.restore(data.path(), "task-2").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("file.txt")).unwrap(),
            "original"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_changes_are_reviewed_and_restore_never_follows_the_destination() {
        use std::os::unix::fs::symlink;

        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let link_target = root.path().join("target.txt");
        std::fs::write(&link_target, "target").unwrap();
        std::fs::write(root.path().join("file.txt"), "inside").unwrap();
        let manager = KodworkLedgerManager::new();
        manager
            .begin(data.path(), "task-3", root.path().to_str().unwrap())
            .unwrap();

        std::fs::remove_file(root.path().join("file.txt")).unwrap();
        symlink(&link_target, root.path().join("file.txt")).unwrap();
        symlink(&link_target, root.path().join("added-link")).unwrap();
        let review = manager.finish("task-3").unwrap();
        assert_eq!(review.files.len(), 2);
        assert!(review.files.iter().all(|file| file.binary));

        manager.restore(data.path(), "task-3").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("file.txt")).unwrap(),
            "inside"
        );
        assert!(!root.path().join("added-link").exists());
        assert_eq!(std::fs::read_to_string(&link_target).unwrap(), "target");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_that_escape_the_task_root_block_review() {
        use std::os::unix::fs::symlink;

        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let manager = KodworkLedgerManager::new();
        manager
            .begin(data.path(), "task-escape", root.path().to_str().unwrap())
            .unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();

        assert!(manager.finish("task-escape").is_err());
        assert_eq!(std::fs::read_to_string(outside.path()).unwrap(), "");
    }

    #[test]
    fn restore_refuses_to_overwrite_changes_made_after_review() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file.txt"), "before").unwrap();
        let manager = KodworkLedgerManager::new();
        manager
            .begin(data.path(), "task-4", root.path().to_str().unwrap())
            .unwrap();
        std::fs::write(root.path().join("file.txt"), "agent").unwrap();
        manager.finish("task-4").unwrap();
        std::fs::write(root.path().join("file.txt"), "human").unwrap();

        assert!(manager.restore(data.path(), "task-4").is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("file.txt")).unwrap(),
            "human"
        );
    }

    #[test]
    fn git_tasks_surface_changes_inside_tree_hidden_directories() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::create_dir(root.path().join("node_modules")).unwrap();
        let manager = KodworkLedgerManager::new();
        manager
            .begin(data.path(), "task-5", root.path().to_str().unwrap())
            .unwrap();
        std::fs::write(root.path().join("node_modules/generated.js"), "changed").unwrap();

        let review = manager.finish("task-5").unwrap();
        assert!(review
            .files
            .iter()
            .any(|file| file.relative_path == "node_modules/generated.js"));
    }
}
