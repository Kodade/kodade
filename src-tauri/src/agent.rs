// Headless agent-run driver (KödChat). The sibling of pty.rs: where the PTY
// module gives a CLI a terminal, this one runs an agent CLI non-interactively
// and streams its structured stdout back line by line.
//
// Deliberately dumb. It knows nothing about claude/codex dialects, JSON, or
// chat: it resolves a binary through the login shell, spawns it with an
// already-built argv, forwards each stdout LINE verbatim, captures a bounded
// slice of stderr, and reports the exit code. All parsing lives in TypeScript
// (src/agents/), exactly like the terminal's product logic does.
//
// Like pty.rs, output/exit are delivered through caller-supplied closures so
// this module has no Tauri dependency and can be unit-tested directly.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::process_tree::{prepare_spawn, terminate_child, ProcessTree};
use crate::shell::ShellEnvironment;

// Callbacks the caller wires to Tauri events (or, in tests, to channels).
pub type LineSink = Arc<dyn Fn(String, String) + Send + Sync>; // (id, one stdout line)
pub type ExitSink = Arc<dyn Fn(String, Option<i32>, String) + Send + Sync>; // (id, code, stderr)

// Total stdout a single run may stream. A runaway agent (or a CLI that decides
// to dump a binary to stdout) must not be able to grow the webview's transcript
// without bound; past the cap the run is terminated and reported as an exit.
pub const STDOUT_CAP: usize = 32 * 1024 * 1024;
// A single NDJSON line above this is not a chat event — it is a malfunction.
// Skipped rather than forwarded, so one bad line can't wedge the transcript.
pub const LINE_CAP: usize = 4 * 1024 * 1024;
// Only the tail of stderr is useful (the error the CLI died with), and it rides
// along on the exit event, so a small cap is plenty.
pub const STDERR_CAP: usize = 64 * 1024;

// Distinguishes runs that reused an id, so a stale waiter can never remove a
// newer run that happens to own the same id. Mirrors pty.rs's token scheme.
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

// One live headless run. The Child itself lives in the waiter thread blocking
// on wait(); cancellation goes through the retained process tree.
struct AgentRun {
    tree: Arc<ProcessTree>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    token: u64,
}

// Holds every live agent run, keyed by frontend-supplied run id.
#[derive(Clone, Default)]
pub struct AgentManager {
    runs: Arc<Mutex<HashMap<String, AgentRun>>>,
}

