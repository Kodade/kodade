// Shared, allowlist-runner exec discipline for the read-only CLI surfaces
// (`gh` in github.rs, `git` in git.rs). Each caller resolves its binary once
// through the login shell, validates its argv against a fixed allowlist, then
// hands the resolved path + already-approved args here. This module owns only
// the "run a trusted binary safely" mechanics: direct exec (no shell), project
// root as cwd, a hard timeout with process-group kill, and a per-stream output
// cap. It never validates arguments — that stays with each command's allowlist.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use crate::process_tree::{prepare_spawn, terminate_child, ProcessTree};

// Per-call cap across both streams combined; oversized output is an error, not
// a silent truncation, so a caller never parses half a result.
pub const OUTPUT_CAP: usize = 1024 * 1024;

// Captured stdout/stderr of one finished run. Plain strings — each command
// wraps this in its own serde IPC struct (GhOutput / GitOutput).
#[derive(Debug)]
pub struct ProcOutput {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Copy, Debug)]
pub enum ExecEnvironment {
    Inherit,
    Git,
    Gh,
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn remove_git_environment(cmd: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            cmd.env_remove(key);
        }
    }
    for key in [
        "SSH_ASKPASS",
        "SSH_ASKPASS_REQUIRE",
        "PAGER",
        "EDITOR",
        "VISUAL",
    ] {
        cmd.env_remove(key);
    }
}

fn harden_git_environment(cmd: &mut Command) {
    remove_git_environment(cmd);
    // Trusted environment-level config also applies to any git child launched
    // by gh. Inherited GIT_CONFIG_* values were removed above before these fixed
    // entries were installed.
    let config = [
        ("core.fsmonitor", "false"),
        ("core.hooksPath", null_device()),
        ("diff.external", ""),
        ("core.pager", "cat"),
    ];
    cmd.env("GIT_CONFIG_COUNT", config.len().to_string());
    for (index, (key, value)) in config.iter().enumerate() {
        cmd.env(format!("GIT_CONFIG_KEY_{index}"), key);
        cmd.env(format!("GIT_CONFIG_VALUE_{index}"), value);
    }
    cmd.env("GIT_CONFIG_GLOBAL", null_device())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("PAGER", "cat");
}

fn configure_environment(cmd: &mut Command, environment: ExecEnvironment) {
    match environment {
        ExecEnvironment::Inherit => {}
        ExecEnvironment::Git => harden_git_environment(cmd),
        ExecEnvironment::Gh => {
            harden_git_environment(cmd);
            for key in ["GH_BROWSER", "GH_EDITOR", "GH_FORCE_TTY", "GH_PAGER"] {
                cmd.env_remove(key);
            }
            cmd.env("GH_PAGER", "cat").env("GH_PROMPT_DISABLED", "1");
        }
    }
}

