use super::*;

// The validated decoded operation payload is capped at 8 MiB; this larger
// envelope allows worst-case JSON escaping while bounding pre-serde allocation.
const MAX_JOURNAL_ENVELOPE_BYTES: u64 = 64 * 1024 * 1024;

pub(super) fn file_hash_optional(path: &Path) -> Result<Option<String>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(MemoryError::InvalidInput(format!(
                "portable Markdown target must be a regular file: {}",
                path.display()
            )))
        }
        Ok(metadata) if metadata.len() > portable_policy()?.max_document_bytes => Err(
            MemoryError::InvalidInput("portable Markdown target exceeds the file limit".into()),
        ),
        Ok(_) => {
            let mut bytes = Vec::new();
            File::open(path)?
                .take(portable_policy()?.max_document_bytes + 1)
                .read_to_end(&mut bytes)?;
            Ok(Some(sha256_bytes(&bytes)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn read_optional_regular(
    location: &ProjectLocation,
    relative: &str,
) -> Result<Option<String>> {
    let path = confined_path(location, relative)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::InvalidInput(
            "portable Markdown target must be a regular file".into(),
        ));
    }
    let limit = portable_policy()?.max_document_bytes;
    if metadata.len() > limit {
        return Err(MemoryError::InvalidInput(
            "portable Markdown target exceeds the file limit".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(MemoryError::InvalidInput(
            "portable Markdown target changed beyond the file limit while reading".into(),
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| MemoryError::InvalidInput("portable Markdown must be valid UTF-8".into()))
}

pub(super) fn read_optional_runtime_journal(path: &Path) -> Result<Option<Vec<u8>>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::InvalidInput(
            "portable recovery journal must be a regular file".into(),
        ));
    }
    if metadata.len() > MAX_JOURNAL_ENVELOPE_BYTES {
        return Err(MemoryError::InvalidInput(
            "portable recovery journal exceeds the envelope limit".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(MAX_JOURNAL_ENVELOPE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_JOURNAL_ENVELOPE_BYTES {
        return Err(MemoryError::InvalidInput(
            "portable recovery journal changed beyond the envelope limit while reading".into(),
        ));
    }
    Ok(Some(bytes))
}

pub(super) fn relative_path(location: &ProjectLocation, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(&location.project_root)
        .map_err(|_| MemoryError::InvalidInput("canonical note escaped its project".into()))?
        .to_string_lossy()
        .replace('\\', "/"))
}

pub(super) fn confined_path(location: &ProjectLocation, relative: &str) -> Result<PathBuf> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(MemoryError::InvalidInput(
            "portable write path escapes its mapped project".into(),
        ));
    }
    let mut parent = location.project_root.clone();
    for component in relative_path
        .parent()
        .into_iter()
        .flat_map(Path::components)
    {
        let Component::Normal(component) = component else {
            return Err(MemoryError::InvalidInput(
                "unsafe portable write path".into(),
            ));
        };
        parent.push(component);
        match std::fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(MemoryError::InvalidInput(format!(
                    "portable write parent must be a regular directory: {}",
                    parent.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&parent)?;
                if let Some(grandparent) = parent.parent() {
                    sync_parent_directory(grandparent)?;
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(location.project_root.join(relative_path))
}

pub(super) fn atomic_write(path: &Path, contents: &str) -> Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().ok_or_else(|| {
        MemoryError::InvalidInput("portable Markdown target has no parent".into())
    })?;
    let temporary = parent.join(format!(
        ".kodmem-write-{}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        crate::fs::atomic_replace(&temporary, path)?;
        sync_parent_directory(parent)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(Into::into)
}

pub(super) fn portable_runtime_root(create: bool) -> Result<PathBuf> {
    let root = std::env::temp_dir().join(&portable_policy()?.lock_namespace);
    match std::fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(MemoryError::InvalidInput(
                "portable runtime namespace must be a regular directory".into(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            std::fs::create_dir(&root)?;
            sync_parent_directory(
                root.parent().ok_or_else(|| {
                    MemoryError::InvalidInput("runtime root has no parent".into())
                })?,
            )?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(root)
}

pub(super) fn portable_root_key(location: &ProjectLocation) -> Result<String> {
    let canonical = std::fs::canonicalize(&location.project_root)?;
    Ok(sha256_text(&canonical.to_string_lossy()))
}

pub(super) fn portable_journal_path(location: &ProjectLocation) -> Result<PathBuf> {
    Ok(portable_runtime_root(false)?.join(format!(
        "{}-{}",
        portable_root_key(location)?,
        portable_policy()?.journal_file
    )))
}

pub(super) fn remove_durable(path: &Path) -> Result<()> {
    std::fs::remove_file(path)?;
    if let Some(parent) = path.parent() {
        sync_parent_directory(parent)?;
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn sync_parent_directory(parent: &Path) -> Result<()> {
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn sync_parent_directory(_parent: &Path) -> Result<()> {
    Ok(())
}

pub(super) fn bounded_utf8(mut value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let suffix = "\n\n[STATE truncated by KödMem; full detail remains in Worklog.]\n";
    let mut end = limit.saturating_sub(suffix.len());
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    value.truncate(end);
    value.push_str(suffix);
    value
}

pub(super) fn bounded_preview(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit.saturating_sub(1);
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}…", &value[..end])
}

pub(super) fn bounded_list_preview(values: &[String]) -> Vec<String> {
    values
        .iter()
        .take(20)
        .map(|value| bounded_preview(value, 2_000))
        .collect()
}

pub(super) fn portable_failpoint(phase: &str) -> Result<()> {
    if std::env::var("KODADE_TEST_PORTABLE_FAIL_AFTER")
        .ok()
        .as_deref()
        == Some(phase)
    {
        return Err(MemoryError::Io(std::io::Error::other(format!(
            "injected portable write failure after {phase}"
        ))));
    }
    Ok(())
}

pub(super) fn portable_lock_test_barrier() -> Result<()> {
    let (Ok(ready), Ok(release)) = (
        std::env::var("KODADE_TEST_PORTABLE_LOCK_READY"),
        std::env::var("KODADE_TEST_PORTABLE_LOCK_RELEASE"),
    ) else {
        return Ok(());
    };
    let ready = PathBuf::from(ready);
    let release = PathBuf::from(release);
    std::fs::write(&ready, b"locked")?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !release.exists() {
        if Instant::now() >= deadline {
            return Err(MemoryError::Io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "portable lock test barrier timed out",
            )));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
