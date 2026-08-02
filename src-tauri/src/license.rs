// Shared KödLocal license token persistence. Rust does not inspect tiers or
// features; it only mirrors the already-verified token string into app data so
// the TypeScript CLI can run the same offline verifier outside the webview.

use std::path::Path;

pub const LICENSE_TOKEN_FILE: &str = "kodade-license.token";
const MAX_TOKEN_BYTES: usize = 16 * 1024;

pub fn write_shared_token(data_dir: &Path, token: Option<&str>) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("create app data directory {}: {error}", data_dir.display()))?;
    let path = data_dir.join(LICENSE_TOKEN_FILE);
    let Some(token) = token else {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "remove shared license token {}: {error}",
                path.display()
            )),
        };
    };
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES || token.chars().any(char::is_control) {
        return Err("license token has an invalid length or character".to_string());
    }
    if std::fs::symlink_metadata(&path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "refusing to write shared license token through a symlink: {}",
            path.display()
        ));
    }
    crate::fs::write_file(
        path.to_str()
            .ok_or_else(|| "license token path is not valid UTF-8".to_string())?,
        token,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("secure shared license token {}: {error}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_removes_the_shared_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LICENSE_TOKEN_FILE);
        write_shared_token(dir.path(), Some("payload.signature")).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "payload.signature");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        write_shared_token(dir.path(), None).unwrap();
        assert!(!path.exists());
        write_shared_token(dir.path(), None).unwrap();
    }

    #[test]
    fn rejects_control_characters_and_unbounded_tokens() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_shared_token(dir.path(), Some("bad\nvalue")).is_err());
        assert!(write_shared_token(dir.path(), Some(&"x".repeat(MAX_TOKEN_BYTES + 1))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_follow_a_shared_token_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::write(&outside, "keep").unwrap();
        symlink(&outside, dir.path().join(LICENSE_TOKEN_FILE)).unwrap();
        assert!(write_shared_token(dir.path(), Some("payload.signature")).is_err());
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "keep");
    }
}