// Everything one spawn needs. Grouped so the command wrapper stays a
// pass-through and clippy doesn't have to count seven arguments.
pub struct AgentSpawn {
    pub id: String,
    pub cwd: String,
    pub bin: String,
    pub args: Vec<String>,
    // Written to the child's stdin, which is then CLOSED — the one-shot turn
    // shape both shipped dialects use (`claude -p`, `codex exec`) reads its
    // prompt from stdin and waits for EOF. None keeps stdin open for `send`.
    pub stdin: Option<String>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self::default()
    }

    // Start a headless run. The binary name is resolved through the user's
    // login shell so the CLI sees the same PATH — and therefore the same
    // credentials — it would in a real terminal. Kodade never proxies auth.
    pub fn start(
        &self,
        spawn: AgentSpawn,
        on_line: LineSink,
        on_exit: ExitSink,
    ) -> Result<(), String> {
        self.start_with_shell(spawn, &ShellEnvironment::current(), on_line, on_exit)
    }

    fn start_with_shell(
        &self,
        spawn: AgentSpawn,
        shell: &ShellEnvironment,
        on_line: LineSink,
        on_exit: ExitSink,
    ) -> Result<(), String> {
        // Hold the map lock across resolve+spawn+insert so two starts can't
        // race one id. Everything here is a fork/exec, and no stream I/O ever
        // takes this lock.
        let mut runs = self.runs.lock().unwrap();
        if runs.contains_key(&spawn.id) {
            return Err(format!("agent run id already in use: {}", spawn.id));
        }

        let (executable, login_path) = shell
            .resolve_executable_with_login_path(&spawn.bin)
            .ok_or_else(|| format!("{} is not installed or not on PATH", spawn.bin))?;

        let dir = if spawn.cwd.is_empty() {
            shell.home().to_path_buf()
        } else {
            std::path::PathBuf::from(&spawn.cwd)
        };

        let mut cmd = Command::new(&executable);
        cmd.args(&spawn.args)
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Headless CLIs decorate output when they think a human is watching.
        // These make the structured stream predictable without touching auth.
        if let Some(path) = login_path {
            cmd.env("PATH", path);
        }
        cmd.env("NO_COLOR", "1");
        cmd.env("TERM", "dumb");
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        prepare_spawn()?;
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("start {}: {e}", spawn.bin))?;
        let tree = Arc::new(ProcessTree::attach_child(&child));

        let mut child_stdin = child.stdin.take();
        if let Some(prompt) = spawn.stdin.as_ref() {
            // Write then drop: the child sees EOF and starts its turn.
            if let Some(handle) = child_stdin.as_mut() {
                let _ = handle.write_all(prompt.as_bytes());
                let _ = handle.flush();
            }
            child_stdin = None;
        }
        let stdin = Arc::new(Mutex::new(child_stdin));

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("capture {} stdout", spawn.bin))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("capture {} stderr", spawn.bin))?;

        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        runs.insert(
            spawn.id.clone(),
            AgentRun {
                tree: tree.clone(),
                stdin,
                token,
            },
        );
        drop(runs);

        let reader = spawn_line_reader(spawn.id.clone(), stdout, on_line, tree.clone());
        let errors = spawn_stderr_reader(stderr);
        self.spawn_waiter(spawn.id, token, child, reader, errors, on_exit);
        Ok(())
    }

    // Write to a still-open stdin. Only meaningful for runs started WITHOUT a
    // prompt (an interactive stream-input dialect); one-shot turns closed
    // stdin at spawn and report a clear error instead of silently dropping it.
    pub fn send(&self, id: &str, data: &str) -> Result<(), String> {
        let handle = {
            let runs = self.runs.lock().unwrap();
            let run = runs
                .get(id)
                .ok_or_else(|| format!("unknown agent run: {id}"))?;
            run.stdin.clone()
        };
        let mut guard = handle.lock().unwrap();
        let stdin = guard
            .as_mut()
            .ok_or_else(|| format!("agent run {id} does not accept input"))?;
        stdin
            .write_all(data.as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|e| format!("write to agent run {id}: {e}"))
    }

    // Close a streaming run's input without killing it. Claude Code treats
    // EOF as the graceful end of a bidirectional session and flushes its
    // resumable session before exiting.
    pub fn end_input(&self, id: &str) -> Result<(), String> {
        let handle = {
            let runs = self.runs.lock().unwrap();
            let run = runs
                .get(id)
                .ok_or_else(|| format!("unknown agent run: {id}"))?;
            run.stdin.clone()
        };
        handle.lock().unwrap().take();
        Ok(())
    }

    // Kill a run's whole process group. The waiter still fires `on_exit`, so
    // the frontend settles a cancelled thread through the normal path.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let tree = {
            let runs = self.runs.lock().unwrap();
            match runs.get(id) {
                Some(run) => run.tree.clone(),
                // Cancelling an already-finished run is the common race when a
                // user hits stop as the turn lands. Not an error.
                None => return Ok(()),
            }
        };
        tree.terminate()
    }

    // Kill every live run (app shutdown). Idempotent.
    pub fn cancel_all(&self) {
        let trees: Vec<Arc<ProcessTree>> = {
            let runs = self.runs.lock().unwrap();
            runs.values().map(|run| run.tree.clone()).collect()
        };
        for tree in trees {
            let _ = tree.terminate();
        }
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.runs.lock().unwrap().contains_key(id)
    }

    // Reap the child, drain both readers, drop the run, then report the exit.
    fn spawn_waiter(
        &self,
        id: String,
        token: u64,
        mut child: Child,
        reader: thread::JoinHandle<()>,
        errors: thread::JoinHandle<String>,
        on_exit: ExitSink,
    ) {
        let runs = self.runs.clone();
        thread::spawn(move || {
            let status = child.wait().ok();
            // Both pipes close when the child dies, so these joins are bounded.
            let _ = reader.join();
            let stderr = errors.join().unwrap_or_default();
            {
                let mut map = runs.lock().unwrap();
                // Only remove the run this waiter actually owns.
                if map.get(&id).is_some_and(|run| run.token == token) {
                    map.remove(&id);
                }
            }
            on_exit(id, status.and_then(|s| s.code()), stderr);
        });
    }
}

