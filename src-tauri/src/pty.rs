// Thin PTY device driver. All product logic lives in the TypeScript frontend;
// this module only spawns login shells, pumps bytes, resizes, and reaps them.
//
// Output and exit are delivered through caller-supplied closures (a sink), so
// the manager has no Tauri dependency and can be driven by real-PTY unit tests.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::process_tree::prepare_spawn;
#[cfg(windows)]
use crate::process_tree::ProcessTree;
use crate::shell::ShellEnvironment;

// Callbacks the caller wires to Tauri events (or, in tests, to channels).
pub type OutputSink = Arc<dyn Fn(String, String) + Send + Sync>; // (id, base64 data)
pub type ExitSink = Arc<dyn Fn(String, Option<i32>) + Send + Sync>; // (id, code)

// Distinguishes spawns that reused an id, so a stale waiter thread can never
// remove a newer session that happens to own the same id.
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

// How long the waiter waits for the reader to drain remaining output after the
// child exits. A disowned process holding the PTY slave open must not block the
// exit event forever — after this deadline exit is emitted regardless.
const DRAIN_DEADLINE: Duration = Duration::from_secs(2);

// A single live PTY. The Child itself lives in the waiter thread which blocks
// on wait(); teardown goes through the pid (process group) or the portable
// killer, so killing never touches that thread. The writer sits behind its own
// lock so a blocking write (big paste into a stopped process) can't freeze the
// session map for resize/kill/shutdown.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg(unix)]
    pid: Option<u32>,
    token: u64,
    #[cfg(not(unix))]
    shell_name: String,
    #[cfg(windows)]
    tree: Arc<ProcessTree>,
}

