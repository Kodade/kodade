// Thin config-directory scanner for KödHarness. Like fs.rs, all product logic
// (what an entry MEANS — skill vs subagent, enabled vs disabled) lives in the
// TypeScript scan engine; this module only enumerates one directory level, does
// a one-level recurse into subdirectories (so a skill dir's SKILL.md is
// visible), and resolves symlinks into a via/target/orphan report per entry.
//
// Confinement is applied by the command layer (commands.rs) through configguard
// BEFORE these run, so `scan_dir` takes an already-authorized canonical path.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::configguard::BACKUP_INFIX;

// One directory entry. camelCase matches the ConfigDirEntry in the TS IPC
// contract. A healthy symlink carries its canonical `target`; an orphan has no
// resolved target and sets `orphaned`. `children` is the one-level recurse
// (populated for directories, None for leaves and for the children themselves).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub target: Option<String>,
    pub orphaned: bool,
    pub children: Option<Vec<ConfigEntry>>,
}

// Result of scanning one location. Tagged `status` to mirror the TS ConfigScan
// union. `missing` is a normal empty state (the dir isn't there); `unreadable`
// carries the reason (guard rejection or a read failure).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConfigScan {
    Listing {
        root: String,
        root_is_symlink: bool,
        entries: Vec<ConfigEntry>,
    },
    Missing {
        root: String,
    },
    Unreadable {
        root: String,
        root_is_symlink: bool,
        error: String,
    },
}

// Resolve one path into (is_dir, is_symlink, target, orphaned). metadata()
// follows symlinks, so an Err on a symlink means the target is gone (orphaned);
// symlink_metadata() detects the link itself without following it.
fn probe(path: &Path) -> (bool, bool, Option<String>, bool) {
    let is_symlink = std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let target = if is_symlink {
        std::fs::canonicalize(path)
            .ok()
            .map(|t| t.to_string_lossy().to_string())
    } else {
        None
    };
    match std::fs::metadata(path) {
        Ok(meta) => (meta.is_dir(), is_symlink, target, false),
        // Only a symlink can be "orphaned"; a plain entry that fails to stat is
        // just treated as a non-dir leaf.
        Err(_) => (false, is_symlink, target, is_symlink),
    }
}

fn entry_for(path: &Path, name: String, recurse: bool) -> ConfigEntry {
    let (is_dir, is_symlink, target, orphaned) = probe(path);
    // Recurse one level into a directory so its manifest (SKILL.md) is visible.
    // The children themselves never recurse, keeping the scan shallow and cheap.
    let children = if is_dir && recurse {
        list_level(path)
    } else {
        None
    };
    ConfigEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
        is_symlink,
        target,
        orphaned,
        children,
    }
}

// List one directory level (name-sorted, case-insensitive) without recursing.
// Returns None when the directory can't be read (used for a symlinked dir whose
// target vanished mid-scan — the parent entry still surfaces).
fn list_level(dir: &Path) -> Option<Vec<ConfigEntry>> {
    let read = std::fs::read_dir(dir).ok()?;
    let mut entries: Vec<ConfigEntry> = read
        .flatten()
        .map(|item| {
            entry_for(
                &item.path(),
                item.file_name().to_string_lossy().to_string(),
                false,
            )
        })
        .collect();
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Some(entries)
}

// Scan one already-authorized config directory: a shallow listing with a
// one-level recurse into each subdirectory. Errors (permission denied) return
// Err so the command maps them to ConfigScan::Unreadable.
pub fn scan_dir(dir: &Path) -> Result<Vec<ConfigEntry>, String> {
    let read = std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    let mut entries: Vec<ConfigEntry> = read
        .flatten()
        .map(|item| {
            entry_for(
                &item.path(),
                item.file_name().to_string_lossy().to_string(),
                true,
            )
        })
        .collect();
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(entries)
}

// --- Mutating writes (M10d) ---
//
// Every function here takes an ALREADY-AUTHORIZED path (commands.rs runs
// configguard first). Writes are atomic (temp file + rename, never truncate),
// reusing fs.rs's exclusive-temp + atomic-replace primitives so a failed write
// can never corrupt the existing file.

// SHA-256 of `bytes` as lowercase hex — the optimistic-concurrency fingerprint
// config_write compares against the caller's `expected_hash`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

pub fn remove_config(target: &Path, expected_hash: &str) -> Result<(), String> {
    let current =
        std::fs::read(target).map_err(|error| format!("read config for removal: {error}"))?;
    let actual = sha256_hex(&current);
    if actual != expected_hash {
        return Err("config changed since apply; refusing rollback removal".into());
    }
    assert_writable(target)?;
    std::fs::remove_file(target).map_err(|error| format!("remove config: {error}"))
}

// Atomically write `bytes` to `target`: a uniquely-named exclusive temp in the
// target's directory, fsync'd, then renamed over the target. Mirrors
// fs::write_file's durability, at the byte level so backups are exact copies.
fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("no parent directory for {}", target.display()))?;
    if !parent.is_dir() {
        return Err(format!("directory does not exist: {}", parent.display()));
    }
    let (mut file, tmp) = crate::fs::create_temp_excl(parent, ".kodade.tmp")?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
        drop(file);
        crate::fs::atomic_replace(&tmp, target)
            .map_err(|e| format!("rename to {}: {e}", target.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// M10g: fail up front with a clear error when `path` exists and is read-only,
// rather than writing a backup (or reading one for restore) only to discover
// the actual replace is silently a no-op or — worse — quietly succeeds
// because a Unix rename doesn't check the TARGET file's own permission bits,
// only its directory's. Mirrors fs::write_file's identical guard for the
// general editor path; config.rs needed its own copy since a config write's
// backup step happens before the final replace and must never run at all if
// the write is doomed (no orphan backup left behind for a write that was
// always going to fail).
fn assert_writable(path: &Path) -> Result<(), String> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.permissions().readonly() {
            return Err(format!("file is read-only: {}", path.display()));
        }
    }
    Ok(())
}

