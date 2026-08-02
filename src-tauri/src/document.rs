use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};

use crate::pathguard;

pub const MAX_IMAGE_BYTES: u64 = 10 * 1_024 * 1_024;
pub const MAX_PDF_BYTES: u64 = 25 * 1_024 * 1_024;

#[derive(Clone, Copy)]
pub struct DocumentSpec {
    pub content_type: &'static str,
    pub max_bytes: u64,
}

// The only document types the custom URI handler is permitted to serve.
pub fn document_spec(path: &Path) -> Option<DocumentSpec> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let (content_type, max_bytes) = match extension.as_str() {
        "png" => ("image/png", MAX_IMAGE_BYTES),
        "jpg" | "jpeg" => ("image/jpeg", MAX_IMAGE_BYTES),
        "gif" => ("image/gif", MAX_IMAGE_BYTES),
        "webp" => ("image/webp", MAX_IMAGE_BYTES),
        "svg" => ("image/svg+xml", MAX_IMAGE_BYTES),
        "pdf" => ("application/pdf", MAX_PDF_BYTES),
        _ => return None,
    };
    Some(DocumentSpec {
        content_type,
        max_bytes,
    })
}

pub fn max_document_bytes(path: &str) -> Option<u64> {
    document_spec(Path::new(path)).map(|spec| spec.max_bytes)
}

// Serve a viewer document only when its decoded URL path remains within the
// active project root. This stays pure enough for confinement and response tests.
pub fn serve(active_root: Option<&str>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(root) = active_root else {
        return error_response(StatusCode::FORBIDDEN, "no active project root");
    };
    let path = match document_path(&request.uri().to_string()) {
        Ok(path) => path,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, message),
    };
    let target = match pathguard::confine_document_read(root, &path) {
        Ok(target) => target,
        Err(_) => {
            return error_response(
                StatusCode::FORBIDDEN,
                "document is outside the project root",
            )
        }
    };
    let Some(spec) = document_spec(&target) else {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported document type",
        );
    };
    let mut file = match std::fs::File::open(&target) {
        Ok(file) => file,
        Err(_) => return error_response(StatusCode::NOT_FOUND, "document could not be read"),
    };
    if verify_opened_file_is_confined(root, &file).is_err() {
        return error_response(
            StatusCode::FORBIDDEN,
            "document is outside the project root",
        );
    }
    let metadata = match file.metadata() {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return error_response(StatusCode::NOT_FOUND, "document not found"),
    };
    if metadata.len() > spec.max_bytes {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "document is too large to preview",
        );
    }

    let range = match parse_single_range(
        request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok()),
        metadata.len(),
    ) {
        Ok(range) => range,
        Err(()) => return range_not_satisfiable(metadata.len()),
    };
    let mut bytes = Vec::new();
    let status = if let Some((start, end)) = range {
        let range_len = end - start + 1;
        let read_result = file
            .seek(SeekFrom::Start(start))
            .and_then(|_| file.take(range_len).read_to_end(&mut bytes));
        if read_result.is_err() || bytes.len() as u64 != range_len {
            return error_response(StatusCode::NOT_FOUND, "document could not be read");
        }
        StatusCode::PARTIAL_CONTENT
    } else {
        if file
            .take(spec.max_bytes + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return error_response(StatusCode::NOT_FOUND, "document could not be read");
        }
        if bytes.len() as u64 > spec.max_bytes {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "document is too large to preview",
            );
        }
        StatusCode::OK
    };

    let response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, spec.content_type)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header("X-Content-Type-Options", "nosniff");
    let response = if let Some((start, end)) = range {
        response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", metadata.len()),
        )
    } else {
        response
    };
    response
        .body(bytes)
        .expect("static document response is valid")
}