// Holds every live PTY session, keyed by frontend-supplied id.
// Cloneable handle (Arc inside) so waiter/escalation threads can reach it too.
#[derive(Clone, Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    // Spawn a login shell in `cwd`; forward output via `on_output`, exit via `on_exit`.
    // Errors if `id` is already live — ids are single-use while a session exists.
    pub fn spawn(
        &self,
        id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        on_output: OutputSink,
        on_exit: ExitSink,
    ) -> Result<(), String> {
        // Hold the map lock across create+insert so two spawns can't race one id.
        // Everything here is quick (openpty + fork/exec); writes never hold this lock.
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(&id) {
            return Err(format!("pty id already in use: {id}"));
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        // Use the platform shell contract: Unix gets its login shell; Windows
        // gets pwsh, Windows PowerShell, or cmd without Unix-only flags.
        let shell = ShellEnvironment::current();
        let mut cmd = CommandBuilder::new(shell.executable());
        cmd.args(shell.interactive_args());
        // Empty cwd means the platform home directory.
        let dir = if cwd.is_empty() {
            shell.home().to_path_buf()
        } else {
            std::path::PathBuf::from(cwd)
        };
        cmd.cwd(&dir);
        // Make xterm feature detection and truecolor work like the user's real terminal.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        prepare_spawn()?;
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // Slave dropped here; the master keeps the PTY open.
        drop(pair.slave);

        // The process inherited the process-wide root Job Object at creation.
        // Add a per-session job for targeted close/kill operations.
        #[cfg(windows)]
        let (tree, shell_identity) = {
            let pid = match child.process_id() {
                Some(pid) => pid,
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Windows shell did not expose a process id".to_string());
                }
            };
            let tree = Arc::new(ProcessTree::attach(pid));
            let identity = tree.retained_identity();
            (tree, identity)
        };

        // From here the child is live: any setup failure must kill and reap it,
        // or an orphaned shell outlives the failed spawn.
        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        };

        let killer = child.clone_killer();
        #[cfg(unix)]
        let pid = child.process_id();
        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        sessions.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                killer,
                #[cfg(unix)]
                pid,
                token,
                #[cfg(not(unix))]
                shell_name: shell.display_name(),
                #[cfg(windows)]
                tree,
            },
        );
        drop(sessions);

        // This structured record is emitted only after the shell is managed by
        // the process tree and registered as a live PTY session. Windows RC
        // automation correlates the retained PID + creation FILETIME instead
        // of mistaking PID reuse or a transient provider probe for this shell.
        #[cfg(windows)]
        {
            if let Some((shell_pid, creation_filetime)) = shell_identity {
                if let Some(message) = windows_login_shell_ready_message(
                    &shell.display_name(),
                    shell_pid,
                    creation_filetime,
                ) {
                    println!("{message}");
                    let _ = std::io::stdout().flush();
                }
            }
        }

        // Reader thread: forward output chunks until the pipe closes (shell
        // exit). `drain_tx` drops when the thread finishes — the waiter uses
        // that as its "all output delivered" signal.
        let (drain_tx, drain_rx) = std::sync::mpsc::channel::<()>();
        let out_id = id.clone();
        thread::spawn(move || {
            let _drain_tx = drain_tx; // dropped on thread exit → drain signal
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF: shell exited
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        on_output(out_id.clone(), data);
                    }
                    Err(_) => break,
                }
            }
        });

        // Waiter thread owns the child: block on wait(), drop OUR session entry
        // (token-checked — never a newer session reusing the id), emit exit once.
        let sessions = self.sessions.clone();
        let exit_id = id.clone();
        thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            // Bounded drain before exit: in the normal case the reader EOFs as
            // the child dies, drain_tx drops, and recv returns immediately — so
            // buffered output never trails "[process exited]" in the UI. But a
            // disowned process can inherit the PTY slave and never EOF the
            // reader; after the deadline we emit exit and clean up anyway, and
            // the reader thread dies whenever the fd finally closes.
            let _ = drain_rx.recv_timeout(DRAIN_DEADLINE);
            {
                let mut sessions = sessions.lock().unwrap();
                if sessions.get(&exit_id).map(|s| s.token) == Some(token) {
                    sessions.remove(&exit_id);
                }
            }
            on_exit(exit_id, code);
        });

        Ok(())
    }

    // Write raw input bytes to a PTY. Blocking I/O happens on the per-session
    // writer lock only — the session map stays free for resize/kill/shutdown.
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let writer = {
            let sessions = self.sessions.lock().unwrap();
            sessions.get(id).ok_or("no such pty")?.writer.clone()
        };
        let mut w = writer.lock().unwrap();
        w.write_all(data).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    // Name of the process currently in the foreground of a PTY (what the user
    // is looking at): the shell when idle, "claude"/"vitest"/… while a command
    // runs. None for an unknown id or when the lookup can't resolve a name.
    //
    // Route: portable-pty's master exposes process_group_leader() on unix, which
    // is tcgetpgrp(master_fd) — the foreground process GROUP id of the tty. We
    // resolve that pgid's leader to a process name (macOS: proc_pidpath). This
    // is the fd route the ticket preferred; no child-pid bookkeeping needed.
    //
    // Orphaned-leader fallback: the pgid equals the group LEADER's pid, but the
    // leader may have already exited while other group members run on (e.g. a
    // pipeline whose first stage finished). Resolving the pgid-as-pid then fails
    // and the session reads idle even though a command is live. On macOS we
    // recover by enumerating the group's live members and naming the first one.
    pub fn foreground(&self, id: &str) -> Option<String> {
        #[cfg(unix)]
        {
            let pgid = {
                let sessions = self.sessions.lock().unwrap();
                sessions.get(id)?.master.process_group_leader()?
            };
            process_name(pgid).or_else(|| foreground_from_group(pgid))
        }
        #[cfg(windows)]
        {
            // ConPTY has no foreground-process-group API. Descendant depth is
            // not equivalent to foreground ownership, so report the selected
            // shell instead of presenting a heuristic as authoritative.
            let sessions = self.sessions.lock().unwrap();
            Some(sessions.get(id)?.shell_name.clone())
        }
        #[cfg(all(not(unix), not(windows)))]
        {
            let sessions = self.sessions.lock().unwrap();
            Some(sessions.get(id)?.shell_name.clone())
        }
    }

    // True while a session with this id is live. Lets the daemon treat a
    // re-spawn of a live id as a reattach instead of an error.
    pub fn is_live(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }

    // Resize a PTY's window (reflows the shell). An ioctl — never blocks.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(id).ok_or("no such pty")?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    // Kill a PTY's whole process tree: Unix signals its process group with an
    // escalation; Windows terminates its Job Object. Unknown ids are a no-op.
    // The waiter thread then reaps the child, emits exit, and drops the session.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        #[cfg(windows)]
        {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(session) = sessions.get_mut(id) else {
                return Ok(());
            };
            if let Err(error) = session.tree.terminate() {
                eprintln!("kodade: pty {id}: Job Object termination failed: {error}");
                if let Err(error) = session.killer.kill() {
                    return Err(format!("kill Windows pty {id}: {error}"));
                }
            }
            Ok(())
        }
        #[cfg(unix)]
        {
            let target = {
                let mut sessions = self.sessions.lock().unwrap();
                match sessions.get_mut(id) {
                    None => return Ok(()), // already exited/removed
                    Some(s) => {
                        if s.pid.is_none() {
                            // No pid to group-signal — fall back to the portable killer.
                            if let Err(e) = s.killer.kill() {
                                eprintln!("kodade: pty {id}: killer failed: {e}");
                            }
                        }
                        s.pid.map(|pid| (pid, s.token))
                    }
                }
            };
            if let Some((pid, token)) = target {
                self.kill_group(id.to_string(), pid, token, true);
            }
            Ok(())
        }
        #[cfg(all(not(unix), not(windows)))]
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(session) = sessions.get_mut(id) {
                session.killer.kill().map_err(|error| error.to_string())?;
            }
            Ok(())
        }
    }

    // Kill every live PTY — called on app exit so no shells are orphaned.
    // Grace is synchronous here (the process is exiting; helper threads would die).
    pub fn kill_all(&self) {
        #[cfg(windows)]
        {
            let mut sessions = self.sessions.lock().unwrap();
            for (id, session) in sessions.iter_mut() {
                if let Err(error) = session.tree.terminate() {
                    eprintln!("kodade: pty {id}: Job Object termination failed: {error}");
                    if let Err(error) = session.killer.kill() {
                        eprintln!("kodade: pty {id}: portable killer failed: {error}");
                    }
                }
            }
        }
        #[cfg(unix)]
        {
            let targets: Vec<(String, u32, u64)> = {
                let mut sessions = self.sessions.lock().unwrap();
                sessions
                    .iter_mut()
                    .filter_map(|(id, s)| {
                        if s.pid.is_none() {
                            if let Err(e) = s.killer.kill() {
                                eprintln!("kodade: pty {id}: killer failed: {e}");
                            }
                        }
                        s.pid.map(|pid| (id.clone(), pid, s.token))
                    })
                    .collect()
            };
            if targets.is_empty() {
                return;
            }
            for (id, pid, token) in &targets {
                self.kill_group(id.clone(), *pid, *token, false);
            }
            // Short grace so shells exit cleanly, then SIGKILL any group still live.
            thread::sleep(Duration::from_millis(200));
            let sessions = self.sessions.lock().unwrap();
            for (id, pid, token) in &targets {
                if sessions.get(id).map(|s| s.token) == Some(*token) {
                    signal_pgid(*pid, SIG_KILL, id);
                }
            }
        }
        #[cfg(all(not(unix), not(windows)))]
        {
            let mut sessions = self.sessions.lock().unwrap();
            for (id, session) in sessions.iter_mut() {
                if let Err(error) = session.killer.kill() {
                    eprintln!("kodade: pty {id}: portable killer failed: {error}");
                }
            }
        }
    }

    // Signal the process group behind `pid` with SIGHUP+SIGTERM. When
    // `escalate` is set, a helper thread SIGKILLs the group after a short grace
    // if the session (matched by token) is still in the map.
    #[cfg(unix)]
    fn kill_group(&self, id: String, pid: u32, token: u64, escalate: bool) {
        signal_pgid(pid, SIG_HUP, &id);
        signal_pgid(pid, SIG_TERM, &id);
        if !escalate {
            return;
        }
        let sessions = self.sessions.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            let still_live = sessions.lock().unwrap().get(&id).map(|s| s.token) == Some(token);
            if still_live {
                signal_pgid(pid, SIG_KILL, &id);
            }
        });
    }
}