// The timestamped backup sibling for `canonical` (e.g.
// `CLAUDE.md.kodade-bak-2026-07-14T12-30-00-000Z`). Colons are illegal in
// Windows filenames, so the ISO time uses dashes throughout.
fn backup_path_for(canonical: &Path, now: SystemTime) -> PathBuf {
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("config");
    let sibling = format!("{name}{BACKUP_INFIX}{}", iso_timestamp(now));
    match canonical.parent() {
        Some(parent) => parent.join(sibling),
        None => PathBuf::from(sibling),
    }
}

// Atomic write with optimistic concurrency (M10e/instruction editing consumes
// this; the skills rename path does NOT). `expected_hash` is the SHA-256 the
// caller computed from the bytes it last read: a mismatch means the file changed
// under the editor, so we reject rather than clobber. The prior bytes are backed
// up to a timestamped sibling first. A brand-new file (first save) passes an
// empty `expected_hash` and gets no backup. Returns the backup path ("" if new).
pub fn write_config(
    canonical: &Path,
    contents: &str,
    expected_hash: &str,
    now: SystemTime,
) -> Result<String, String> {
    let backup = if canonical.exists() {
        assert_writable(canonical)?;
        let prior =
            std::fs::read(canonical).map_err(|e| format!("read {}: {e}", canonical.display()))?;
        let actual = sha256_hex(&prior);
        if actual != expected_hash {
            return Err(format!(
                "config changed on disk since it was read (expected {expected_hash}, found {actual})"
            ));
        }
        let backup_path = backup_path_for(canonical, now);
        atomic_write_bytes(&backup_path, &prior)?;
        backup_path.to_string_lossy().to_string()
    } else {
        if !expected_hash.is_empty() {
            return Err(format!(
                "expected an existing file matching {expected_hash}, but {} does not exist",
                canonical.display()
            ));
        }
        String::new()
    };
    atomic_write_bytes(canonical, contents.as_bytes())?;
    Ok(backup)
}

// Copy `canonical`'s current bytes to a timestamped `.kodade-bak` sibling and
// return its path — the explicit backup step of the receipt/restore flow.
pub fn backup_config(canonical: &Path, now: SystemTime) -> Result<String, String> {
    let bytes =
        std::fs::read(canonical).map_err(|e| format!("read {}: {e}", canonical.display()))?;
    let backup_path = backup_path_for(canonical, now);
    atomic_write_bytes(&backup_path, &bytes)?;
    Ok(backup_path.to_string_lossy().to_string())
}

// Atomically restore `target` from `backup`'s bytes. Both are pre-authorized
// (target as a WriteFile, backup as a ReadBackup) by the command layer.
pub fn restore_config(target: &Path, backup: &Path) -> Result<(), String> {
    if target.exists() {
        assert_writable(target)?;
    }
    let bytes =
        std::fs::read(backup).map_err(|e| format!("read backup {}: {e}", backup.display()))?;
    atomic_write_bytes(target, &bytes)
}

// --- KödSkills directory resources and reversible mutations (M15) ---

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileHash {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInstallFile {
    pub path: String,
    pub sha256: String,
    pub contents: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConfigDirSnapshot {
    Missing {
        path: String,
    },
    Snapshot {
        path: String,
        files: Vec<ConfigFileHash>,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KodSkillsPackFile {
    pub path: String,
    pub contents: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KodSkillsPackBundle {
    pub manifest: String,
    pub files: Vec<KodSkillsPackFile>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillSourceBundle {
    pub root: String,
    pub files: Vec<KodSkillsPackFile>,
}

const MAX_PROJECT_SKILL_SOURCE_FILES: usize = 256;
const MAX_PROJECT_SKILL_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const PROJECT_SKILL_IGNORED_FILES: &[&str] =
    &[".DS_Store", ".kodade-skill.json", ".kodskills.json"];

fn portable_relative(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| format!("relative project skill path {}: {error}", path.display()))?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(format!(
                "project skill path is not portable: {}",
                path.display()
            ));
        };
        let value = part
            .to_str()
            .ok_or_else(|| format!("project skill path is not UTF-8: {}", path.display()))?;
        parts.push(value);
    }
    Ok(parts.join("/"))
}

fn walk_project_skill_source(
    root: &Path,
    current: &Path,
    files: &mut Vec<KodSkillsPackFile>,
    total_bytes: &mut usize,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(current)
        .map_err(|error| format!("read selected skill folder {}: {error}", current.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read selected skill folder {}: {error}", current.display()))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect selected skill file {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "selected skill folder contains a symlink: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            walk_project_skill_source(root, &path, files, total_bytes)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(format!(
                "selected skill folder contains an unsupported entry: {}",
                path.display()
            ));
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if PROJECT_SKILL_IGNORED_FILES.contains(&name) {
            continue;
        }
        if files.len() >= MAX_PROJECT_SKILL_SOURCE_FILES {
            return Err(format!(
                "selected skill folder exceeds {MAX_PROJECT_SKILL_SOURCE_FILES} files"
            ));
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("read selected skill file {}: {error}", path.display()))?;
        *total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| "selected skill folder is too large".to_string())?;
        if *total_bytes > MAX_PROJECT_SKILL_SOURCE_BYTES {
            return Err(format!(
                "selected skill folder exceeds {} bytes",
                MAX_PROJECT_SKILL_SOURCE_BYTES
            ));
        }
        let contents = String::from_utf8(bytes)
            .map_err(|_| format!("project skill files must be UTF-8 text: {}", path.display()))?;
        files.push(KodSkillsPackFile {
            path: portable_relative(root, &path)?,
            contents,
        });
    }
    Ok(())
}

pub fn read_project_skill_source(path: &Path) -> Result<ProjectSkillSourceBundle, String> {
    let root = std::fs::canonicalize(path)
        .map_err(|error| format!("selected skill folder is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err(format!(
            "selected project skill is not a folder: {}",
            root.display()
        ));
    }
    let mut files = Vec::new();
    let mut total_bytes = 0usize;
    walk_project_skill_source(&root, &root, &mut files, &mut total_bytes)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if !files.iter().any(|file| file.path == "SKILL.md") {
        return Err("selected folder must contain SKILL.md at its root".to_string());
    }
    Ok(ProjectSkillSourceBundle {
        root: root.to_string_lossy().to_string(),
        files,
    })
}

fn safe_relative(path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if relative.is_absolute() || path.is_empty() || path.contains('\\') {
        return Err(format!(
            "skill file path must be a portable relative path: {path}"
        ));
    }
    if !relative
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "skill file path contains an invalid component: {path}"
        ));
    }
    Ok(relative.to_path_buf())
}

