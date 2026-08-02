#![cfg(unix)]

// Integration tests for the PTY manager driven with REAL Unix PTYs.
// Uses /bin/bash directly (via SHELL override) for deterministic prompt-free output.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use kodade_lib::pty::{ExitSink, OutputSink, PtyManager};

type TestSinks = (
    OutputSink,
    ExitSink,
    Arc<Mutex<Vec<u8>>>,
    Receiver<Option<i32>>,
);

// Collect base64-decoded output into a shared buffer; forward exit codes over a channel.
fn sinks() -> TestSinks {
    let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let out_buf = buf.clone();
    let on_output: OutputSink = Arc::new(move |_id, data| {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .unwrap();
        out_buf.lock().unwrap().extend_from_slice(&bytes);
    });

    let (tx, rx): (Sender<Option<i32>>, Receiver<Option<i32>>) = channel();
    let on_exit: ExitSink = Arc::new(move |_id, code| {
        let _ = tx.send(code);
    });

    (on_output, on_exit, buf, rx)
}

// Force a deterministic, config-free shell so tests don't depend on the CI user's dotfiles.
fn use_bash() {
    std::env::set_var("SHELL", "/bin/bash");
}

fn cwd() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

fn output_contains(buf: &Arc<Mutex<Vec<u8>>>, needle: &str) -> bool {
    let guard = buf.lock().unwrap();
    String::from_utf8_lossy(&guard).contains(needle)
}

// Poll the output buffer for up to ~3s waiting for `needle` to appear.
fn wait_for_output(buf: &Arc<Mutex<Vec<u8>>>, needle: &str) -> bool {
    for _ in 0..60 {
        if output_contains(buf, needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn spawn_write_command_output_reaches_sink() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, buf, _rx) = sinks();

    mgr.spawn("t1".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn should succeed");

    // Give the shell a moment to come up, then run a command whose OUTPUT
    // contains a sentinel never present contiguously in the input — so a
    // match proves the command executed, not just that the tty echoed keys.
    std::thread::sleep(Duration::from_millis(300));
    mgr.write("t1", b"printf 'kodade-%s\\n' OK\n")
        .expect("write ok");

    assert!(
        wait_for_output(&buf, "kodade-OK"),
        "command output should reach the output sink"
    );

    let _ = mgr.kill("t1");
}

#[test]
fn duplicate_id_is_rejected_and_first_session_survives() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, buf, _rx) = sinks();

    mgr.spawn("dup".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("first spawn ok");

    // Second spawn with the same id must fail...
    let (o2, e2, _b2, _r2) = sinks();
    let err = mgr
        .spawn("dup".into(), cwd(), 80, 24, o2, e2)
        .expect_err("second spawn with a live id must error");
    assert!(err.contains("already in use"), "err was: {err}");

    // ...and the first session must still be fully functional.
    std::thread::sleep(Duration::from_millis(300));
    mgr.write("dup", b"printf 'kodade-%s\\n' FIRST\n")
        .expect("first session still writable");
    assert!(
        wait_for_output(&buf, "kodade-FIRST"),
        "first session should still produce output after rejected duplicate"
    );

    let _ = mgr.kill("dup");
}

#[test]
fn kill_right_after_spawn_leaves_no_session_entry() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, _buf, rx) = sinks();

    mgr.spawn("t2".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn ok");
    // Kill immediately — no settling sleep; teardown must cope with a shell
    // that is still starting up.
    mgr.kill("t2").expect("kill ok");

    rx.recv_timeout(Duration::from_secs(5))
        .expect("exit event should fire after kill");
    // The waiter removes the entry before emitting exit, so the id is now free.
    assert!(
        mgr.resize("t2", 80, 24).is_err(),
        "session entry should be gone after exit"
    );
}

#[test]
fn resize_does_not_error() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, _buf, _rx) = sinks();

    mgr.spawn("t3".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn ok");

    std::thread::sleep(Duration::from_millis(200));
    mgr.resize("t3", 120, 40).expect("resize should not error");

    let _ = mgr.kill("t3");
}

#[test]
fn kill_emits_exit_event() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, _buf, rx) = sinks();

    mgr.spawn("t4".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn ok");

    std::thread::sleep(Duration::from_millis(200));
    mgr.kill("t4").expect("kill ok");

    // The exit event firing (recv succeeding) is the assertion: it proves the
    // waiter thread reaped the killed child and completed the PTY lifecycle.
    // The exact code is platform-dependent (signal death), so no assert on it.
    let _code = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("exit event should fire after kill");
}

#[test]
fn final_output_arrives_before_exit_event() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, buf, rx) = sinks();

    mgr.spawn("t5".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn ok");

    std::thread::sleep(Duration::from_millis(300));
    mgr.write("t5", b"printf 'kodade-%s\\n' LAST; exit\n")
        .expect("write ok");

    rx.recv_timeout(Duration::from_secs(5))
        .expect("exit event should fire after shell exits");
    // No grace sleep on purpose: the moment exit is observed, every output
    // chunk must already be in the sink (the waiter drains the reader first).
    assert!(
        output_contains(&buf, "kodade-LAST"),
        "final output must be delivered before the exit event"
    );
}

#[test]
fn exit_fires_even_when_a_stray_process_holds_the_pty_open() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, _buf, rx) = sinks();

    mgr.spawn("t6".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn ok");

    // Orphan a background process that inherits the PTY slave, then exit the
    // shell. If the reader never EOFs while the sleep lives (Linux semantics),
    // the bounded drain (2s) must emit the exit event and clean up instead of
    // hanging. On macOS the kernel revoke()s the tty on session-leader exit so
    // EOF arrives immediately — either way this must finish inside the bound.
    std::thread::sleep(Duration::from_millis(300));
    mgr.write("t6", b"(sleep 10 &); exit\n").expect("write ok");

    rx.recv_timeout(Duration::from_secs(6))
        .expect("exit event must fire within the drain bound despite the held slave");
    assert!(
        mgr.resize("t6", 80, 24).is_err(),
        "session entry must be removed despite the held slave"
    );
}