// Forward stdout one line at a time. Lines are the unit of the NDJSON dialects
// both shipped adapters parse, so splitting here means TypeScript never has to
// reassemble partial chunks the way the terminal's byte stream does.
fn spawn_line_reader<R: Read + Send + 'static>(
    id: String,
    reader: R,
    on_line: LineSink,
    tree: Arc<ProcessTree>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffered = BufReader::new(reader);
        let mut used = 0_usize;
        let mut line = Vec::new();
        loop {
            line.clear();
            match buffered.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    used = used.saturating_add(count);
                    if used > STDOUT_CAP {
                        // Runaway output: stop the process group and let the
                        // waiter report the exit like any other termination.
                        let _ = tree.terminate();
                        break;
                    }
                    if line.len() > LINE_CAP {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim_end_matches(['\n', '\r']);
                    if trimmed.is_empty() {
                        continue;
                    }
                    on_line(id.clone(), trimmed.to_string());
                }
            }
        }
    })
}

// Keep the FIRST STDERR_CAP bytes: CLIs print their fatal reason up front and
// then repeat usage text, so the head is the diagnostic part.
fn spawn_stderr_reader<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if kept.len() < STDERR_CAP {
                        let room = STDERR_CAP - kept.len();
                        kept.extend_from_slice(&chunk[..count.min(room)]);
                    }
                }
            }
        }
        String::from_utf8_lossy(&kept).trim().to_string()
    })
}