fn walk_hashed(root: &Path, current: &Path, files: &mut Vec<ConfigFileHash>) -> Result<(), String> {
    let mut entries = std::fs::read_dir(current)
        .map_err(|error| format!("read_dir {}: {error}", current.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read_dir {}: {error}", current.display()))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("metadata {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "skill directory contains a symlink: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            walk_hashed(root, &path, files)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| format!("relative path {}: {error}", path.display()))?
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = std::fs::read(&path)
                .map_err(|error| format!("read {}: {error}", path.display()))?;
            files.push(ConfigFileHash {
                path: relative,
                sha256: sha256_hex(&bytes),
            });
        }
    }
    Ok(())
}

pub fn snapshot_dir(path: &Path) -> Result<ConfigDirSnapshot, String> {
    if std::fs::symlink_metadata(path).is_err() {
        return Ok(ConfigDirSnapshot::Missing {
            path: path.to_string_lossy().to_string(),
        });
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("metadata {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "skill directory must not be a symlink: {}",
            path.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!("skill path is not a directory: {}", path.display()));
    }
    let mut files = Vec::new();
    walk_hashed(path, path, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ConfigDirSnapshot::Snapshot {
        path: path.to_string_lossy().to_string(),
        files,
    })
}

pub fn snapshot_external_skill(path: &Path) -> Result<Vec<ConfigFileHash>, String> {
    let root = std::fs::canonicalize(path)
        .map_err(|_| "external skill target is unavailable".to_string())?;
    if !root.is_dir() {
        return Err("external skill target is not a directory".to_string());
    }
    let mut files = Vec::new();
    walk_hashed(&root, &root, &mut files)
        .map_err(|_| "external skill target could not be verified".to_string())?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub fn baseline_text(target: &Path, expected_hash: &str) -> Result<String, String> {
    if expected_hash.len() != 64
        || !expected_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("the onboarding baseline hash is invalid".into());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "the onboarding baseline directory is unavailable".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "the onboarding baseline filename is unavailable".to_string())?;
    let prefix = format!("{name}{BACKUP_INFIX}");
    let mut candidates = std::fs::read_dir(parent)
        .map_err(|_| "the onboarding baseline directory is unavailable".to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "the onboarding baseline directory is unavailable".to_string())?;
    candidates.sort_by_key(std::fs::DirEntry::file_name);
    candidates.reverse();
    for candidate in candidates {
        let candidate_name = candidate.file_name();
        let Some(candidate_name) = candidate_name.to_str() else {
            continue;
        };
        if !candidate_name.starts_with(&prefix) {
            continue;
        }
        let metadata = candidate
            .file_type()
            .map_err(|_| "the onboarding baseline could not be verified".to_string())?;
        if !metadata.is_file() || metadata.is_symlink() {
            continue;
        }
        let bytes = std::fs::read(candidate.path())
            .map_err(|_| "the onboarding baseline could not be read".to_string())?;
        if sha256_hex(&bytes) != expected_hash {
            continue;
        }
        return String::from_utf8(bytes)
            .map_err(|_| "the onboarding baseline is not text".to_string());
    }
    Err("the onboarding baseline backup is unavailable".into())
}

fn sorted_hashes(files: &[ConfigFileHash]) -> Vec<ConfigFileHash> {
    let mut sorted = files.to_vec();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    sorted
}

fn require_snapshot(path: &Path, expected: &[ConfigFileHash]) -> Result<(), String> {
    match snapshot_dir(path)? {
        ConfigDirSnapshot::Snapshot { files, .. } if files == sorted_hashes(expected) => Ok(()),
        ConfigDirSnapshot::Snapshot { .. } => Err(format!(
            "skill changed on disk since it was inspected: {}",
            path.display()
        )),
        ConfigDirSnapshot::Missing { .. } => Err(format!(
            "expected skill directory is missing: {}",
            path.display()
        )),
    }
}

fn unique_sibling(path: &Path, infix: &str, now: SystemTime) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("skill directory has no parent: {}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    for attempt in 0..100u32 {
        let candidate = parent.join(format!("{name}{infix}{}-{attempt}", iso_timestamp(now)));
        if std::fs::symlink_metadata(&candidate).is_err() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "could not allocate a sibling path for {}",
        path.display()
    ))
}

fn write_staged_dir(
    target: &Path,
    files: &[ConfigInstallFile],
    now: SystemTime,
) -> Result<PathBuf, String> {
    if files.is_empty() {
        return Err("a skill directory must contain at least one file".to_string());
    }
    let stage = unique_sibling(target, ".kodade-tmp-", now)?;
    std::fs::create_dir(&stage)
        .map_err(|error| format!("create staged skill dir {}: {error}", stage.display()))?;
    let result = (|| {
        let mut seen = std::collections::HashSet::new();
        for file in files {
            let relative = safe_relative(&file.path)?;
            if !seen.insert(file.path.clone()) {
                return Err(format!("duplicate skill file: {}", file.path));
            }
            let actual = sha256_hex(file.contents.as_bytes());
            if actual != file.sha256 {
                return Err(format!("skill file hash mismatch: {}", file.path));
            }
            let destination = stage.join(relative);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("create {}: {error}", parent.display()))?;
            }
            std::fs::write(&destination, file.contents.as_bytes())
                .map_err(|error| format!("write {}: {error}", destination.display()))?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(error);
    }
    Ok(stage)
}

