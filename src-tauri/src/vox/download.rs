use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use url::Url;

use super::{VoxDownloadProgress, VoxDownloadResult};

pub(crate) fn download_model(
    url: &str,
    allowed_root: &Path,
    destination: &Path,
    expected_sha256: Option<&str>,
    mut on_progress: impl FnMut(VoxDownloadProgress),
) -> Result<VoxDownloadResult, String> {
    download_model_with_fetch(
        url,
        allowed_root,
        destination,
        expected_sha256,
        fetch_model,
        &mut on_progress,
    )
}

struct DownloadRequest<'a> {
    url: &'a str,
    resume_from: u64,
}

struct DownloadResponse<R> {
    status: StatusCode,
    content_range: Option<String>,
    content_length: Option<u64>,
    body: R,
}

fn download_model_with_fetch<R: Read>(
    url: &str,
    allowed_root: &Path,
    destination: &Path,
    expected_sha256: Option<&str>,
    fetch: impl FnOnce(DownloadRequest<'_>) -> Result<DownloadResponse<R>, String>,
    mut on_progress: impl FnMut(VoxDownloadProgress),
) -> Result<VoxDownloadResult, String> {
    validate_initial_url(url)?;
    let expected_sha256 = normalize_expected_sha256(expected_sha256)?;
    let (destination, part) = confined_download_paths(allowed_root, destination)?;

    let existing = fs::metadata(&part)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let response = fetch(DownloadRequest {
        url,
        resume_from: existing,
    })?;
    install_response(
        response,
        &destination,
        &part,
        existing,
        expected_sha256.as_deref(),
        &mut on_progress,
    )
}

fn fetch_model(
    request: DownloadRequest<'_>,
) -> Result<DownloadResponse<reqwest::blocking::Response>, String> {
    let client = Client::builder()
        .redirect(https_redirect_policy())
        .build()
        .map_err(|e| format!("create model download client: {e}"))?;
    let mut download = client.get(request.url);
    if request.resume_from > 0 {
        download = download.header(RANGE, format!("bytes={}-", request.resume_from));
    }
    let response = download
        .send()
        .map_err(|e| format!("download model: {e}"))?;
    let status = response.status();
    let content_range = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let content_length = response.content_length();
    Ok(DownloadResponse {
        status,
        content_range,
        content_length,
        body: response,
    })
}

fn install_response<R: Read>(
    mut response: DownloadResponse<R>,
    destination: &Path,
    part: &Path,
    existing: u64,
    expected_sha256: Option<&str>,
    mut on_progress: impl FnMut(VoxDownloadProgress),
) -> Result<VoxDownloadResult, String> {
    let resumed = response.status == StatusCode::PARTIAL_CONTENT && existing > 0;

    if resumed {
        let start = response
            .content_range
            .as_deref()
            .and_then(content_range_start)
            .ok_or_else(|| "model server returned an invalid Content-Range".to_string())?;
        if start != existing {
            return Err(format!(
                "model server resumed at byte {start}, expected {existing}"
            ));
        }
    } else if !response.status.is_success() {
        return Err(format!("model download returned HTTP {}", response.status));
    }

    let base = if resumed { existing } else { 0 };
    let total = response
        .content_range
        .as_deref()
        .and_then(content_range_total)
        .or_else(|| response.content_length.map(|length| base + length));
    let mut hasher = Sha256::new();
    if resumed {
        hash_file(part, &mut hasher)?;
    }
    let mut output = if resumed {
        OpenOptions::new()
            .append(true)
            .open(part)
            .map_err(|e| format!("open partial model {}: {e}", part.display()))?
    } else {
        File::create(part).map_err(|e| format!("create partial model {}: {e}", part.display()))?
    };

    let mut downloaded = base;
    let mut last_progress = Instant::now();
    on_progress(VoxDownloadProgress { downloaded, total });
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = response
            .body
            .read(&mut buffer)
            .map_err(|e| format!("read model download: {e}"))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| format!("write partial model {}: {e}", part.display()))?;
        hasher.update(&buffer[..count]);
        downloaded += count as u64;
        if last_progress.elapsed() >= Duration::from_millis(250) {
            on_progress(VoxDownloadProgress { downloaded, total });
            last_progress = Instant::now();
        }
    }
    if total.is_some_and(|expected| expected != downloaded) {
        return Err(format!(
            "model download ended at {downloaded} bytes before the expected total"
        ));
    }
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|e| format!("flush partial model {}: {e}", part.display()))?;
    drop(output);
    let sha256 = format!("{:x}", hasher.finalize());
    if let Some(expected) = expected_sha256.filter(|expected| *expected != sha256) {
        fs::remove_file(part).map_err(|e| {
            format!(
                "model SHA-256 mismatch: expected {expected}, got {sha256}; remove invalid partial model {}: {e}",
                part.display()
            )
        })?;
        return Err(format!(
            "model SHA-256 mismatch: expected {expected}, got {sha256}"
        ));
    }
    fs::rename(part, destination).map_err(|e| {
        format!(
            "atomically install model {} from {}: {e}",
            destination.display(),
            part.display()
        )
    })?;
    on_progress(VoxDownloadProgress { downloaded, total });

    Ok(VoxDownloadResult {
        sha256,
        bytes: downloaded,
    })
}

