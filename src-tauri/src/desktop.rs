use std::ffi::OsString;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DesktopPlatform {
    #[cfg(any(target_os = "macos", test))]
    MacOs,
    #[cfg(any(target_os = "windows", test))]
    Windows,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DesktopCommand {
    pub(crate) program: &'static str,
    pub(crate) args: Vec<OsString>,
}

// Callers own the URI scheme policy. This builder only preserves the already
// validated URI as one literal process argument on each supported platform.
pub(crate) fn open_uri_command(platform: DesktopPlatform, uri: &str) -> DesktopCommand {
    let program = match platform {
        #[cfg(any(target_os = "macos", test))]
        DesktopPlatform::MacOs => "open",
        #[cfg(any(target_os = "windows", test))]
        DesktopPlatform::Windows => "explorer.exe",
    };
    DesktopCommand {
        program,
        args: vec![OsString::from(uri)],
    }
}

pub(crate) fn spawn(command: DesktopCommand, context: &str) -> Result<(), String> {
    std::process::Command::new(command.program)
        .args(command.args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{open_uri_command, DesktopPlatform};

    #[test]
    fn uri_builders_keep_the_target_in_one_literal_argument() {
        let uri = "obsidian://open?vault=Project%20Vault&file=10-Projects%2Fportable-project%2FProject.md";

        let macos = open_uri_command(DesktopPlatform::MacOs, uri);
        assert_eq!(macos.program, "open");
        assert_eq!(macos.args, vec![OsString::from(uri)]);

        let windows = open_uri_command(DesktopPlatform::Windows, uri);
        assert_eq!(windows.program, "explorer.exe");
        assert_eq!(windows.args, vec![OsString::from(uri)]);
    }
}