fn recover_displaced(displaced: &Path, target: &Path, primary_error: String) -> String {
    match std::fs::rename(displaced, target) {
        Ok(()) => primary_error,
        Err(recovery_error) => format!(
            "{primary_error}; recovery failed moving {} back to {}: {recovery_error}; user data remains at {}",
            displaced.display(),
            target.display(),
            displaced.display()
        ),
    }
}

pub fn install_dir(
    target: &Path,
    files: &[ConfigInstallFile],
    expected: Option<&[ConfigFileHash]>,
    now: SystemTime,
) -> Result<String, String> {
    match expected {
        Some(hashes) => require_snapshot(target, hashes)?,
        None if std::fs::symlink_metadata(target).is_ok() => {
            return Err(format!("skill already exists: {}", target.display()));
        }
        None => {}
    }
    let stage = write_staged_dir(target, files, now)?;
    // Staging can take long enough for another process to change the target.
    // Recheck immediately before the rename that performs the mutation.
    let current_check = match expected {
        Some(hashes) => require_snapshot(target, hashes),
        None if std::fs::symlink_metadata(target).is_ok() => {
            Err(format!("skill already exists: {}", target.display()))
        }
        None => Ok(()),
    };
    if let Err(error) = current_check {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(error);
    }
    let backup = if expected.is_some() {
        let backup = unique_sibling(target, BACKUP_INFIX, now)?;
        if let Err(error) = std::fs::rename(target, &backup) {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(format!("backup skill {}: {error}", target.display()));
        }
        Some(backup)
    } else {
        None
    };
    if let Err(error) = std::fs::rename(&stage, target) {
        let primary_error = format!("install skill {}: {error}", target.display());
        let error = if let Some(backup) = &backup {
            recover_displaced(backup, target, primary_error)
        } else {
            primary_error
        };
        let _ = std::fs::remove_dir_all(&stage);
        return Err(error);
    }
    Ok(backup
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default())
}

pub fn remove_dir(
    target: &Path,
    expected: &[ConfigFileHash],
    now: SystemTime,
    keep_backup: bool,
) -> Result<String, String> {
    require_snapshot(target, expected)?;
    if !keep_backup {
        // Move first, then recheck the moved tree before deleting it. This keeps
        // a racing writer from turning an exact install rollback into a broader
        // delete at the public target path.
        let displaced = unique_sibling(target, ".kodade-discard-", now)?;
        std::fs::rename(target, &displaced)
            .map_err(|error| format!("move installed skill {}: {error}", target.display()))?;
        if let Err(error) = require_snapshot(&displaced, expected) {
            return Err(recover_displaced(&displaced, target, error));
        }
        if let Err(error) = std::fs::remove_dir_all(&displaced) {
            return Err(recover_displaced(
                &displaced,
                target,
                format!("discard installed skill {}: {error}", target.display()),
            ));
        }
        return Ok(String::new());
    }
    let backup = unique_sibling(target, BACKUP_INFIX, now)?;
    std::fs::rename(target, &backup)
        .map_err(|error| format!("backup removed skill {}: {error}", target.display()))?;
    Ok(backup.to_string_lossy().to_string())
}

pub fn restore_dir(
    target: &Path,
    backup: &Path,
    expected_current: Option<&[ConfigFileHash]>,
    now: SystemTime,
) -> Result<(), String> {
    match expected_current {
        Some(hashes) => require_snapshot(target, hashes)?,
        None if std::fs::symlink_metadata(target).is_ok() => {
            return Err(format!(
                "restore target is not absent: {}",
                target.display()
            ));
        }
        None => {}
    }
    let displaced = if expected_current.is_some() {
        let displaced = unique_sibling(target, ".kodade-failed-", now)?;
        std::fs::rename(target, &displaced)
            .map_err(|error| format!("move failed skill {}: {error}", target.display()))?;
        Some(displaced)
    } else {
        None
    };
    if let Err(error) = std::fs::rename(backup, target) {
        let primary_error = format!(
            "restore skill {} from {}: {error}",
            target.display(),
            backup.display()
        );
        return Err(if let Some(displaced) = &displaced {
            recover_displaced(displaced, target, primary_error)
        } else {
            primary_error
        });
    }
    if let Some(displaced) = displaced {
        let _ = std::fs::remove_dir_all(displaced);
    }
    Ok(())
}

fn walk_pack_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<KodSkillsPackFile>,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(current)
        .map_err(|error| format!("read KödSkills resource {}: {error}", current.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read KödSkills resource {}: {error}", current.display()))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("metadata {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "KödSkills resource contains a symlink: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            walk_pack_files(root, &path, files)?;
        } else if metadata.is_file() {
            files.push(KodSkillsPackFile {
                path: path
                    .strip_prefix(root)
                    .map_err(|error| format!("relative resource path: {error}"))?
                    .to_string_lossy()
                    .replace('\\', "/"),
                contents: std::fs::read_to_string(&path).map_err(|error| {
                    format!("read UTF-8 KödSkills file {}: {error}", path.display())
                })?,
            });
        }
    }
    Ok(())
}

pub fn read_kodskills_pack(root: &Path) -> Result<KodSkillsPackBundle, String> {
    let manifest = std::fs::read_to_string(root.join("pack.json"))
        .map_err(|error| format!("read KödSkills pack manifest: {error}"))?;
    let mut files = Vec::new();
    walk_pack_files(root, &root.join("skills"), &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(KodSkillsPackBundle { manifest, files })
}

// Filesystem-safe UTC ISO stamp (`YYYY-MM-DDTHH-MM-SS-mmmZ`) from a SystemTime.
// Dependency-free: converts the Unix epoch to a civil date directly.
pub fn iso_timestamp(now: SystemTime) -> String {
    let dur = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}-{millis:03}Z")
}