fn validate_initial_url(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|e| format!("invalid model download URL: {e}"))?;
    ensure_https(&parsed, "model download URL")
}

fn https_redirect_policy() -> Policy {
    Policy::custom(
        |attempt| match validate_redirect(attempt.url(), attempt.previous().len()) {
            Ok(()) => attempt.follow(),
            Err(message) => attempt.error(message),
        },
    )
}

fn validate_redirect(url: &Url, previous_count: usize) -> Result<(), String> {
    if previous_count > 10 {
        return Err("model download exceeded 10 redirects".to_string());
    }
    ensure_https(url, "model download redirect")
}

fn ensure_https(url: &Url, context: &str) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err(format!("{context} must use HTTPS: {url}"));
    }
    Ok(())
}

fn normalize_expected_sha256(expected: Option<&str>) -> Result<Option<String>, String> {
    let Some(expected) = expected else {
        return Ok(None);
    };
    let expected = expected.trim();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("expected SHA-256 must contain exactly 64 hexadecimal characters".to_string());
    }
    Ok(Some(expected.to_ascii_lowercase()))
}

fn confined_download_paths(
    allowed_root: &Path,
    destination: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    if !allowed_root.is_absolute() {
        return Err(format!(
            "model root must be absolute: {}",
            allowed_root.display()
        ));
    }
    if !destination.is_absolute()
        || destination
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return Err(format!(
            "model destination must be an absolute path without traversal inside the model root: {}",
            destination.display()
        ));
    }

    fs::create_dir_all(allowed_root)
        .map_err(|e| format!("create model root {}: {e}", allowed_root.display()))?;
    let root_metadata = fs::symlink_metadata(allowed_root)
        .map_err(|e| format!("inspect model root {}: {e}", allowed_root.display()))?;
    if root_metadata.file_type().is_symlink() {
        return Err(format!(
            "model root must not be a symlink: {}",
            allowed_root.display()
        ));
    }
    let root_canon = fs::canonicalize(allowed_root)
        .map_err(|e| format!("canonicalize model root {}: {e}", allowed_root.display()))?;
    let relative = destination.strip_prefix(allowed_root).map_err(|_| {
        format!(
            "model destination is outside the model root: {}",
            destination.display()
        )
    })?;
    let file_name = relative.file_name().ok_or_else(|| {
        format!(
            "model destination has no file name inside the model root: {}",
            destination.display()
        )
    })?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!(
            "model destination contains an invalid component outside the model root: {}",
            destination.display()
        ));
    }

    let mut parent = allowed_root.to_path_buf();
    if let Some(relative_parent) = relative.parent() {
        for component in relative_parent.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            parent.push(name);
            match fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(format!(
                        "model destination has a symlinked parent: {}",
                        parent.display()
                    ));
                }
                Ok(metadata) if !metadata.is_dir() => {
                    return Err(format!(
                        "model destination parent is not a directory: {}",
                        parent.display()
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&parent)
                        .map_err(|e| format!("create model directory {}: {e}", parent.display()))?;
                }
                Err(error) => {
                    return Err(format!(
                        "inspect model destination parent {}: {error}",
                        parent.display()
                    ));
                }
            }
        }
    }
    let parent_canon = fs::canonicalize(&parent)
        .map_err(|e| format!("canonicalize model directory {}: {e}", parent.display()))?;
    if !parent_canon.starts_with(&root_canon) {
        return Err(format!(
            "model destination is outside the model root: {}",
            destination.display()
        ));
    }

    let destination = parent_canon.join(file_name);
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(format!(
            "model destination already exists: {}",
            destination.display()
        ));
    }
    let mut part = part_path(&destination);
    match fs::symlink_metadata(&part) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(format!(
                "partial model path must be a regular file inside the model root: {}",
                part.display()
            ));
        }
        Ok(_) => {
            part = fs::canonicalize(&part)
                .map_err(|e| format!("canonicalize partial model {}: {e}", part.display()))?;
            if !part.starts_with(&root_canon) {
                return Err(format!(
                    "partial model path is outside the model root: {}",
                    part.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "inspect partial model path {}: {error}",
                part.display()
            ));
        }
    }
    Ok((destination, part))
}

fn part_path(destination: &Path) -> PathBuf {
    let mut path = OsString::from(destination.as_os_str());
    path.push(".part");
    PathBuf::from(path)
}

