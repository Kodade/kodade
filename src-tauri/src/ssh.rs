// KödSSH foundations (M11a): locate the user's `ssh` executable and provide
// one guarded, read-only file read confined to ~/.ssh. Rust never parses ssh
// config content — TypeScript (src/ssh/config.ts, src/store/ssh.ts) owns all
// Host/Include parsing and resolution, matching the plan's "Rust stays thin"
// rule.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::process_tree::{prepare_spawn, terminate_child, ProcessTree};
use crate::shell::ShellEnvironment;

const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_CAP: u64 = 64 * 1024;
// Per-stream cap for ssh_exec output (detection/listing). Larger than the
// version probe's cap because a directory listing (M11d) can be sizeable; a
// `command -v` probe is tiny. Output beyond the cap is dropped and flagged.
const EXEC_OUTPUT_CAP: u64 = 512 * 1024;

// Mirrors the TS SshDetectResult (serde camelCase).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshDetectResult {
    pub path: String,
    pub version: String,
}

// Result of a bounded non-PTY ssh_exec. Mirrors the TS SshExecResult (serde
// camelCase). `status` is the remote command's exit code (None if the local
// ssh was killed by a signal); `truncated` is set when either stream exceeded
// EXEC_OUTPUT_CAP.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshExecResult {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

// --- ssh_detect ---

// Resolve `ssh` through the same login-shell mechanism detect_provider uses
// (so PATH matches the user's real environment, and npm-style shims resolve
// on Windows), then run `ssh -V` for a version string. Unlike detect_provider,
// this doesn't reuse detect::detect_version: OpenSSH famously prints its
// version to STDERR (and some builds exit non-zero doing it), so the probe
// here captures both streams and never gates on exit status.
pub fn detect(shell: &ShellEnvironment) -> Result<SshDetectResult, String> {
    let executable = shell
        .resolve_executable("ssh")
        .ok_or_else(|| "ssh was not found on PATH".to_string())?;
    let version = run_version_probe(&executable).unwrap_or_default();
    Ok(SshDetectResult {
        path: executable.to_string_lossy().to_string(),
        version,
    })
}

fn run_version_probe(executable: &Path) -> Option<String> {
    prepare_spawn().ok()?;
    let mut child = Command::new(executable)
        .arg("-V")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let tree = ProcessTree::attach_child(&child);
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;

    let (out_tx, out_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.take(OUTPUT_CAP).read_to_end(&mut buf);
        let _ = out_tx.send(String::from_utf8_lossy(&buf).to_string());
    });
    let (err_tx, err_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.take(OUTPUT_CAP).read_to_end(&mut buf);
        let _ = err_tx.send(String::from_utf8_lossy(&buf).to_string());
    });

    if wait_timeout(&mut child, VERSION_TIMEOUT).is_none() {
        terminate_child(&tree, &mut child);
        let _ = child.wait();
        return None;
    }
    let out = out_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();
    let err = err_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();
    // `ssh -V` writes to stderr; fall back to stdout in case a build differs.
    let combined = if !err.trim().is_empty() { err } else { out };
    let trimmed = combined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
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

// --- ssh_exec ---

// A conservative host allowlist mirroring the TS validator in
// src/ssh/command.ts (validateAlias): the host must start with an alphanumeric
// (so a leading `-` can't be read as an ssh/getopt flag) and contain only
// [A-Za-z0-9._@:-]. This is defense in depth — argv construction and remote
// quoting are decided and tested in TypeScript; Rust just enforces this bound
// and runs the binary with a discrete-argument vector (no local shell).
fn host_is_allowed(host: &str) -> bool {
    let mut chars = host.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    host.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | ':' | '-'))
}

// Bounded non-PTY exec of `ssh -o BatchMode=yes <host> -- <argv…>`. `argv` is
// passed as discrete process arguments to std::process::Command and is NEVER
// interpolated into a local shell string, so there is no local injection
// surface (remote-side quoting lives in src/ssh/command.ts). Output is capped
// per stream and a hard timeout kills the child. Used by remote provider
// detection (M11c) and the remote file tree (M11d).
pub fn exec(
    shell: &ShellEnvironment,
    host: &str,
    argv: &[String],
    timeout_ms: u64,
) -> Result<SshExecResult, String> {
    if !host_is_allowed(host) {
        return Err(format!("refusing to ssh to an invalid host: {host}"));
    }
    let executable = shell
        .resolve_executable("ssh")
        .ok_or_else(|| "ssh was not found on PATH".to_string())?;
    run_exec(&executable, host, argv, Duration::from_millis(timeout_ms))
}