// Parse the one range shape PDFKit uses for seeking. We intentionally reject
// suffix and multi-range requests instead of returning a partial approximation.
fn parse_single_range(range: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(range) = range else {
        return Ok(None);
    };
    let Some(spec) = range.strip_prefix("bytes=") else {
        return Err(());
    };
    if spec.contains(',') {
        return Err(());
    }
    let Some((start, end)) = spec.split_once('-') else {
        return Err(());
    };
    if start.is_empty() {
        return Err(());
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= len {
        return Err(());
    }
    let end = if end.is_empty() {
        len - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?
    };
    if end < start || end >= len {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn range_not_satisfiable(len: u64) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{len}"))
        .body(Vec::new())
        .expect("static document response is valid")
}

fn verify_opened_file_is_confined(root: &str, file: &std::fs::File) -> Result<(), String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        let opened_path = opened_file_path(file)?;
        let root = std::fs::canonicalize(root)
            .map_err(|e| format!("project root is unavailable: {root}: {e}"))?;
        opened_path_is_inside(&opened_path, &root)
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        let _ = (root, file);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn opened_path_is_inside(opened: &Path, root: &Path) -> Result<(), String> {
    if opened != root && opened.starts_with(root) {
        Ok(())
    } else {
        Err("opened document is outside the project root".to_string())
    }
}

#[cfg(windows)]
fn opened_path_is_inside(opened: &Path, root: &Path) -> Result<(), String> {
    let opened = windows_comparison_path(opened);
    let root = windows_comparison_path(root);
    if opened.len() > root.len()
        && windows_ordinal_eq(&opened[..root.len()], &root)
        && opened.get(root.len()) == Some(&(b'\\' as u16))
    {
        Ok(())
    } else {
        Err("opened document is outside the project root".to_string())
    }
}

#[cfg(windows)]
fn windows_comparison_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut path = path.as_os_str().encode_wide().collect::<Vec<_>>();
    for unit in &mut path {
        if *unit == b'/' as u16 {
            *unit = b'\\' as u16;
        }
    }
    let unc_prefix = "\\\\?\\UNC\\".encode_utf16().collect::<Vec<_>>();
    let verbatim_prefix = "\\\\?\\".encode_utf16().collect::<Vec<_>>();
    if starts_with_ascii_case_insensitive(&path, &unc_prefix) {
        path.splice(..unc_prefix.len(), [b'\\' as u16, b'\\' as u16]);
    } else if starts_with_ascii_case_insensitive(&path, &verbatim_prefix) {
        path.drain(..verbatim_prefix.len());
    }
    while path.last() == Some(&(b'\\' as u16)) {
        path.pop();
    }
    path
}

#[cfg(windows)]
fn starts_with_ascii_case_insensitive(value: &[u16], prefix: &[u16]) -> bool {
    fn ascii_lower(unit: u16) -> u16 {
        if (b'A' as u16..=b'Z' as u16).contains(&unit) {
            unit + (b'a' - b'A') as u16
        } else {
            unit
        }
    }

    value.len() >= prefix.len()
        && value[..prefix.len()]
            .iter()
            .zip(prefix)
            .all(|(left, right)| ascii_lower(*left) == ascii_lower(*right))
}

#[cfg(windows)]
fn windows_ordinal_eq(left: &[u16], right: &[u16]) -> bool {
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};

    if left.len() > i32::MAX as usize || right.len() > i32::MAX as usize {
        return false;
    }
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        ) == CSTR_EQUAL
    }
}

#[cfg(windows)]
fn opened_file_path(file: &std::fs::File) -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, FILE_NAME_OPENED, VOLUME_NAME_DOS,
    };

    let handle = file.as_raw_handle();
    let read_path = |flags| -> std::io::Result<std::path::PathBuf> {
        let mut buffer = vec![0_u16; 32_768];
        let mut written = unsafe {
            GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, flags)
        };
        if written == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if written as usize >= buffer.len() {
            buffer.resize(written as usize + 1, 0);
            written = unsafe {
                GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, flags)
            };
            if written == 0 || written as usize >= buffer.len() {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..written as usize],
        )))
    };

    match read_path(FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) {
        Ok(path) => Ok(path),
        // SMB cannot answer normalized component queries without traverse
        // access to every ancestor. FILE_NAME_OPENED still describes the fully
        // resolved handle, but retains the spelling used to open components;
        // the lossless ordinal comparison below handles case without weakening
        // the final-object proof. Alias/8.3 spelling can conservatively deny.
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            read_path(FILE_NAME_OPENED | VOLUME_NAME_DOS).map_err(|fallback| {
                format!(
                    "GetFinalPathNameByHandleW failed: {error}; opened-name fallback failed: {fallback}"
                )
            })
        }
        Err(error) => Err(format!("GetFinalPathNameByHandleW failed: {error}")),
    }
}