#[cfg(unix)]
const SIG_HUP: i32 = libc::SIGHUP;
#[cfg(unix)]
const SIG_TERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const SIG_KILL: i32 = libc::SIGKILL;

// Send `sig` to the process group led by `pid` (the PTY child is a session
// leader, so -pid reaches the shell and everything it spawned). Failures are
// logged, except ESRCH — that just means the group already exited.
#[cfg(unix)]
fn signal_pgid(pid: u32, sig: i32, id: &str) {
    let pgid = -(pid as i32);
    let rc = unsafe { libc::kill(pgid, sig) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::ESRCH) {
            eprintln!("kodade: pty {id}: signal {sig} to group {pgid} failed: {err}");
        }
    }
}

// Resolve a pid to its executable basename ("claude", "zsh", "sleep").
//
// macOS: proc_pidpath() fills the absolute path of the running binary; we take
// the last path component. The one unsafe block is a documented libc FFI call
// with a caller-owned buffer — no lifetime or aliasing hazards. Returns None if
// the process is gone or the syscall fails (e.g. permission on another user's
// pid, which shouldn't happen for our own descendants).
#[cfg(target_os = "macos")]
fn process_name(pid: libc::pid_t) -> Option<String> {
    // PROC_PIDPATHINFO_MAXSIZE (= 4 * MAXPATHLEN) is the size proc_pidpath wants.
    const PROC_PIDPATHINFO_MAXSIZE: usize = 4 * 1024;
    let mut buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
    let n =
        unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    let path = String::from_utf8_lossy(&buf);
    path.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// Fallback when the pgid-as-pid lookup fails because the group LEADER has
// exited but other members live (an orphaned foreground group). We enumerate
// the group's live pids and name the first one that resolves.
//
// macOS: proc_listpids(PROC_PGRP_ONLY, pgid, ...) fills a caller-owned buffer
// with the group's member pids. A tty foreground group is small, so a fixed cap
// (64 pids) is plenty — no size-probe round trip needed. The one unsafe block is
// a documented libc FFI call with a bounded, caller-owned buffer; on failure or
// an empty group we return None (the session reads idle, same as before).
#[cfg(target_os = "macos")]
fn foreground_from_group(pgid: libc::pid_t) -> Option<String> {
    // proc_listpids type selector for "members of this process group"
    // (<sys/proc_info.h>: PROC_PGRP_ONLY). Not re-exported by the libc crate.
    const PROC_PGRP_ONLY: u32 = 2;
    const MAX_PIDS: usize = 64;
    let mut pids = [0i32; MAX_PIDS];
    let byte_len = (pids.len() * std::mem::size_of::<i32>()) as libc::c_int;
    let n = unsafe {
        libc::proc_listpids(
            PROC_PGRP_ONLY,
            pgid as u32,
            pids.as_mut_ptr() as *mut libc::c_void,
            byte_len,
        )
    };
    if n <= 0 {
        return None;
    }
    // proc_listpids returns bytes written; convert to a pid count (bounded by cap).
    let count = (n as usize / std::mem::size_of::<i32>()).min(pids.len());
    // The leader (== pgid) is dead by definition here; skip it and name the first
    // other live member. Entries can be 0 padding — skip those too.
    pids[..count]
        .iter()
        .copied()
        .filter(|&pid| pid != 0 && pid != pgid)
        .find_map(process_name)
}

// Other unix (Linux/CI): scanning /proc for a matching pgid is overkill for the
// production target (macOS), so we keep the current behavior — the direct
// pgid-as-pid lookup only — and simply report idle when the leader has exited.
#[cfg(all(unix, not(target_os = "macos")))]
fn foreground_from_group(_pgid: libc::pid_t) -> Option<String> {
    None
}

// Other unix (Linux/CI): read the command name from /proc/<pid>/comm. Keeps the
// integration tests runnable off-macOS; production target is macOS.
#[cfg(all(unix, not(target_os = "macos")))]
fn process_name(pid: libc::pid_t) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    let name = comm.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(any(windows, test))]
fn windows_login_shell_ready_message(
    shell_name: &str,
    pid: u32,
    creation_filetime: u64,
) -> Option<String> {
    let normalized = shell_name.to_ascii_lowercase();
    (pid != 0
        && creation_filetime != 0
        && matches!(normalized.as_str(), "pwsh" | "powershell" | "cmd"))
    .then(|| {
        format!(
            "kodade: managed login shell name={normalized} pid={pid} creation_filetime={creation_filetime}"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::windows_login_shell_ready_message;

    #[test]
    fn windows_login_shell_record_has_a_stable_machine_readable_shape() {
        assert_eq!(
            windows_login_shell_ready_message("PwSh", 1234, 133_801_234_567_890_000),
            Some(
                "kodade: managed login shell name=pwsh pid=1234 creation_filetime=133801234567890000"
                    .to_string()
            )
        );
    }

    #[test]
    fn windows_login_shell_record_rejects_unsupported_or_injectable_names() {
        assert_eq!(
            windows_login_shell_ready_message("pwsh\nforged", 1234, 42),
            None
        );
        assert_eq!(
            windows_login_shell_ready_message("custom-shell", 1234, 42),
            None
        );
        assert_eq!(windows_login_shell_ready_message("pwsh", 0, 42), None);
        assert_eq!(windows_login_shell_ready_message("pwsh", 1234, 0), None);
    }
}