// The testable core: run an already-resolved ssh binary. Tests fake `ssh` with
// a small script (unix only) so the timeout/cap behavior is exercised without a
// network.
fn run_exec(
    executable: &Path,
    host: &str,
    argv: &[String],
    timeout: Duration,
) -> Result<SshExecResult, String> {
    prepare_spawn().map_err(|e| format!("spawn preparation failed: {e}"))?;
    let mut cmd = Command::new(executable);
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg(host)
        .arg("--")
        .args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Give the child (and any remote-side helper it spawns locally, plus the
    // reader pipeline in the fake-ssh tests) its own process group so a timeout
    // kill via `kill(-pid)` reaches the whole tree — same discipline as
    // run_shell_command.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn ssh: {e}"))?;
    let tree = ProcessTree::attach_child(&child);
    let stdout = child.stdout.take().ok_or("ssh stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("ssh stderr unavailable")?;

    // Reader threads DRAIN each stream fully (so the child can exit rather than
    // block on a full pipe) while retaining only the first EXEC_OUTPUT_CAP bytes
    // and flagging truncation.
    let out_rx = spawn_capped_reader(stdout);
    let err_rx = spawn_capped_reader(stderr);

    let status = match wait_timeout(&mut child, timeout) {
        Some(status) => status,
        None => {
            terminate_child(&tree, &mut child);
            let _ = child.wait();
            return Err(format!(
                "ssh_exec timed out after {}ms",
                timeout.as_millis()
            ));
        }
    };

    let (out_bytes, out_trunc) = out_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();
    let (err_bytes, err_trunc) = err_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();
    Ok(SshExecResult {
        status: status.code(),
        stdout: String::from_utf8_lossy(&out_bytes).to_string(),
        stderr: String::from_utf8_lossy(&err_bytes).to_string(),
        truncated: out_trunc || err_trunc,
    })
}

// Drain `reader` on a thread, keeping at most EXEC_OUTPUT_CAP bytes and
// reporting whether more than that arrived. Draining fully avoids deadlocking a
// child that writes past the cap.
fn spawn_capped_reader<R: Read + Send + 'static>(mut reader: R) -> mpsc::Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut total: u64 = 0;
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    total += n as u64;
                    let have = kept.len() as u64;
                    if have < EXEC_OUTPUT_CAP {
                        let room = (EXEC_OUTPUT_CAP - have) as usize;
                        kept.extend_from_slice(&chunk[..n.min(room)]);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send((kept, total > EXEC_OUTPUT_CAP));
    });
    rx
}

// --- ssh_config_read ---

// Read one file confined to ~/.ssh (the config itself, or an Include target
// under it). `path` follows OpenSSH's own conventions for Include values:
// `None` means ~/.ssh/config; `~/...` expands against `home`; a bare relative
// path resolves against ~/.ssh (where Include fragments normally live); an
// absolute path is used as given (and must still resolve inside ~/.ssh).
//
// A target that doesn't exist returns `Ok(None)` — "no config yet" is a
// normal state, not an error, so the frontend can treat a fresh install the
// same as an empty host list. A target that resolves outside ~/.ssh (traversal,
// a symlink escaping the directory, an unrelated absolute path) is a typed
// `Err`, mirroring pathguard.rs's confine-then-read discipline.
pub fn read_config(home: &Path, path: Option<&str>) -> Result<Option<String>, String> {
    let ssh_dir = home.join(".ssh");
    let target = match path {
        None => ssh_dir.join("config"),
        Some(raw) => resolve_target_path(raw, home, &ssh_dir),
    };

    // symlink_metadata (not metadata) so a symlink whose target is missing is
    // still detected as "present" and goes through the containment check
    // below rather than silently reading as None.
    if std::fs::symlink_metadata(&target).is_err() {
        return Ok(None);
    }

    let ssh_dir_canon =
        std::fs::canonicalize(&ssh_dir).map_err(|e| format!("~/.ssh is unavailable: {e}"))?;
    let resolved = std::fs::canonicalize(&target)
        .map_err(|e| format!("failed to resolve {}: {e}", target.display()))?;
    if !resolved.starts_with(&ssh_dir_canon) {
        return Err(format!(
            "refusing to read outside ~/.ssh: {}",
            target.display()
        ));
    }

    let bytes =
        std::fs::read(&resolved).map_err(|e| format!("read {}: {e}", resolved.display()))?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Some(text)),
        Err(_) => Err(format!(
            "ssh config file is not valid UTF-8: {}",
            resolved.display()
        )),
    }
}

// --- ssh_list_dir ---