fn content_range_start(value: &str) -> Option<u64> {
    value
        .strip_prefix("bytes ")?
        .split_once('-')?
        .0
        .parse()
        .ok()
}

fn content_range_total(value: &str) -> Option<u64> {
    value.split_once('/')?.1.parse().ok()
}

fn hash_file(path: &Path, hasher: &mut Sha256) -> Result<(), String> {
    let mut file = File::open(path)
        .map_err(|e| format!("open partial model {} for hashing: {e}", path.display()))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("hash partial model {}: {e}", path.display()))?;
        if count == 0 {
            return Ok(());
        }
        hasher.update(&buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    #[test]
    fn download_resumes_part_file_and_hashes_complete_payload() {
        const BODY: &[u8] = b"The quick brown fox jumps over the lazy dog";
        const SHA256: &str = "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592";
        const RESUME_AT: usize = 10;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models");
        fs::create_dir(&root).unwrap();
        let destination = root.join("model.bin");
        let part = root.join("model.bin.part");
        fs::write(&part, &BODY[..RESUME_AT]).unwrap();
        let mut progress = Vec::new();

        let result = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            None,
            |request| {
                assert_eq!(request.resume_from, RESUME_AT as u64);
                Ok(DownloadResponse {
                    status: StatusCode::PARTIAL_CONTENT,
                    content_range: Some(format!(
                        "bytes {}-{}/{}",
                        RESUME_AT,
                        BODY.len() - 1,
                        BODY.len()
                    )),
                    content_length: Some((BODY.len() - RESUME_AT) as u64),
                    body: Cursor::new(&BODY[RESUME_AT..]),
                })
            },
            |event| progress.push(event),
        )
        .unwrap();

        assert_eq!(fs::read(&destination).unwrap(), BODY);
        assert!(!part.exists());
        assert_eq!(result.sha256, SHA256);
        assert_eq!(result.bytes, BODY.len() as u64);
        assert_eq!(progress.last().unwrap().downloaded, BODY.len() as u64);
        assert_eq!(progress.last().unwrap().total, Some(BODY.len() as u64));
    }

    #[test]
    fn download_rejects_non_https_before_fetching() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models");
        let destination = root.join("model.bin");
        let fetched = AtomicBool::new(false);

        let error = download_model_with_fetch(
            "http://models.example/model.bin",
            &root,
            &destination,
            None,
            |_| {
                fetched.store(true, Ordering::SeqCst);
                Ok(DownloadResponse {
                    status: StatusCode::OK,
                    content_range: None,
                    content_length: Some(0),
                    body: Cursor::new(Vec::<u8>::new()),
                })
            },
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("HTTPS"), "got: {error}");
        assert!(!fetched.load(Ordering::SeqCst));
        assert!(!destination.exists());
    }

    #[test]
    fn redirect_validation_rejects_an_http_hop() {
        let redirect = url::Url::parse("http://cdn.example/model.bin").unwrap();

        let error = validate_redirect(&redirect, 1).unwrap_err();

        assert!(error.contains("HTTPS"), "got: {error}");
    }

    #[test]
    fn download_rejects_traversal_and_absolute_escapes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models");
        fs::create_dir(&root).unwrap();
        let traversal = root.join("nested").join("..").join("model.bin");
        let outside = temp.path().join("outside.bin");

        for destination in [&traversal, &outside] {
            let error = download_model_with_fetch(
                "https://models.example/model.bin",
                &root,
                destination,
                None,
                |_| -> Result<DownloadResponse<Cursor<Vec<u8>>>, String> {
                    panic!("an invalid destination must fail before fetching")
                },
                |_| {},
            )
            .unwrap_err();
            assert!(error.contains("model root"), "got: {error}");
        }
    }

    // M9c threads a user-supplied `model_root` (the storage-location override)
    // straight into `allowed_root` here. These pin the exact garbage/attack
    // inputs that override can now carry: relative paths, empty strings, and
    // (on unix) a root that is itself a symlink — none of which previously
    // had a caller able to reach this code path, since `allowed_root` used to
    // always come from `app_data_dir()`.
    #[test]
    fn download_rejects_a_relative_model_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::path::PathBuf::from("relative/models/dir");
        let destination = temp.path().join("models").join("model.bin");

        let error = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            None,
            |_| -> Result<DownloadResponse<Cursor<Vec<u8>>>, String> {
                panic!("a relative model root must fail before fetching")
            },
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("must be absolute"), "got: {error}");
        assert!(!destination.exists());
    }

    #[test]
    fn download_rejects_an_empty_model_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::path::PathBuf::from("");
        let destination = temp.path().join("models").join("model.bin");

        let error = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            None,
            |_| -> Result<DownloadResponse<Cursor<Vec<u8>>>, String> {
                panic!("an empty model root must fail before fetching")
            },
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("must be absolute"), "got: {error}");
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn download_rejects_a_symlinked_model_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        let root = temp.path().join("models-link");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, &root).unwrap();
        let destination = root.join("model.bin");

        let error = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            None,
            |_| -> Result<DownloadResponse<Cursor<Vec<u8>>>, String> {
                panic!("a symlinked model root must fail before fetching")
            },
            |_| {},
        )
        .unwrap_err();

        assert!(
            error.contains("model root must not be a symlink"),
            "got: {error}"
        );
        assert!(!outside.join("model.bin").exists());
    }

    // A native folder picker can hand back a path with a trailing separator;
    // the root must still canonicalize and confine correctly rather than
    // rejecting a perfectly valid override.
    #[test]
    fn download_allows_a_model_root_with_a_trailing_separator() {
        const BODY: &[u8] = b"trailing separator body";

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models");
        fs::create_dir(&root).unwrap();
        let root_with_slash =
            PathBuf::from(format!("{}{}", root.display(), std::path::MAIN_SEPARATOR));
        let destination = root.join("model.bin");

        let result = download_model_with_fetch(
            "https://models.example/model.bin",
            &root_with_slash,
            &destination,
            None,
            |_| {
                Ok(DownloadResponse {
                    status: StatusCode::OK,
                    content_range: None,
                    content_length: Some(BODY.len() as u64),
                    body: Cursor::new(BODY),
                })
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(fs::read(&destination).unwrap(), BODY);
        assert_eq!(result.bytes, BODY.len() as u64);
    }

    // Unicode directory and file names (accented characters, emoji) must
    // round-trip through canonicalization and confinement without breaking
    // the `starts_with(root_canon)` check.
    #[test]
    fn download_allows_unicode_model_root_and_filename() {
        const BODY: &[u8] = b"unicode body";

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("mödëls-📦");
        fs::create_dir(&root).unwrap();
        let destination = root.join("mödël-checkpoint.bin");

        let result = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            None,
            |_| {
                Ok(DownloadResponse {
                    status: StatusCode::OK,
                    content_range: None,
                    content_length: Some(BODY.len() as u64),
                    body: Cursor::new(BODY),
                })
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(fs::read(&destination).unwrap(), BODY);
        assert_eq!(result.bytes, BODY.len() as u64);
    }

    #[cfg(unix)]
    #[test]
    fn download_rejects_a_symlinked_destination_parent() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        let destination = root.join("linked").join("model.bin");

        let error = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            None,
            |_| -> Result<DownloadResponse<Cursor<Vec<u8>>>, String> {
                panic!("a symlinked parent must fail before fetching")
            },
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("symlinked parent"), "got: {error}");
        assert!(!outside.join("model.bin").exists());
    }

    #[cfg(unix)]
    #[test]
    fn download_rejects_a_symlinked_part_file() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside.part");
        fs::write(&outside, b"outside").unwrap();
        let destination = root.join("model.bin");
        symlink(&outside, root.join("model.bin.part")).unwrap();

        let error = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            None,
            |_| -> Result<DownloadResponse<Cursor<Vec<u8>>>, String> {
                panic!("a symlinked part must fail before fetching")
            },
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("partial model path"), "got: {error}");
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
    }

    #[test]
    fn checksum_mismatch_removes_part_without_installing_destination() {
        const BODY: &[u8] = b"downloaded model bytes";

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models");
        fs::create_dir(&root).unwrap();
        let destination = root.join("model.bin");
        let part = root.join("model.bin.part");

        let error = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
            |_| {
                Ok(DownloadResponse {
                    status: StatusCode::OK,
                    content_range: None,
                    content_length: Some(BODY.len() as u64),
                    body: Cursor::new(BODY),
                })
            },
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("SHA-256 mismatch"), "got: {error}");
        assert!(!part.exists());
        assert!(!destination.exists());
    }

    #[test]
    fn resumed_checksum_mismatch_removes_stale_part() {
        const STALE: &[u8] = b"stale ";
        const TAIL: &[u8] = b"model bytes";

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models");
        fs::create_dir(&root).unwrap();
        let destination = root.join("model.bin");
        let part = root.join("model.bin.part");
        fs::write(&part, STALE).unwrap();

        let error = download_model_with_fetch(
            "https://models.example/model.bin",
            &root,
            &destination,
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
            |_| {
                Ok(DownloadResponse {
                    status: StatusCode::PARTIAL_CONTENT,
                    content_range: Some(format!(
                        "bytes {}-{}/{}",
                        STALE.len(),
                        STALE.len() + TAIL.len() - 1,
                        STALE.len() + TAIL.len()
                    )),
                    content_length: Some(TAIL.len() as u64),
                    body: Cursor::new(TAIL),
                })
            },
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("SHA-256 mismatch"), "got: {error}");
        assert!(!part.exists());
        assert!(!destination.exists());
    }
}
