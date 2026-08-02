// Shared verified-weight downloader. M9's mature voice implementation remains
// the byte-for-byte engine; this facade gives KödLocal the same HTTPS-only,
// resumable, SHA-256-verified, path-confined transaction instead of creating a
// second download path.

use std::path::Path;

use crate::vox::{VoxDownloadProgress as DownloadProgress, VoxDownloadResult as DownloadResult};

pub(crate) fn download_model(
    url: &str,
    allowed_root: &Path,
    destination: &Path,
    expected_sha256: Option<&str>,
    on_progress: impl FnMut(DownloadProgress),
) -> Result<DownloadResult, String> {
    crate::vox::download::download_model(
        url,
        allowed_root,
        destination,
        expected_sha256,
        on_progress,
    )
}