// List the file names in one directory confined to ~/.ssh — the read-only
// primitive TypeScript uses to expand a globbed Include (`Include
// ~/.ssh/config.d/*`, the pattern tools like 1Password/orbstack write). The
// glob matching itself stays in TypeScript; Rust only enumerates names.
// `path` follows the same conventions as read_config (`None` = ~/.ssh itself);
// a missing directory returns `Ok(None)`; a target resolving outside ~/.ssh
// is a typed `Err`. Non-recursive, files only (a fragment is always a file).
pub fn list_dir(home: &Path, path: Option<&str>) -> Result<Option<Vec<String>>, String> {
    let ssh_dir = home.join(".ssh");
    let target = match path {
        None => ssh_dir.clone(),
        Some(raw) => resolve_target_path(raw, home, &ssh_dir),
    };

    if std::fs::symlink_metadata(&target).is_err() {
        return Ok(None);
    }

    let ssh_dir_canon =
        std::fs::canonicalize(&ssh_dir).map_err(|e| format!("~/.ssh is unavailable: {e}"))?;
    let resolved = std::fs::canonicalize(&target)
        .map_err(|e| format!("failed to resolve {}: {e}", target.display()))?;
    if !resolved.starts_with(&ssh_dir_canon) {
        return Err(format!(
            "refusing to list outside ~/.ssh: {}",
            target.display()
        ));
    }

    let read = std::fs::read_dir(&resolved)
        .map_err(|e| format!("read_dir {}: {e}", resolved.display()))?;
    let mut names: Vec<String> = read
        .flatten()
        // metadata() follows symlinks, so a symlinked fragment still lists;
        // subdirectories are skipped (OpenSSH's glob expands to files).
        .filter(|item| item.metadata().map(|m| m.is_file()).unwrap_or(false))
        .map(|item| item.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    Ok(Some(names))
}

// Expand a raw Include-style path against `home`/`ssh_dir` without touching
// the filesystem — resolution (and the actual containment check) happens in
// read_config after this returns.
fn resolve_target_path(raw: &str, home: &Path, ssh_dir: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.join(rest);
    }
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return candidate.to_path_buf();
    }
    ssh_dir.join(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kodade-ssh-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn reads_the_default_config_when_no_path_is_given() {
        let home = temp_dir("default-config");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh").join("config"), "Host box\n").unwrap();

        let text = read_config(&home, None).unwrap();
        assert_eq!(text.as_deref(), Some("Host box\n"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_config_is_ok_none_not_an_error() {
        let home = temp_dir("missing-config");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();

        let text = read_config(&home, None).unwrap();
        assert_eq!(text, None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolves_a_relative_include_target_against_ssh_dir() {
        let home = temp_dir("relative-include");
        std::fs::create_dir_all(home.join(".ssh").join("conf.d")).unwrap();
        std::fs::write(
            home.join(".ssh").join("conf.d").join("extra"),
            "Host extra\n",
        )
        .unwrap();

        let text = read_config(&home, Some("conf.d/extra")).unwrap();
        assert_eq!(text.as_deref(), Some("Host extra\n"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolves_a_tilde_prefixed_include_target() {
        let home = temp_dir("tilde-include");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh").join("config"), "Host tilde\n").unwrap();

        let text = read_config(&home, Some("~/.ssh/config")).unwrap();
        assert_eq!(text.as_deref(), Some("Host tilde\n"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn rejects_a_path_outside_home_ssh() {
        let home = temp_dir("outside-root");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let outside_dir = home.parent().unwrap().join("kodade-ssh-outside-sibling");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside_file = outside_dir.join("secret.txt");
        std::fs::write(&outside_file, "nope").unwrap();

        let err = read_config(&home, Some(outside_file.to_str().unwrap()))
            .expect_err("a path outside ~/.ssh must be rejected");
        assert!(err.contains("outside ~/.ssh"), "got: {err}");

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn rejects_a_traversal_escape_via_dotdot() {
        let home = temp_dir("traversal");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".bashrc"), "export PATH").unwrap();

        let err = read_config(&home, Some("~/.ssh/../.bashrc"))
            .expect_err("a ../ escape out of ~/.ssh must be rejected");
        assert!(err.contains("outside ~/.ssh"), "got: {err}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_inside_ssh_dir_that_points_outside_it() {
        use std::os::unix::fs::symlink;

        let home = temp_dir("symlink-escape");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let outside_dir = home.parent().unwrap().join("kodade-ssh-symlink-outside");
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(outside_dir.join("real"), "secret").unwrap();
        symlink(outside_dir.join("real"), home.join(".ssh").join("link")).unwrap();

        let err = read_config(&home, Some("link"))
            .expect_err("a symlink escaping ~/.ssh must be rejected");
        assert!(err.contains("outside ~/.ssh"), "got: {err}");

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn list_dir_returns_sorted_file_names_and_skips_subdirs() {
        let home = temp_dir("list-basic");
        let conf_d = home.join(".ssh").join("config.d");
        std::fs::create_dir_all(&conf_d).unwrap();
        std::fs::write(conf_d.join("zz.conf"), "Host z\n").unwrap();
        std::fs::write(conf_d.join("aa.conf"), "Host a\n").unwrap();
        std::fs::create_dir_all(conf_d.join("nested")).unwrap();

        let names = list_dir(&home, Some("config.d")).unwrap().unwrap();
        assert_eq!(names, vec!["aa.conf".to_string(), "zz.conf".to_string()]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn list_dir_missing_directory_is_ok_none() {
        let home = temp_dir("list-missing");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();

        assert_eq!(list_dir(&home, Some("config.d")).unwrap(), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn list_dir_rejects_a_directory_outside_home_ssh() {
        let home = temp_dir("list-outside");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();

        let err = list_dir(&home, Some("~/.ssh/../"))
            .expect_err("listing outside ~/.ssh must be rejected");
        assert!(err.contains("outside ~/.ssh"), "got: {err}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn list_dir_rejects_a_symlinked_dir_that_escapes_ssh_dir() {
        use std::os::unix::fs::symlink;

        let home = temp_dir("list-symlink-escape");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let outside_dir = home.parent().unwrap().join("kodade-ssh-list-outside");
        std::fs::create_dir_all(&outside_dir).unwrap();
        symlink(&outside_dir, home.join(".ssh").join("linked")).unwrap();

        let err = list_dir(&home, Some("linked"))
            .expect_err("a symlinked dir escaping ~/.ssh must be rejected");
        assert!(err.contains("outside ~/.ssh"), "got: {err}");

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn missing_include_target_is_also_ok_none() {
        let home = temp_dir("missing-include");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();

        let text = read_config(&home, Some("conf.d/does-not-exist")).unwrap();
        assert_eq!(text, None);
        let _ = std::fs::remove_dir_all(&home);
    }

    // --- ssh_exec ---

    #[test]
    fn exec_rejects_hosts_outside_the_allowlist() {
        // The allowlist check happens before ssh is even resolved, so these need
        // no real ssh binary. Leading dash (flag injection), shell metacharacters,
        // whitespace, and empty are all refused — mirroring the TS validator.
        let shell = ShellEnvironment::current();
        for host in [
            "-oProxyCommand=evil",
            "box; rm -rf /",
            "a b",
            "host$(whoami)",
            "",
        ] {
            let err = exec(&shell, host, &[], 1_000)
                .expect_err(&format!("host {host:?} must be rejected"));
            assert!(err.contains("invalid host"), "got: {err}");
        }
    }

    #[test]
    fn host_allowlist_accepts_ordinary_aliases_and_user_at_host() {
        for host in ["box", "build-box", "keith@1.2.3.4", "host.local", "h_1:22"] {
            assert!(host_is_allowed(host), "rejected {host:?}");
        }
        for host in ["-x", "a;b", "a b", "", "a`b`"] {
            assert!(!host_is_allowed(host), "accepted {host:?}");
        }
    }

    // A fake `ssh` binary (unix only): a small shell script standing in for the
    // real client so run_exec's plumbing (status/output/timeout/cap) is tested
    // without a network. Windows uses ssh.exe under ConPTY and is smoke-tested
    // manually per the plan; scripting a cmd shim here would add little.
    #[cfg(unix)]
    fn write_fake_ssh(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-ssh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn run_exec_captures_stdout_stderr_and_status() {
        let dir = temp_dir("exec-capture");
        let fake = write_fake_ssh(&dir, "echo out; echo err 1>&2; exit 3");

        let result = run_exec(&fake, "box", &["ignored".into()], Duration::from_secs(5)).unwrap();
        assert_eq!(result.status, Some(3));
        assert_eq!(result.stdout.trim(), "out");
        assert_eq!(result.stderr.trim(), "err");
        assert!(!result.truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn run_exec_kills_the_child_and_reports_a_timeout() {
        let dir = temp_dir("exec-timeout");
        // Sleeps far longer than the timeout; run_exec must kill it and return a
        // typed timeout error rather than hang.
        let fake = write_fake_ssh(&dir, "sleep 30");

        let start = std::time::Instant::now();
        let err = run_exec(&fake, "box", &[], Duration::from_millis(200))
            .expect_err("a slow child must time out");
        assert!(err.contains("timed out"), "got: {err}");
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timeout must not hang until the child would exit"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn run_exec_caps_output_and_flags_truncation() {
        let dir = temp_dir("exec-cap");
        // Emit ~600 KiB (> the 512 KiB cap). The reader drains all of it (so the
        // child can exit) but retains only the cap and flags truncation.
        let fake = write_fake_ssh(&dir, "head -c 614400 /dev/zero | tr '\\0' 'a'");

        let result = run_exec(&fake, "box", &[], Duration::from_secs(10)).unwrap();
        assert!(
            result.truncated,
            "over-cap output must be flagged truncated"
        );
        assert_eq!(result.stdout.len(), (EXEC_OUTPUT_CAP as usize));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