#[test]
fn resize_unknown_pty_errors() {
    let mgr = PtyManager::new();
    assert!(mgr.resize("does-not-exist", 80, 24).is_err());
}

// App-quit path: kill_all must terminate EVERY live session and leave the map
// empty, so no shells (or their children) outlive the app. This is the shutdown
// guarantee the RunEvent handler relies on.
#[test]
fn kill_all_terminates_every_session_and_empties_the_map() {
    use_bash();
    let mgr = PtyManager::new();

    // Spawn several sessions and confirm each is live.
    let ids = ["k1", "k2", "k3"];
    let mut rxs = Vec::new();
    for id in ids {
        let (on_output, on_exit, _buf, rx) = sinks();
        mgr.spawn(id.to_string(), cwd(), 80, 24, on_output, on_exit)
            .expect("spawn ok");
        rxs.push(rx);
    }
    // Let the shells come up; then start a long-lived child in each so kill_all
    // is proven to reach the whole process group, not just the shell.
    std::thread::sleep(Duration::from_millis(300));
    for id in ids {
        mgr.write(id, b"sleep 30 &\n").expect("write ok");
    }
    std::thread::sleep(Duration::from_millis(200));

    // Quit: one call must take everything down.
    mgr.kill_all();

    // Every session emits its exit event...
    for rx in &rxs {
        rx.recv_timeout(Duration::from_secs(5))
            .expect("each killed session must emit an exit event");
    }
    // ...and the map is empty: no id is still addressable.
    for id in ids {
        assert!(
            mgr.resize(id, 80, 24).is_err(),
            "session {id} must be gone after kill_all"
        );
    }
}

// kill_all on an empty manager is a harmless no-op — it must not panic or block
// (the RunEvent handler calls it unconditionally, and may fire twice).
#[test]
fn kill_all_on_empty_manager_is_a_noop() {
    let mgr = PtyManager::new();
    mgr.kill_all();
    mgr.kill_all(); // twice, mirroring ExitRequested + Exit both firing
}

// Poll foreground() until it reports `needle` (or times out at ~4s). Foreground
// resolution races shell startup / command launch, so retries keep it stable.
fn wait_for_foreground(mgr: &PtyManager, id: &str, needle: &str) -> bool {
    for _ in 0..80 {
        if mgr.foreground(id).as_deref() == Some(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

// A freshly spawned shell sits idle in the foreground of its own tty, so
// foreground() returns the shell's name ("bash" here via the SHELL override).
#[test]
fn foreground_of_idle_shell_is_the_shell() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, _buf, _rx) = sinks();

    mgr.spawn("fg1".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn ok");

    assert!(
        wait_for_foreground(&mgr, "fg1", "bash"),
        "idle shell should report its own name in the foreground; got {:?}",
        mgr.foreground("fg1")
    );

    let _ = mgr.kill("fg1");
}

// While a command runs in the shell, IT owns the tty foreground — so a running
// `sleep 30` makes foreground() report "sleep" (not the shell). `exec` replaces
// the shell so the sleep is the foreground group leader deterministically.
#[test]
fn foreground_reports_the_running_command() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, _buf, _rx) = sinks();

    mgr.spawn("fg2".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn ok");

    std::thread::sleep(Duration::from_millis(300));
    // exec: the sleep takes over the shell's pid, becoming the foreground leader.
    mgr.write("fg2", b"exec sleep 30\n").expect("write ok");

    assert!(
        wait_for_foreground(&mgr, "fg2", "sleep"),
        "running command should be the foreground process; got {:?}",
        mgr.foreground("fg2")
    );

    let _ = mgr.kill("fg2");
}

// Unknown ids resolve to None (no session, nothing in the foreground).
#[test]
fn foreground_of_unknown_id_is_none() {
    let mgr = PtyManager::new();
    assert!(mgr.foreground("nope").is_none());
}

// --- Orphaned foreground-group leader (macOS fallback) ---
//
// When a foreground process GROUP's leader exits but a later member lives on
// (a pipeline whose first stage finished), the pgid still names the dead leader
// — so the direct pgid-as-pid lookup fails. foreground() must fall back to
// enumerating the group's live members. Fixture: a pipeline `true | sleep 30`
// where `true` (the group leader) exits at once and `sleep` runs on. Only
// meaningful on macOS (the fallback is a no-op elsewhere), so gate it there.
#[cfg(target_os = "macos")]
#[test]
fn foreground_resolves_when_group_leader_has_exited() {
    use_bash();
    let mgr = PtyManager::new();
    let (on_output, on_exit, _buf, _rx) = sinks();

    mgr.spawn("fg3".into(), cwd(), 80, 24, on_output, on_exit)
        .expect("spawn ok");

    std::thread::sleep(Duration::from_millis(300));
    // Interactive job control so the pipeline gets its OWN process group led by
    // the first stage. `true` exits immediately (dead leader); `sleep` lives on
    // as a group member still owning the tty foreground.
    mgr.write("fg3", b"true | sleep 30\n").expect("write ok");

    // Direct pgid-as-pid resolution would read idle (leader gone); the fallback
    // must surface the live member's name.
    assert!(
        wait_for_foreground(&mgr, "fg3", "sleep"),
        "foreground must resolve a live group member when the leader has exited; got {:?}",
        mgr.foreground("fg3")
    );

    let _ = mgr.kill("fg3");
}
