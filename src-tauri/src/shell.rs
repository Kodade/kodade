// Cross-platform shell environment. This is the single source of truth for
// shell selection, profile-aware command invocation, home-directory fallback,
// display names, and safe executable lookup.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crate::process_tree::{prepare_spawn, terminate_child, ProcessTree};

const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
const RESOLVE_OUTPUT_CAP: u64 = 64 * 1024;
#[cfg(unix)]
const POSIX_RESOLVE_AND_PATH_PROBE: &str =
    "resolved=$(command -v \"$1\") || exit 1; printf '\\0%s\\0%s\\0' \"$resolved\" \"$PATH\"";
#[cfg(any(windows, test))]
const WINDOWS_EXTENSIONS: &[&str] = &[".exe", ".cmd"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellKind {
    Posix,
    PowerShell,
    Cmd,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellEnvironment {
    executable: PathBuf,
    kind: ShellKind,
    home: PathBuf,
}

impl ShellEnvironment {
    // Discover the user's platform shell. Unix preserves the existing $SHELL
    // contract; Windows prefers modern PowerShell, then Windows PowerShell,
    // then ComSpec/cmd.exe.
    pub fn current() -> Self {
        #[cfg(windows)]
        {
            select_windows_shell(
                find_windows_executable,
                windows_env_value("ComSpec").map(PathBuf::from),
                windows_home(),
            )
        }
        #[cfg(not(windows))]
        {
            let executable = std::env::var_os("SHELL")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
            let home = std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/"));
            Self::new(executable, ShellKind::Posix, home)
        }
    }

    // Explicit construction is useful to deterministic integration tests and
    // to callers that already selected a shell through application settings.
    pub fn new(executable: PathBuf, kind: ShellKind, home: PathBuf) -> Self {
        Self {
            executable,
            kind,
            home,
        }
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn kind(&self) -> ShellKind {
        self.kind
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn display_name(&self) -> String {
        self.executable
            .file_stem()
            .or_else(|| self.executable.file_name())
            .and_then(OsStr::to_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(match self.kind {
                ShellKind::Posix => "zsh",
                ShellKind::PowerShell => "powershell",
                ShellKind::Cmd => "cmd",
            })
            .to_string()
    }

    // Arguments for a long-lived interactive PTY. PowerShell profiles load by
    // default; -NoLogo only removes the banner. cmd receives no flags so its
    // normal prompt and AutoRun behavior remain the user's own.
    pub fn interactive_args(&self) -> Vec<OsString> {
        match self.kind {
            ShellKind::Posix => vec![OsString::from("-l")],
            ShellKind::PowerShell => vec![OsString::from("-NoLogo")],
            ShellKind::Cmd => Vec::new(),
        }
    }

    // Arguments for one bounded, non-interactive profile-aware command. PowerShell
    // still loads the user's profile, while -NonInteractive prevents a profile or
    // probe from stopping to request input. Callers may only build `command` from
    // fixed text and names accepted by is_safe_bin.
    pub(crate) fn command_args(&self, command: &str) -> Vec<OsString> {
        match self.kind {
            ShellKind::Posix => vec!["-l".into(), "-c".into(), command.into()],
            ShellKind::PowerShell => vec![
                "-NoLogo".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                command.into(),
            ],
            // /D prevents registry AutoRun commands from mutating a bounded probe;
            // /S gives /C one predictable command-string parsing mode.
            ShellKind::Cmd => vec!["/D".into(), "/S".into(), "/C".into(), command.into()],
        }
    }

    // Resolve a validated bare executable through the selected shell profile,
    // returning only an existing absolute file. This supports npm .cmd shims on
    // Windows without accepting caller-supplied paths or shell syntax.
    pub fn resolve_executable(&self, bin: &str) -> Option<PathBuf> {
        if !is_safe_bin(bin) {
            return None;
        }

        let command = match self.kind {
            ShellKind::Posix => format!("command -v {bin}"),
            ShellKind::PowerShell => powershell_resolve_command(bin),
            ShellKind::Cmd => format!("where.exe {bin}"),
        };
        let resolved = run_shell_command(self, &command, RESOLVE_OUTPUT_CAP)
            .and_then(|output| existing_absolute_line(&output));
        #[cfg(windows)]
        {
            resolved.or_else(|| find_windows_executable(bin))
        }
        #[cfg(not(windows))]
        {
            resolved
        }
    }

    // Resolve a headless provider and capture only the PATH from that exact
    // login-shell invocation. The provider name is positional data; the probe
    // text is fixed, bounded, and cannot be extended with caller shell text.
    pub fn resolve_executable_with_login_path(
        &self,
        bin: &str,
    ) -> Option<(PathBuf, Option<OsString>)> {
        if !is_safe_bin(bin) {
            return None;
        }

        #[cfg(unix)]
        if self.kind == ShellKind::Posix {
            let mut args = self.command_args(POSIX_RESOLVE_AND_PATH_PROBE);
            // POSIX `sh -c` assigns the first extra argument to $0 and the
            // second to $1, keeping `bin` out of the command string.
            args.push("kodade-resolve".into());
            args.push(bin.into());
            let output = run_shell_args(self, &args, RESOLVE_OUTPUT_CAP)?;
            return parse_posix_resolve_and_path(&output);
        }

        // Keep the established PowerShell/cmd lookup and child environment on
        // Windows. The packaged-app PATH mismatch addressed here is POSIX-only.
        self.resolve_executable(bin).map(|path| (path, None))
    }
}

fn powershell_resolve_command(bin: &str) -> String {
    format!(
        "$c = Get-Command -Name '{bin}' -CommandType Application,ExternalScript \
         -ErrorAction SilentlyContinue | \
         Where-Object {{ [IO.Path]::GetExtension($_.Source) -in @('.exe', '.cmd') }} | \
         Select-Object -First 1; if ($c) {{ $c.Source }}"
    )
}

pub fn is_safe_bin(bin: &str) -> bool {
    !bin.is_empty()
        && bin != "."
        && bin != ".."
        && bin
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub(crate) fn run_shell_command(
    shell: &ShellEnvironment,
    command: &str,
    output_cap: u64,
) -> Option<String> {
    let output = run_shell_args(shell, &shell.command_args(command), output_cap)?;
    let output = String::from_utf8_lossy(&output);
    let trimmed = output.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn run_shell_args(shell: &ShellEnvironment, args: &[OsString], output_cap: u64) -> Option<Vec<u8>> {
    let mut cmd = Command::new(shell.executable());
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    prepare_spawn().ok()?;
    let mut child = cmd.spawn().ok()?;
    let tree = ProcessTree::attach_child(&child);
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout
            .take(output_cap.saturating_add(1))
            .read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let status = match wait_timeout(&mut child, RESOLVE_TIMEOUT) {
        Some(status) => status,
        None => {
            terminate_child(&tree, &mut child);
            let _ = child.wait();
            return None;
        }
    };
    if !status.success() {
        return None;
    }
    let output = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    ((output.len() as u64) <= output_cap).then_some(output)
}

#[cfg(unix)]
fn parse_posix_resolve_and_path(output: &[u8]) -> Option<(PathBuf, Option<OsString>)> {
    use std::os::unix::ffi::OsStringExt;

    // Profile output may precede the probe. Read only the final three NUL
    // delimiters emitted by the fixed command: executable, PATH, terminator.
    let end = output.iter().rposition(|byte| *byte == 0)?;
    let path_start = output[..end].iter().rposition(|byte| *byte == 0)?;
    let executable_start = output[..path_start].iter().rposition(|byte| *byte == 0)?;
    let executable = PathBuf::from(OsString::from_vec(
        output[executable_start + 1..path_start].to_vec(),
    ));
    let path = OsString::from_vec(output[path_start + 1..end].to_vec());
    if !executable.is_absolute()
        || !executable.is_file()
        || !supported_resolved_path(&executable)
        || path.is_empty()
    {
        return None;
    }
    Some((executable, Some(path)))
}

fn existing_absolute_line(output: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        existing_absolute_windows_line(output)
    }
    #[cfg(not(windows))]
    output.lines().find_map(|line| {
        let path = PathBuf::from(line.trim());
        (path.is_absolute() && path.is_file() && supported_resolved_path(&path)).then_some(path)
    })
}

#[cfg(any(windows, test))]
fn existing_absolute_windows_line(output: &str) -> Option<PathBuf> {
    output.lines().find_map(|line| {
        let path = PathBuf::from(line.trim());
        (path.is_absolute() && path.is_file() && supported_windows_resolved_path(&path))
            .then_some(path)
    })
}

#[cfg(any(windows, test))]
fn supported_windows_resolved_path(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "exe" | "cmd"))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn supported_resolved_path(_path: &Path) -> bool {
    true
}

#[cfg(windows)]
fn windows_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            Some(PathBuf::from(drive).join(path))
        })
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from(r"C:\"))
}

#[cfg(any(windows, test))]
fn select_windows_shell(
    mut find: impl FnMut(&str) -> Option<PathBuf>,
    comspec: Option<PathBuf>,
    home: PathBuf,
) -> ShellEnvironment {
    if let Some(path) = find("pwsh.exe") {
        return ShellEnvironment::new(path, ShellKind::PowerShell, home);
    }
    if let Some(path) = find("powershell.exe") {
        return ShellEnvironment::new(path, ShellKind::PowerShell, home);
    }
    let executable = comspec
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| find("cmd.exe"))
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    ShellEnvironment::new(executable, ShellKind::Cmd, home)
}

#[cfg(windows)]
fn find_windows_executable(bin: &str) -> Option<PathBuf> {
    if !is_safe_bin(bin) {
        return None;
    }
    let dirs = windows_env_value("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    let extensions = windows_extensions(windows_env_value("PATHEXT").as_deref());
    resolve_in_dirs(bin, &dirs, &extensions)
}

#[cfg(windows)]
fn windows_env_value(name: &str) -> Option<OsString> {
    windows_env_value_from(std::env::vars_os(), name)
}

#[cfg(any(windows, test))]
fn windows_env_value_from(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
    name: &str,
) -> Option<OsString> {
    variables.into_iter().find_map(|(key, value)| {
        key.to_string_lossy()
            .eq_ignore_ascii_case(name)
            .then_some(value)
    })
}

#[cfg(any(windows, test))]
fn windows_extensions(pathext: Option<&OsStr>) -> Vec<String> {
    let mut parsed = pathext
        .and_then(OsStr::to_str)
        .map(|value| {
            value
                .split(';')
                .filter_map(|extension| {
                    let extension = extension.trim().to_ascii_lowercase();
                    WINDOWS_EXTENSIONS
                        .contains(&extension.as_str())
                        .then_some(extension)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // npm agent CLIs commonly install `.cmd` launchers. Keep both supported
    // types available even under a hand-edited PATHEXT that omits one of them.
    for extension in WINDOWS_EXTENSIONS {
        if !parsed.iter().any(|candidate| candidate == extension) {
            parsed.push((*extension).to_string());
        }
    }
    parsed
}

#[cfg(any(windows, test))]
fn resolve_in_dirs(bin: &str, dirs: &[PathBuf], extensions: &[String]) -> Option<PathBuf> {
    if !is_safe_bin(bin) {
        return None;
    }
    let explicit_extension = Path::new(bin)
        .extension()
        .and_then(OsStr::to_str)
        .map(|ext| format!(".{}", ext.to_ascii_lowercase()));
    let candidates = match explicit_extension {
        Some(extension) if WINDOWS_EXTENSIONS.contains(&extension.as_str()) => {
            vec![bin.to_string()]
        }
        Some(_) => return None,
        None => extensions
            .iter()
            .map(|extension| format!("{bin}{extension}"))
            .collect(),
    };
    dirs.iter()
        .flat_map(|dir| candidates.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

fn wait_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Option<std::process::ExitStatus> {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kodade-shell-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn windows_prefers_pwsh_then_powershell_then_comspec() {
        let home = PathBuf::from(r"C:\Users\Keith");
        let pwsh = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
        let powershell =
            PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        let cmd = PathBuf::from(r"C:\Windows\System32\cmd.exe");

        let selected = select_windows_shell(
            |name| match name {
                "pwsh.exe" => Some(pwsh.clone()),
                "powershell.exe" => Some(powershell.clone()),
                _ => None,
            },
            Some(cmd.clone()),
            home.clone(),
        );
        assert_eq!(selected.executable(), pwsh);
        assert_eq!(selected.kind(), ShellKind::PowerShell);
        assert_eq!(selected.home(), home);

        let selected = select_windows_shell(
            |name| (name == "powershell.exe").then(|| powershell.clone()),
            Some(cmd.clone()),
            home.clone(),
        );
        assert_eq!(selected.executable(), powershell);

        let selected = select_windows_shell(|_| None, Some(cmd.clone()), home);
        assert_eq!(selected.executable(), cmd);
        assert_eq!(selected.kind(), ShellKind::Cmd);
    }

    #[test]
    fn windows_environment_lookup_accepts_path_key_casing() {
        let variables = vec![(OsString::from("Path"), OsString::from("profile-bin"))];
        assert_eq!(
            windows_env_value_from(variables, "PATH"),
            Some(OsString::from("profile-bin"))
        );
    }

    #[test]
    fn invocation_contract_loads_profiles_without_interactive_prompts() {
        let home = PathBuf::from("home");
        let posix = ShellEnvironment::new("/bin/zsh".into(), ShellKind::Posix, home.clone());
        assert_eq!(posix.interactive_args(), vec![OsString::from("-l")]);
        assert_eq!(
            posix.command_args("echo ok"),
            vec![
                OsString::from("-l"),
                OsString::from("-c"),
                OsString::from("echo ok")
            ]
        );

        let powershell =
            ShellEnvironment::new("pwsh.exe".into(), ShellKind::PowerShell, home.clone());
        assert_eq!(
            powershell.interactive_args(),
            vec![OsString::from("-NoLogo")]
        );
        assert_eq!(
            powershell.command_args("Write-Output ok"),
            vec![
                OsString::from("-NoLogo"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from("Write-Output ok")
            ]
        );

        let cmd = ShellEnvironment::new("cmd.exe".into(), ShellKind::Cmd, home);
        assert!(cmd.interactive_args().is_empty());
        assert_eq!(
            cmd.command_args("where.exe gh"),
            vec![
                OsString::from("/D"),
                OsString::from("/S"),
                OsString::from("/C"),
                OsString::from("where.exe gh")
            ]
        );
    }

    #[test]
    fn windows_path_lookup_supports_spaces_unicode_and_cmd_shims() {
        let root = temp_dir("windows-path");
        let bin_dir = root.join("Program Files").join("Kødade Tools");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let shim = bin_dir.join("claude.cmd");
        std::fs::write(&shim, "@echo off\r\n").unwrap();

        let found = resolve_in_dirs(
            "claude",
            std::slice::from_ref(&bin_dir),
            &[".exe".to_string(), ".cmd".to_string()],
        );
        assert_eq!(found.as_deref(), Some(shim.as_path()));
        assert_eq!(
            resolve_in_dirs(
                "claude.cmd",
                std::slice::from_ref(&bin_dir),
                &[".exe".to_string(), ".cmd".to_string()]
            )
            .as_deref(),
            Some(shim.as_path())
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn powershell_filters_unsupported_shims_before_selecting_a_command() {
        let command = powershell_resolve_command("claude");
        let filter = command
            .find("Where-Object")
            .expect("PowerShell lookup should filter candidates");
        let select = command
            .find("Select-Object")
            .expect("PowerShell lookup should select one candidate");
        assert!(
            filter < select,
            "candidate filtering must happen before selection"
        );
        assert!(command.contains("@('.exe', '.cmd')"));

        let root = temp_dir("powershell-shim-order");
        let script = root.join("claude.ps1");
        let shim = root.join("claude.cmd");
        std::fs::write(&script, "Write-Output hidden").unwrap();
        std::fs::write(&shim, "@echo off\r\n").unwrap();
        let candidates = format!("{}\n{}\n", script.display(), shim.display());
        assert_eq!(
            existing_absolute_windows_line(&candidates).as_deref(),
            Some(shim.as_path())
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn executable_names_cannot_cross_the_shell_boundary() {
        for value in [
            "",
            ".",
            "..",
            "claude;whoami",
            "claude && whoami",
            "$(whoami)",
            "../claude",
            r"C:\tools\claude.exe",
        ] {
            assert!(!is_safe_bin(value), "accepted {value:?}");
        }
        for value in ["claude", "codex-cli", "gh.exe", "claude.cmd"] {
            assert!(is_safe_bin(value), "rejected {value:?}");
        }
    }

    #[test]
    fn display_name_removes_the_executable_extension() {
        let shell = ShellEnvironment::new(
            PathBuf::from("/Program Files/PowerShell/pwsh.exe"),
            ShellKind::PowerShell,
            PathBuf::from("/home/Keith"),
        );
        assert_eq!(shell.display_name(), "pwsh");
    }

    #[test]
    fn pathext_keeps_only_supported_directly_executable_types() {
        assert_eq!(
            windows_extensions(Some(OsStr::new(".COM;.EXE;.BAT;.CMD;.PS1"))),
            vec![".exe".to_string(), ".cmd".to_string()]
        );
        assert_eq!(
            windows_extensions(Some(OsStr::new(".EXE"))),
            vec![".exe".to_string(), ".cmd".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn paired_profile_probe_parses_chatter_and_rejects_truncation() {
        use std::os::unix::ffi::OsStrExt;

        let root = temp_dir("paired-profile-probe");
        let executable = root.join("provider");
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        let profile_path = b"/profile/bin:/usr/bin";
        let mut output = b"profile chatter\n\0".to_vec();
        output.extend_from_slice(executable.as_os_str().as_bytes());
        output.push(0);
        output.extend_from_slice(profile_path);
        output.push(0);

        let (parsed_executable, parsed_path) = parse_posix_resolve_and_path(&output).unwrap();
        assert_eq!(parsed_executable, executable);
        assert_eq!(parsed_path.unwrap().as_bytes(), profile_path);

        output.pop();
        assert!(parse_posix_resolve_and_path(&output).is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn bounded_shell_capture_rejects_output_above_the_cap() {
        let shell = ShellEnvironment::new("/bin/sh".into(), ShellKind::Posix, "/".into());
        let args = shell.command_args("printf 12345");
        assert!(run_shell_args(&shell, &args, 4).is_none());
    }
}