#[cfg(target_os = "macos")]
fn opened_file_path(file: &std::fs::File) -> Result<std::path::PathBuf, String> {
    use std::ffi::CStr;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    let mut buffer = [0 as libc::c_char; libc::MAXPATHLEN as usize];
    // SAFETY: `file` owns a valid descriptor for this call, and `buffer` is a
    // writable MAXPATHLEN allocation as required by macOS F_GETPATH.
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if result == -1 {
        return Err(format!(
            "F_GETPATH failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: F_GETPATH writes a NUL-terminated path on success.
    let path = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    Ok(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(
        path.to_bytes(),
    )))
}

fn document_path(request_uri: &str) -> Result<String, &'static str> {
    let url = url::Url::parse(request_uri).map_err(|_| "invalid document URL")?;
    url.query_pairs()
        .find_map(|(name, value)| (name == "path").then(|| value.into_owned()))
        .filter(|path| !path.is_empty())
        .ok_or("missing document path")
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("static error response is valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tauri::http::{header, StatusCode};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kodade-document-{tag}-{}", std::process::id()));
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

    #[test]
    fn serves_an_image_inside_the_active_root_with_its_content_type() {
        let root = temp_dir("inside");
        let image = root.join("diagram.png");
        std::fs::write(&image, b"png bytes").unwrap();

        let response = serve(Some(root.to_str().unwrap()), &request_for(&image));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.body(), b"png bytes");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_a_dotdot_path_outside_the_active_root() {
        let base = temp_dir("dotdot");
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        let outside = base.join("outside.png");
        std::fs::write(&outside, b"not for the viewer").unwrap();
        let escape = root.join("..").join("outside.png");

        let response = serve(Some(root.to_str().unwrap()), &request_for(&escape));

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_file_symlink_that_points_outside_the_active_root() {
        use std::os::unix::fs::symlink;

        let base = temp_dir("symlink");
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        let outside = base.join("outside.png");
        std::fs::write(&outside, b"not for the viewer").unwrap();
        let link = root.join("outside.png");
        symlink(&outside, &link).unwrap();

        let response = serve(Some(root.to_str().unwrap()), &request_for(&link));

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_documents_over_the_viewer_cap() {
        let root = temp_dir("oversize");
        let image = root.join("large.png");
        std::fs::File::create(&image)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();

        let response = serve(Some(root.to_str().unwrap()), &request_for(&image));

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn serves_pdfs_with_the_pdf_content_type() {
        let root = temp_dir("pdf");
        let pdf = root.join("drawing.pdf");
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();

        let response = serve(Some(root.to_str().unwrap()), &request_for(&pdf));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/pdf");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn serves_a_single_pdf_byte_range() {
        let root = temp_dir("pdf-range");
        let pdf = root.join("drawing.pdf");
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();
        let mut request = request_for(&pdf);
        request
            .headers_mut()
            .insert(header::RANGE, "bytes=5-".parse().unwrap());

        let response = serve(Some(root.to_str().unwrap()), &request);

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 5-7/8");
        assert_eq!(response.body(), b"1.7");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn opened_file_path_returns_the_real_opened_document_path() {
        let root = temp_dir("opened-fd");
        let image = root.join("diagram.png");
        std::fs::write(&image, b"png bytes").unwrap();
        let file = std::fs::File::open(&image).unwrap();

        let opened_path = opened_file_path(&file).expect("the OS must describe an open file");

        assert!(opened_path.is_absolute());
        assert!(opened_path.ends_with("diagram.png"));
        verify_opened_file_is_confined(root.to_str().unwrap(), &file)
            .expect("the opened in-root document remains confined");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn opened_handle_confinement_rejects_a_file_outside_the_root() {
        let base = temp_dir("opened-outside");
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        let outside = base.join("outside.png");
        std::fs::write(&outside, b"not for the viewer").unwrap();
        let file = std::fs::File::open(&outside).unwrap();

        verify_opened_file_is_confined(root.to_str().unwrap(), &file)
            .expect_err("the final path from the opened handle must remain confined");
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn windows_opened_path_comparison_is_verbatim_case_insensitive_and_component_aware() {
        assert!(opened_path_is_inside(
            Path::new(r"\\?\C:\Work\Repo\assets\plan.png"),
            Path::new(r"c:\work\repo")
        )
        .is_ok());
        assert!(opened_path_is_inside(
            Path::new(r"\\?\UNC\Server\Share\Repo\plan.png"),
            Path::new(r"\\server\share\repo")
        )
        .is_ok());
        assert!(opened_path_is_inside(
            Path::new(r"C:\Work\Repository\plan.png"),
            Path::new(r"C:\Work\Repo")
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_opened_path_comparison_does_not_lossily_alias_unpaired_surrogates() {
        use std::os::windows::ffi::OsStringExt;

        let mut root = r"C:\Work\Repo\".encode_utf16().collect::<Vec<_>>();
        root.push(0xd800);
        let root = PathBuf::from(std::ffi::OsString::from_wide(&root));
        let mut opened = r"C:\Work\Repo\".encode_utf16().collect::<Vec<_>>();
        opened.push(0xd801);
        opened.extend(r"\plan.png".encode_utf16());
        let opened = PathBuf::from(std::ffi::OsString::from_wide(&opened));

        assert!(opened_path_is_inside(&opened, &root).is_err());
    }

    #[test]
    fn parses_closed_and_open_ended_single_ranges() {
        assert_eq!(parse_single_range(Some("bytes=2-5"), 10), Ok(Some((2, 5))));
        assert_eq!(parse_single_range(Some("bytes=7-"), 10), Ok(Some((7, 9))));
    }

    #[test]
    fn rejects_unsatisfiable_and_multi_ranges() {
        assert!(parse_single_range(Some("bytes=10-"), 10).is_err());
        assert!(parse_single_range(Some("bytes=0-1,4-5"), 10).is_err());
    }
}
