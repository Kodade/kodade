// Provider detection. Unix keeps the established login-shell probe so profile
// PATH/environment changes apply. Windows resolves a real .exe/.cmd first, then
// executes only that path with the fixed `--version` argument.

use std::path::PathBuf;
#[cfg(windows)]
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

#[cfg(windows)]
use crate::process_tree::{prepare_spawn, terminate_child, ProcessTree};
#[cfg(not(windows))]
use crate::shell::run_shell_command;
use crate::shell::{is_safe_bin, ShellEnvironment};

#[cfg(windows)]
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_CAP: u64 = 64 * 1024;

pub fn detect_version(shell: &ShellEnvironment, bin: &str) -> Option<String> {
    if !is_safe_bin(bin) {
        return None;
    }

    #[cfg(windows)]
    {
        let executable = shell.resolve_executable(bin)?;
        run_direct(&executable, &["--version"], OUTPUT_CAP)
    }
    #[cfg(not(windows))]
    {
        // `bin` contains only the safe bare-name alphabet, so interpolation
        // cannot add syntax to the fixed login-shell command.
        run_shell_command(shell, &format!("{bin} --version"), OUTPUT_CAP)
    }
}

pub fn resolve_binary(shell: &ShellEnvironment, bin: &str) -> Option<PathBuf> {
    shell.resolve_executable(bin)
}

#[cfg(windows)]
fn run_direct(executable: &std::path::Path, args: &[&str], output_cap: u64) -> Option<String> {
    prepare_spawn().ok()?;
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let tree = ProcessTree::attach_child(&child);
    collect_bounded(&mut child, &tree, output_cap)
}

#[cfg(windows)]
fn collect_bounded(
    child: &mut std::process::Child,
    tree: &ProcessTree,
    output_cap: u64,
) -> Option<String> {
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.take(output_cap).read_to_end(&mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).to_string());
    });

    let status = match wait_timeout(child, COMMAND_TIMEOUT) {
        Some(status) => status,
        None => {
            terminate_child(tree, child);
            let _ = child.wait();
            return None;
        }
    };
    if !status.success() {
        return None;
    }
    let output = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    let trimmed = output.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(windows)]
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
    use super::resolve_binary;
    use crate::shell::ShellEnvironment;
    #[cfg(unix)]
    use crate::shell::ShellKind;

    #[cfg(unix)]
    #[test]
    fn resolves_an_absolute_binary_path_through_a_login_shell() {
        let shell = ShellEnvironment::new("/bin/sh".into(), ShellKind::Posix, "/".into());
        let path = resolve_binary(&shell, "sh").expect("sh should resolve");
        assert!(path.is_absolute());
        assert!(path.is_file());
    }

    #[test]
    fn rejects_unsafe_binary_names_before_the_shell_boundary() {
        let shell = ShellEnvironment::current();
        assert!(resolve_binary(&shell, "gh; whoami").is_none());
        assert!(resolve_binary(&shell, r"C:\tools\gh.exe").is_none());
    }
}