// Run an already-resolved, already-validated binary. `label` names the tool in
// every error string ("gh" / "git") so failures read cleanly. The path was
// resolved once through the login-shell PATH and args crossed the allowlist, so
// running the binary directly means project paths and arguments never touch a
// shell.
pub fn run_exec(
    label: &'static str,
    executable: &Path,
    project_root: &Path,
    args: &[String],
    timeout: Duration,
    environment: ExecEnvironment,
) -> Result<ProcOutput, String> {
    let mut cmd = Command::new(executable);
    cmd.args(args)
        .current_dir(project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_environment(&mut cmd, environment);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    prepare_spawn().map_err(|error| format!("prepare {label} process tree: {error}"))?;
    let mut child = cmd.spawn().map_err(|e| format!("start {label}: {e}"))?;
    let tree = ProcessTree::attach_child(&child);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("capture {label} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("capture {label} stderr"))?;
    let used = Arc::new(AtomicUsize::new(0));
    let exceeded = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    spawn_reader(stdout, "stdout", tx.clone(), used.clone(), exceeded.clone());
    spawn_reader(stderr, "stderr", tx, used, exceeded.clone());

    let status = match wait_timeout(&mut child, timeout) {
        Some(status) => status,
        None => {
            terminate_child(&tree, &mut child);
            let _ = child.wait();
            return Err(format!(
                "{label} timed out after {}s",
                timeout.as_secs_f64()
            ));
        }
    };

    let mut out = ProcOutput {
        stdout: String::new(),
        stderr: String::new(),
    };
    for _ in 0..2 {
        let (stream, bytes) = rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| format!("{label} output reader did not finish"))?;
        let text = String::from_utf8_lossy(&bytes).to_string();
        if stream == "stdout" {
            out.stdout = text;
        } else {
            out.stderr = text;
        }
    }
    if exceeded.load(Ordering::Relaxed) {
        return Err(format!("{label} output exceeded 1 MiB"));
    }
    if !status.success() {
        let detail = out.stderr.trim();
        if status.code() == Some(127) {
            return Err(format!("{label} is not installed: {detail}"));
        }
        return Err(if detail.is_empty() {
            format!("{label} exited with status {status}")
        } else {
            format!("{label} exited with status {status}: {detail}")
        });
    }
    Ok(out)
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: &'static str,
    tx: mpsc::Sender<(&'static str, Vec<u8>)>,
    used: Arc<AtomicUsize>,
    exceeded: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let count = match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            let before = used.fetch_add(count, Ordering::Relaxed);
            if before < OUTPUT_CAP {
                kept.extend_from_slice(&chunk[..count.min(OUTPUT_CAP - before)]);
            }
            if before.saturating_add(count) > OUTPUT_CAP {
                exceeded.store(true, Ordering::Relaxed);
            }
        }
        let _ = tx.send((stream, kept));
    });
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
    use super::{run_exec, ExecEnvironment};
    use std::path::Path;
    use std::time::Duration;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    #[test]
    #[cfg(unix)]
    fn direct_exec_preserves_each_argument_without_interpolation() {
        let output = run_exec(
            "proc",
            Path::new("/bin/echo"),
            Path::new("/tmp"),
            &strings(&["title with spaces", "--limit", "50"]),
            Duration::from_secs(1),
            ExecEnvironment::Inherit,
        )
        .unwrap();
        assert_eq!(output.stdout, "title with spaces --limit 50\n");
        assert_eq!(output.stderr, "");
    }

    #[test]
    #[cfg(unix)]
    fn timeout_has_a_stable_error_shape_and_kills_the_process_group() {
        let error = run_exec(
            "proc",
            Path::new("/bin/sleep"),
            Path::new("/tmp"),
            &strings(&["2"]),
            Duration::from_millis(20),
            ExecEnvironment::Inherit,
        )
        .unwrap_err();
        assert_eq!(error, "proc timed out after 0.02s");
    }

    #[test]
    #[cfg(unix)]
    fn label_names_the_tool_in_the_timeout_error() {
        let error = run_exec(
            "git",
            Path::new("/bin/sleep"),
            Path::new("/tmp"),
            &strings(&["2"]),
            Duration::from_millis(20),
            ExecEnvironment::Inherit,
        )
        .unwrap_err();
        assert_eq!(error, "git timed out after 0.02s");
    }

    #[test]
    #[cfg(windows)]
    fn direct_exec_runs_from_paths_with_spaces_and_unicode() {
        let root =
            std::env::temp_dir().join(format!("kodade exec Kødade Tools {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let shim = root.join("tool fixture.cmd");
        std::fs::write(&shim, "@echo off\r\necho %~1\r\n").unwrap();

        let output = run_exec(
            "proc",
            &shim,
            &root,
            &strings(&["title with spaces"]),
            Duration::from_secs(1),
            ExecEnvironment::Inherit,
        )
        .unwrap();
        assert_eq!(output.stdout.trim(), "title with spaces");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(windows)]
    fn timeout_has_a_stable_error_shape_and_kills_the_child() {
        let root = std::env::temp_dir();
        let error = run_exec(
            "proc",
            Path::new("cmd.exe"),
            &root,
            &strings(&["/D", "/S", "/C", "ping 127.0.0.1 -n 3 > NUL"]),
            Duration::from_millis(20),
            ExecEnvironment::Inherit,
        )
        .unwrap_err();
        assert_eq!(error, "proc timed out after 0.02s");
    }

    // Regression guard for issue #91: does linking vox's native deps
    // (whisper-rs/whisper.cpp+ggml, cpal, reqwest) wipe or truncate the process
    // PATH via a static initializer? This has real production impact — ConPTY
    // children inherit the app env — so it must always hold.
    #[test]
    #[cfg(windows)]
    fn vox_native_deps_leave_parent_path_intact() {
        let path = std::env::var("PATH").unwrap_or_default();
        let entries: Vec<&str> = path.split(';').filter(|e| !e.is_empty()).collect();
        let has_system32 = entries.iter().any(|dir| {
            dir.trim_matches('"')
                .trim_end_matches('\\')
                .to_ascii_lowercase()
                .ends_with("\\system32")
        });
        assert!(!path.is_empty(), "parent PATH is empty");
        assert!(
            has_system32,
            "parent PATH lost System32 ({} chars, {} entries): {path}",
            path.len(),
            entries.len()
        );
    }

    // Second half of issue #91: a spawned cmd.exe child must resolve `ping` via
    // PATH. The failure mode is cargo-test-only PATH bloat, not env mutation:
    // whisper-rs-sys's build.rs emits cargo:rustc-link-search for every directory
    // of its cmake build tree, and cargo prepends all native search dirs to PATH
    // when running test binaries on Windows — which can push PATH past cmd.exe's
    // ~8 KiB per-variable limit so entries after the bloat (System32 included)
    // become unsearchable. The CI test step caps that bloat (short CARGO_TARGET_DIR
    // + Ninja generator); this guard proves the cap holds. The shipped app never
    // carries these dirs and execs gh by absolute path, so runtime is unaffected.
    #[test]
    #[cfg(windows)]
    fn spawned_cmd_child_resolves_ping_via_path() {
        let path = std::env::var("PATH").unwrap_or_default();
        let entries: Vec<&str> = path.split(';').filter(|e| !e.is_empty()).collect();
        let has_system32 = entries.iter().any(|dir| {
            dir.trim_matches('"')
                .trim_end_matches('\\')
                .to_ascii_lowercase()
                .ends_with("\\system32")
        });

        // Child lookup integrity: ping resolved via PATH, not an absolute path.
        let result = run_exec(
            "proc",
            Path::new("cmd.exe"),
            &std::env::temp_dir(),
            &strings(&["/D", "/S", "/C", "ping -n 1 127.0.0.1 > NUL"]),
            Duration::from_secs(60),
            ExecEnvironment::Inherit,
        );
        if let Err(error) = result {
            panic!(
                "cmd child failed to resolve ping via PATH: {error}\n\
                 parent PATH: {} chars, {} entries, contains System32: {has_system32}",
                path.len(),
                entries.len()
            );
        }
    }
}
