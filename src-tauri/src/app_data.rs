use std::path::PathBuf;

pub const APP_IDENTIFIER: &str = "com.kodade.desktop";

/// Resolve the same per-platform data directory used by the desktop bundle.
pub fn default_app_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = home_dir()?;
        Ok(home
            .join("Library")
            .join("Application Support")
            .join(APP_IDENTIFIER))
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| "APPDATA is not set".to_string())?;
        Ok(base.join(APP_IDENTIFIER))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                home_dir()
                    .ok()
                    .map(|home| home.join(".local").join("share"))
            })
            .ok_or_else(|| "no XDG_DATA_HOME or HOME to resolve the data dir".to_string())?;
        Ok(base.join(APP_IDENTIFIER))
    }
}

#[cfg(not(target_os = "windows"))]
fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}