// Terminate a child directly (used by tests and shutdown paths that hold one).
#[allow(dead_code)]
pub fn kill_child(tree: &ProcessTree, child: &mut Child) {
    terminate_child(tree, child);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::shell::ShellKind;
    use std::sync::mpsc;
    use std::time::Duration;

    #[cfg(unix)]
    fn write_executable(path: &std::path::Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, contents).unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    type SinkHarness = (
        LineSink,
        ExitSink,
        mpsc::Receiver<(String, String)>,
        mpsc::Receiver<(String, Option<i32>, String)>,
    );

    fn sinks() -> SinkHarness {
        let (line_tx, line_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let on_line: LineSink = Arc::new(move |id, line| {
            let _ = line_tx.send((id, line));
        });
        let on_exit: ExitSink = Arc::new(move |id, code, stderr| {
            let _ = exit_tx.send((id, code, stderr));
        });
        (on_line, on_exit, line_rx, exit_rx)
    }

    #[test]
    #[cfg(unix)]
    fn streams_stdout_line_by_line_then_reports_exit() {
        let manager = AgentManager::new();
        let (on_line, on_exit, lines, exits) = sinks();
        manager
            .start(
                AgentSpawn {
                    id: "run-1".into(),
                    cwd: "/tmp".into(),
                    bin: "sh".into(),
                    args: vec!["-c".into(), "printf 'a\\nb\\n'".into()],
                    stdin: Some(String::new()),
                },
                on_line,
                on_exit,
            )
            .expect("start");

        let first = lines.recv_timeout(Duration::from_secs(10)).unwrap();
        let second = lines.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(first, ("run-1".to_string(), "a".to_string()));
        assert_eq!(second, ("run-1".to_string(), "b".to_string()));

        let (id, code, _stderr) = exits.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(id, "run-1");
        assert_eq!(code, Some(0));
        assert!(!manager.is_live("run-1"));
    }

    #[test]
    #[cfg(unix)]
    fn prompt_reaches_the_child_over_stdin() {
        let manager = AgentManager::new();
        let (on_line, on_exit, lines, _exits) = sinks();
        manager
            .start(
                AgentSpawn {
                    id: "run-stdin".into(),
                    cwd: "/tmp".into(),
                    bin: "cat".into(),
                    args: Vec::new(),
                    stdin: Some("hello from kodchat\n".into()),
                },
                on_line,
                on_exit,
            )
            .expect("start");
        assert_eq!(
            lines.recv_timeout(Duration::from_secs(10)).unwrap().1,
            "hello from kodchat"
        );
    }

    #[test]
    #[cfg(unix)]
    fn provider_can_launch_a_secondary_executable_from_its_login_profile_path() {
        let fixture = tempfile::tempdir().unwrap();
        let bin_dir = fixture.path().join("profile-bin");
        std::fs::create_dir(&bin_dir).unwrap();
        write_executable(
            &bin_dir.join("profile-secondary"),
            "#!/bin/sh\nprintf 'secondary launched\\n'\n",
        );
        write_executable(
            &bin_dir.join("profile-provider"),
            "#!/bin/sh\n\
             [ -z \"${KODADE_PROFILE_SECRET-}\" ] || { echo 'secret leaked' >&2; exit 9; }\n\
             [ \"$1\" = 'literal;$(not-executed)' ] || { echo 'argument changed' >&2; exit 8; }\n\
             exec env profile-secondary\n",
        );

        // This shell wrapper models a login profile that prepends one private
        // tool directory without changing the desktop process environment.
        let shell = fixture.path().join("profile-shell");
        write_executable(
            &shell,
            &format!(
                "#!/bin/sh\nexport PATH=\"{}:$PATH\"\nexport KODADE_PROFILE_SECRET=must-not-leak\n[ \"$1\" = -l ] && shift\nexec /bin/sh \"$@\"\n",
                bin_dir.display()
            ),
        );

        let shell = ShellEnvironment::new(shell, ShellKind::Posix, fixture.path().into());
        let manager = AgentManager::new();
        let (on_line, on_exit, lines, exits) = sinks();
        manager
            .start_with_shell(
                AgentSpawn {
                    id: "run-profile-path".into(),
                    cwd: fixture.path().to_string_lossy().into_owned(),
                    bin: "profile-provider".into(),
                    args: vec!["literal;$(not-executed)".into()],
                    stdin: Some(String::new()),
                },
                &shell,
                on_line,
                on_exit,
            )
            .expect("provider should resolve through the login profile");

        let (_, code, stderr) = exits.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(code, Some(0), "provider failed: {stderr}");
        assert_eq!(
            lines.recv_timeout(Duration::from_secs(1)).unwrap().1,
            "secondary launched"
        );
    }

    #[test]
    #[cfg(unix)]
    fn stderr_rides_along_on_the_exit_event() {
        let manager = AgentManager::new();
        let (on_line, on_exit, _lines, exits) = sinks();
        manager
            .start(
                AgentSpawn {
                    id: "run-err".into(),
                    cwd: "/tmp".into(),
                    bin: "sh".into(),
                    args: vec!["-c".into(), "echo boom >&2; exit 3".into()],
                    stdin: Some(String::new()),
                },
                on_line,
                on_exit,
            )
            .expect("start");
        let (_, code, stderr) = exits.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(code, Some(3));
        assert_eq!(stderr, "boom");
    }

    #[test]
    #[cfg(unix)]
    fn cancel_kills_the_run_and_still_reports_exit() {
        let manager = AgentManager::new();
        let (on_line, on_exit, _lines, exits) = sinks();
        manager
            .start(
                AgentSpawn {
                    id: "run-cancel".into(),
                    cwd: "/tmp".into(),
                    bin: "sleep".into(),
                    args: vec!["30".into()],
                    stdin: Some(String::new()),
                },
                on_line,
                on_exit,
            )
            .expect("start");
        manager.cancel("run-cancel").expect("cancel");
        let (id, _code, _stderr) = exits.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(id, "run-cancel");
        // Cancelling a finished run is a no-op, never an error.
        assert!(manager.cancel("run-cancel").is_ok());
    }

    #[test]
    fn unresolvable_and_unsafe_binaries_are_rejected_before_spawn() {
        let manager = AgentManager::new();
        let (on_line, on_exit, _lines, _exits) = sinks();
        for bin in [
            "definitely-not-a-real-cli-xyz",
            "claude; whoami",
            "../claude",
        ] {
            let error = manager
                .start(
                    AgentSpawn {
                        id: format!("run-{bin}"),
                        cwd: "/tmp".into(),
                        bin: bin.into(),
                        args: Vec::new(),
                        stdin: Some(String::new()),
                    },
                    on_line.clone(),
                    on_exit.clone(),
                )
                .unwrap_err();
            assert!(error.contains("not installed"), "unexpected error: {error}");
        }
    }
}