// Howard Hinnant's civil-from-days: a count of days since the Unix epoch to a
// (year, month, day) in the proleptic Gregorian calendar. Exact, no leap tables.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kodade-config-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sha256_matches_known_vector() {
        // SHA-256("abc") — the canonical test vector.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn remove_config_requires_the_exact_current_hash() {
        let dir = temp_dir("remove-exact-config");
        let target = dir.join("config.toml");
        std::fs::write(&target, "managed bytes").unwrap();

        let error = remove_config(&target, &sha256_hex(b"older bytes"))
            .expect_err("drift must refuse rollback removal");
        assert!(error.contains("changed since apply"));
        assert!(target.exists());

        remove_config(&target, &sha256_hex(b"managed bytes")).unwrap();
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn baseline_text_recovers_only_an_exact_guarded_backup() {
        let dir = temp_dir("onboarding-baseline");
        let target = dir.join("config.toml");
        let baseline = "# Preserve formatting exactly\n";
        std::fs::write(&target, baseline).unwrap();
        write_config(
            &target,
            "[mcp_servers.kodade]\ncommand = \"kodade-mcp\"\n",
            &sha256_hex(baseline.as_bytes()),
            std::time::UNIX_EPOCH,
        )
        .unwrap();

        assert_eq!(
            baseline_text(&target, &sha256_hex(baseline.as_bytes())).unwrap(),
            baseline
        );
        assert!(baseline_text(&target, &sha256_hex(b"other baseline")).is_err());
        assert!(baseline_text(&target, &sha256_hex(baseline.as_bytes()).to_uppercase()).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn external_skill_snapshot_follows_only_the_root_link() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("external-skill-snapshot");
        let source = dir.join("dotfiles-skill");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "skill contract").unwrap();
        let link = dir.join("kodmem-project");
        symlink(&source, &link).unwrap();

        let files = snapshot_external_skill(&link).unwrap();
        assert_eq!(
            files,
            vec![ConfigFileHash {
                path: "SKILL.md".into(),
                sha256: sha256_hex(b"skill contract"),
            }]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn iso_timestamp_formats_a_known_epoch() {
        // 2026-07-14T00:00:00Z is 1_784_000... let's use a fixed known instant:
        // 1_700_000_000 = 2023-11-14T22:13:20Z.
        let t = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        assert_eq!(iso_timestamp(t), "2023-11-14T22-13-20-000Z");
    }

    #[cfg(unix)]
    #[test]
    fn scan_resolves_relative_symlinks_to_one_canonical_target() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("scan-relative-symlink");
        let source = dir.join("source").join("review");
        let skills = dir.join("skills");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&skills).unwrap();
        symlink("../source/review", skills.join("review")).unwrap();

        let entries = scan_dir(&skills).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].target.as_deref(),
            Some(std::fs::canonicalize(&source).unwrap().to_str().unwrap()),
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn scan_does_not_report_an_unresolved_relative_symlink_as_canonical() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("scan-broken-relative-symlink");
        symlink("../missing/review", dir.join("review")).unwrap();

        let entries = scan_dir(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert!(entries[0].orphaned);
        assert_eq!(entries[0].target, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_a_bounded_project_skill_source_tree() {
        let dir = temp_dir("project-skill-source");
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: review\ndescription: Review.\n---\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("scripts").join("check.sh"), "#!/bin/sh\n").unwrap();

        let bundle = read_project_skill_source(&dir).unwrap();

        assert_eq!(
            bundle.root,
            std::fs::canonicalize(&dir).unwrap().to_string_lossy()
        );
        assert_eq!(
            bundle
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["SKILL.md", "scripts/check.sh"],
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn project_skill_source_requires_a_root_manifest_and_utf8_files() {
        let missing = temp_dir("project-skill-source-missing");
        std::fs::write(missing.join("README.md"), "not a skill").unwrap();
        let error = read_project_skill_source(&missing).unwrap_err();
        assert!(error.contains("SKILL.md"), "got: {error}");
        let _ = std::fs::remove_dir_all(missing);

        let binary = temp_dir("project-skill-source-binary");
        std::fs::write(
            binary.join("SKILL.md"),
            "---\nname: review\ndescription: Review.\n---\n",
        )
        .unwrap();
        std::fs::write(binary.join("asset.bin"), [0xff, 0xfe]).unwrap();
        let error = read_project_skill_source(&binary).unwrap_err();
        assert!(error.contains("UTF-8 text"), "got: {error}");
        let _ = std::fs::remove_dir_all(binary);
    }

    #[cfg(unix)]
    #[test]
    fn project_skill_source_never_follows_nested_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("project-skill-source-symlink");
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: review\ndescription: Review.\n---\n",
        )
        .unwrap();
        let outside = dir.parent().unwrap().join("kodade-project-skill-secret");
        std::fs::write(&outside, "secret").unwrap();
        symlink(&outside, dir.join("secret.txt")).unwrap();

        let error = read_project_skill_source(&dir).unwrap_err();

        assert!(error.contains("symlink"), "got: {error}");
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_config_rejects_a_stale_hash() {
        let dir = temp_dir("write-stale");
        let target = dir.join("CLAUDE.md");
        std::fs::write(&target, "current bytes").unwrap();
        let err = write_config(&target, "new", "deadbeef", SystemTime::now())
            .expect_err("a wrong expected hash must be rejected");
        assert!(err.contains("changed on disk"), "got: {err}");
        // The file is untouched on rejection.
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "current bytes");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_config_backs_up_then_writes_on_a_matching_hash() {
        let dir = temp_dir("write-ok");
        let target = dir.join("CLAUDE.md");
        std::fs::write(&target, "old").unwrap();
        let hash = sha256_hex(b"old");
        let backup = write_config(&target, "new", &hash, SystemTime::now()).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert!(backup.contains(".kodade-bak-"), "backup path: {backup}");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "old");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_config_creates_a_new_file_with_empty_hash() {
        let dir = temp_dir("write-new");
        let target = dir.join("AGENTS.md");
        let backup = write_config(&target, "fresh", "", SystemTime::now()).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "fresh");
        assert!(backup.is_empty(), "a new file has no backup");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn backup_config_writes_an_exact_sibling_copy() {
        let dir = temp_dir("backup-shape");
        let target = dir.join("config.toml");
        std::fs::write(&target, "servers").unwrap();
        let backup = backup_config(&target, SystemTime::now()).unwrap();
        let name = Path::new(&backup).file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("config.toml.kodade-bak-"), "name: {name}");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "servers");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_config_round_trips_byte_identical() {
        let dir = temp_dir("restore-roundtrip");
        let target = dir.join(".mcp.json");
        std::fs::write(&target, "{\"a\":1}").unwrap();
        let backup = backup_config(&target, SystemTime::now()).unwrap();
        // Mutate, then restore from the backup.
        std::fs::write(&target, "{\"a\":2}").unwrap();
        restore_config(&target, Path::new(&backup)).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"a\":1}");
        let _ = std::fs::remove_dir_all(dir);
    }

    // --- M10g: permission-denied / read-only recovery ---
    //
    // POSIX permission bits and Windows file attributes / ACLs use separate
    // platform-native fixtures. Both pin config.rs's write/backup/restore
    // ordering: a doomed mutation leaves the target untouched and creates no
    // orphan backup or temp file.

    #[cfg(unix)]
    #[test]
    fn write_config_refuses_a_read_only_target_with_no_partial_state() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("write-readonly-target");
        let target = dir.join("CLAUDE.md");
        std::fs::write(&target, "protected bytes").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).unwrap();

        let hash = sha256_hex(b"protected bytes");
        let err = write_config(&target, "new bytes", &hash, SystemTime::now())
            .expect_err("a read-only target must be refused, not silently replaced");
        assert!(err.contains("read-only"), "got: {err}");

        // No partial state: the target is untouched, and no backup was ever
        // created (the check runs before the backup step).
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "protected bytes");
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".kodade-bak-"))
            .collect();
        assert!(backups.is_empty(), "no backup must be written on refusal");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn write_config_surfaces_a_clean_error_when_the_directory_is_read_only() {
        use std::os::unix::fs::PermissionsExt;
        // A writable target file inside a directory that has lost write
        // permission (a common "read-only filesystem"/locked-folder QA
        // scenario) — the temp-file creation itself must fail cleanly, and
        // the original file must be provably untouched afterward.
        let dir = temp_dir("write-readonly-dir");
        let target = dir.join("CLAUDE.md");
        std::fs::write(&target, "original bytes").unwrap();
        let hash = sha256_hex(b"original bytes");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let result = write_config(&target, "new bytes", &hash, SystemTime::now());
        // Restore dir permissions BEFORE any assertion/cleanup that needs to
        // touch the dir, so a failing assertion never leaves a locked temp
        // dir behind.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let err = result.expect_err("a read-only directory must surface a clean error");
        assert!(!err.is_empty());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "original bytes",
            "the original file must survive a failed write untouched"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".kodade.tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no stray temp file must survive a failed write"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn restore_config_refuses_a_read_only_target() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("restore-readonly-target");
        let target = dir.join(".mcp.json");
        std::fs::write(&target, "{\"a\":1}").unwrap();
        let backup = backup_config(&target, SystemTime::now()).unwrap();
        std::fs::write(&target, "{\"a\":2}").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).unwrap();

        let err = restore_config(&target, Path::new(&backup))
            .expect_err("a read-only restore target must be refused");
        assert!(err.contains("read-only"), "got: {err}");

        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "{\"a\":2}",
            "a refused restore must never touch the target"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn backup_config_surfaces_a_clean_error_when_the_directory_is_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("backup-readonly-dir");
        let target = dir.join("config.toml");
        std::fs::write(&target, "servers").unwrap();

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let result = backup_config(&target, SystemTime::now());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let err = result.expect_err("backing up into a read-only directory must fail cleanly");
        assert!(!err.is_empty());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "servers");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_directory_install_update_remove_restore_round_trips() {
        let dir = temp_dir("kodskills-roundtrip");
        let skills = dir.join("skills");
        std::fs::create_dir(&skills).unwrap();
        let target = skills.join("code-review");
        let first = vec![
            ConfigInstallFile {
                path: "SKILL.md".into(),
                sha256: sha256_hex(b"first"),
                contents: "first".into(),
            },
            ConfigInstallFile {
                path: "agents/openai.yaml".into(),
                sha256: sha256_hex(b"agent"),
                contents: "agent".into(),
            },
        ];
        let no_backup = install_dir(&target, &first, None, SystemTime::now()).unwrap();
        assert!(no_backup.is_empty());
        let initial = match snapshot_dir(&target).unwrap() {
            ConfigDirSnapshot::Snapshot { files, .. } => files,
            other => panic!("expected installed snapshot, got {other:?}"),
        };

        let second = vec![ConfigInstallFile {
            path: "SKILL.md".into(),
            sha256: sha256_hex(b"second"),
            contents: "second".into(),
        }];
        let update_backup =
            install_dir(&target, &second, Some(&initial), SystemTime::now()).unwrap();
        let updated = match snapshot_dir(&target).unwrap() {
            ConfigDirSnapshot::Snapshot { files, .. } => files,
            other => panic!("expected updated snapshot, got {other:?}"),
        };
        restore_dir(
            &target,
            Path::new(&update_backup),
            Some(&updated),
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(
            snapshot_dir(&target).unwrap(),
            ConfigDirSnapshot::Snapshot {
                path: target.to_string_lossy().to_string(),
                files: initial.clone(),
            }
        );

        let remove_backup = remove_dir(&target, &initial, SystemTime::now(), true).unwrap();
        assert!(matches!(
            snapshot_dir(&target).unwrap(),
            ConfigDirSnapshot::Missing { .. }
        ));
        restore_dir(&target, Path::new(&remove_backup), None, SystemTime::now()).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "first"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_directory_mutation_rejects_stale_hashes() {
        let dir = temp_dir("kodskills-stale");
        let target = dir.join("code-review");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("SKILL.md"), "local edit").unwrap();
        let stale = vec![ConfigFileHash {
            path: "SKILL.md".into(),
            sha256: sha256_hex(b"original"),
        }];
        let err = remove_dir(&target, &stale, SystemTime::now(), true)
            .expect_err("a locally modified skill must not be removed");
        assert!(err.contains("changed on disk"), "got: {err}");
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_directory_recovery_reports_where_user_data_remains() {
        let dir = temp_dir("kodskills-recovery-error");
        let displaced = dir.join("code-review.kodade-bak-test");
        let target = dir.join("code-review");
        std::fs::create_dir(&displaced).unwrap();
        std::fs::write(displaced.join("SKILL.md"), "original").unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("occupant"), "blocks recovery").unwrap();

        let error = recover_displaced(
            &displaced,
            &target,
            "install skill failed: primary error".to_string(),
        );

        assert!(error.contains("primary error"), "got: {error}");
        assert!(error.contains("recovery failed"), "got: {error}");
        assert!(
            error.contains(&displaced.to_string_lossy().to_string()),
            "got: {error}"
        );
        assert!(
            displaced.exists(),
            "the reported recovery path must still exist"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_install_rollback_discards_the_exact_new_tree_without_a_backup() {
        let dir = temp_dir("kodskills-install-rollback");
        let skills = dir.join("skills");
        let target = skills.join("code-review");
        std::fs::create_dir(&skills).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("SKILL.md"), "installed").unwrap();
        let expected = vec![ConfigFileHash {
            path: "SKILL.md".into(),
            sha256: sha256_hex(b"installed"),
        }];

        let backup = remove_dir(&target, &expected, SystemTime::now(), false).unwrap();

        assert!(backup.is_empty());
        assert!(!target.exists());
        let siblings = std::fs::read_dir(&skills).unwrap().count();
        assert_eq!(
            siblings, 0,
            "install rollback must not leave an orphan backup"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn skill_snapshot_rejects_nested_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = temp_dir("kodskills-nested-symlink");
        let target = dir.join("code-review");
        std::fs::create_dir(&target).unwrap();
        let outside = dir.join("outside.md");
        std::fs::write(&outside, "outside").unwrap();
        symlink(&outside, target.join("SKILL.md")).unwrap();
        let err = snapshot_dir(&target).expect_err("nested symlinks must not be hashed through");
        assert!(err.contains("contains a symlink"), "got: {err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_the_vendored_kodskills_resource_tree() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("resources")
            .join("kodskills");
        let bundle = read_kodskills_pack(&root).unwrap();
        assert!(bundle.manifest.contains("KödSkills engineering pack"));
        assert_eq!(bundle.files.len(), 41);
        assert!(bundle
            .files
            .iter()
            .any(|file| file.path == "skills/code-review/SKILL.md"));
    }

    #[cfg(unix)]
    #[test]
    fn write_config_succeeds_when_only_the_file_is_read_only_is_no_longer_true() {
        // Documents the INTENTIONAL change from the raw-rename default: a
        // writable directory alone used to be enough for a config write to
        // silently succeed over a read-only file (Unix rename doesn't check
        // the target's own mode bits). M10g makes read-only mean something —
        // see write_config_refuses_a_read_only_target_with_no_partial_state.
        // This test just pins the underlying OS fact the guard exists to
        // override, so a future refactor can't accidentally reintroduce the
        // silent-bypass behavior without this test explaining why not to.
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("raw-rename-over-readonly-fact");
        let target = dir.join("raw.txt");
        std::fs::write(&target, "old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).unwrap();
        let tmp = dir.join("raw.tmp");
        std::fs::write(&tmp, "new").unwrap();
        crate::fs::atomic_replace(&tmp, &target)
            .expect("a bare rename ignores the target's mode bits");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    // Windows' read-only file attribute is visible through
    // Permissions::readonly(), while directory write denial is a DACL concern
    // (a directory's read-only attribute does not prevent file creation).
    // Use icacls directly on Windows CI so these tests exercise the real NTFS
    // behavior instead of approximating it with Unix mode bits.
    #[cfg(windows)]
    struct WindowsReadOnlyFile {
        path: PathBuf,
    }

    #[cfg(windows)]
    impl WindowsReadOnlyFile {
        fn new(path: &Path) -> Self {
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(path, permissions).unwrap();
            Self {
                path: path.to_path_buf(),
            }
        }

        // Clearing the Windows read-only attribute is the exact inverse of
        // `new`; Clippy's Unix world-writable warning does not apply here.
        #[allow(clippy::permissions_set_readonly_false)]
        fn restore(&mut self) {
            let mut permissions = std::fs::metadata(&self.path).unwrap().permissions();
            permissions.set_readonly(false);
            std::fs::set_permissions(&self.path, permissions).unwrap();
        }
    }

    #[cfg(windows)]
    impl Drop for WindowsReadOnlyFile {
        // Best-effort Windows fixture cleanup. This code is never compiled on
        // Unix, where clearing readonly could broaden mode bits.
        #[allow(clippy::permissions_set_readonly_false)]
        fn drop(&mut self) {
            if let Ok(metadata) = std::fs::metadata(&self.path) {
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                let _ = std::fs::set_permissions(&self.path, permissions);
            }
        }
    }

    #[cfg(windows)]
    struct WindowsDenyWriteData {
        path: PathBuf,
        identity: String,
        active: bool,
    }

    #[cfg(windows)]
    impl WindowsDenyWriteData {
        fn new(path: &Path) -> Self {
            let user = std::env::var("USERNAME").expect("USERNAME is set on Windows");
            let identity = std::env::var("USERDOMAIN")
                .ok()
                .filter(|domain| !domain.is_empty())
                .map(|domain| format!(r"{domain}\{user}"))
                .unwrap_or(user);
            let ace = format!("{identity}:(WD)");
            let output = std::process::Command::new("icacls.exe")
                .arg(path)
                .args(["/deny", &ace, "/q"])
                .output()
                .expect("icacls must be available on supported Windows versions");
            assert!(
                output.status.success(),
                "icacls /deny failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            Self {
                path: path.to_path_buf(),
                identity,
                active: true,
            }
        }

        fn restore(&mut self) {
            if !self.active {
                return;
            }
            let output = std::process::Command::new("icacls.exe")
                .arg(&self.path)
                .args(["/remove:d", &self.identity, "/q"])
                .output()
                .expect("icacls must be available while restoring the test ACL");
            assert!(
                output.status.success(),
                "icacls /remove:d failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            self.active = false;
        }
    }

    #[cfg(windows)]
    impl Drop for WindowsDenyWriteData {
        fn drop(&mut self) {
            if self.active {
                let _ = std::process::Command::new("icacls.exe")
                    .arg(&self.path)
                    .args(["/remove:d", &self.identity, "/q"])
                    .output();
            }
        }
    }

    #[cfg(windows)]
    fn backup_and_temp_entries(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(BACKUP_INFIX) || name.contains(".kodade.tmp"))
            .collect()
    }

    #[cfg(windows)]
    #[test]
    fn windows_write_config_refuses_a_read_only_target_with_no_partial_state() {
        let dir = temp_dir("windows-write-readonly-target");
        let target = dir.join("CLAUDE.md");
        std::fs::write(&target, "protected bytes").unwrap();
        let mut read_only = WindowsReadOnlyFile::new(&target);

        let hash = sha256_hex(b"protected bytes");
        let err = write_config(&target, "new bytes", &hash, SystemTime::now())
            .expect_err("the Windows read-only attribute must refuse a config write");
        assert!(err.contains("read-only"), "got: {err}");

        read_only.restore();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "protected bytes");
        assert!(
            backup_and_temp_entries(&dir).is_empty(),
            "no backup or temp file may be created on refusal"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_backup_config_copies_a_read_only_source_without_mutating_it() {
        let dir = temp_dir("windows-backup-readonly-source");
        let target = dir.join("config.toml");
        std::fs::write(&target, "protected bytes").unwrap();
        let mut read_only = WindowsReadOnlyFile::new(&target);

        let backup = backup_config(&target, SystemTime::now())
            .expect("a read-only source must remain available for backup");

        assert!(std::fs::metadata(&target).unwrap().permissions().readonly());
        read_only.restore();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "protected bytes");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "protected bytes");
        assert!(
            !std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().contains(".kodade.tmp")),
            "backup must not leave a temporary file"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_restore_config_refuses_a_read_only_target() {
        let dir = temp_dir("windows-restore-readonly-target");
        let target = dir.join(".mcp.json");
        let backup = dir.join("restore-source");
        std::fs::write(&target, r#"{"a":2}"#).unwrap();
        std::fs::write(&backup, r#"{"a":1}"#).unwrap();
        let mut read_only = WindowsReadOnlyFile::new(&target);

        let err = restore_config(&target, &backup)
            .expect_err("the Windows read-only attribute must refuse a restore");
        assert!(err.contains("read-only"), "got: {err}");

        read_only.restore();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            r#"{"a":2}"#,
            "a refused restore must never touch the target"
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), r#"{"a":1}"#);
        assert!(
            backup_and_temp_entries(&dir).is_empty(),
            "a refused restore must not leave a backup or temp file"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_acl_denial_preserves_write_target_without_backup_or_temp() {
        let base = temp_dir("windows-write-acl-denied-dir");
        let dir = base.join("locked");
        std::fs::create_dir(&dir).unwrap();
        let target = dir.join("CLAUDE.md");
        std::fs::write(&target, "original bytes").unwrap();
        let hash = sha256_hex(b"original bytes");
        let mut denied = WindowsDenyWriteData::new(&dir);

        let err = write_config(&target, "new bytes", &hash, SystemTime::now())
            .expect_err("a DACL-denied directory must reject config writes");
        assert!(!err.is_empty());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original bytes");
        assert!(
            backup_and_temp_entries(&dir).is_empty(),
            "no backup or temp file may survive a DACL refusal"
        );

        denied.restore();
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn windows_acl_denial_preserves_backup_and_restore_targets() {
        let base = temp_dir("windows-backup-restore-acl-denied-dir");
        let dir = base.join("locked");
        std::fs::create_dir(&dir).unwrap();
        let target = dir.join("config.toml");
        let restore_source = base.join("config.restore");
        std::fs::write(&target, "current").unwrap();
        std::fs::write(&restore_source, "restored").unwrap();
        let mut denied = WindowsDenyWriteData::new(&dir);

        let backup_err = backup_config(&target, SystemTime::now())
            .expect_err("a DACL-denied directory must reject backup creation");
        assert!(!backup_err.is_empty());
        let restore_err = restore_config(&target, &restore_source)
            .expect_err("a DACL-denied directory must reject atomic restore");
        assert!(!restore_err.is_empty());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "current");
        assert!(
            backup_and_temp_entries(&dir).is_empty(),
            "backup and restore refusals must leave no partial files"
        );

        denied.restore();
        let _ = std::fs::remove_dir_all(base);
    }
}
