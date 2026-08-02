#![cfg(windows)]

// Real ConPTY integration tests. These use the platform-selected PowerShell/cmd
// and exercise the same manager/event seam as the frontend.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{io::BufRead, process::Stdio};

use base64::Engine as _;
use kodade_lib::process_tree::{
    direct_child_creation_is_valid_for_test, force_next_session_job_assignment_failure_for_test,
    forge_next_snapshot_parent_edge_for_test, prepare_spawn, process_is_running,
    run_during_next_teardown_for_test, ProcessTree,
};
use kodade_lib::pty::{ExitSink, OutputSink, PtyManager};
use kodade_lib::shell::{ShellEnvironment, ShellKind};

type TestSinks = (
    OutputSink,
    ExitSink,
    Arc<Mutex<Vec<u8>>>,
    Receiver<Option<i32>>,
);

fn sinks() -> TestSinks {
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let output_buffer = buffer.clone();
    let on_output: OutputSink = Arc::new(move |_id, data| {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .unwrap();
        output_buffer.lock().unwrap().extend_from_slice(&bytes);
    });
    let (tx, rx): (Sender<Option<i32>>, Receiver<Option<i32>>) = channel();
    let on_exit: ExitSink = Arc::new(move |_id, code| {
        let _ = tx.send(code);
    });
    (on_output, on_exit, buffer, rx)
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("kodade ConPTY Kødade {tag} {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn shell_command(powershell: &str, cmd: &str) -> Vec<u8> {
    let script = match ShellEnvironment::current().kind() {
        ShellKind::PowerShell => powershell,
        ShellKind::Cmd => cmd,
        ShellKind::Posix => unreachable!("Windows must select PowerShell or cmd"),
    };
    format!("{script}\r").into_bytes()
}

fn output_text(buffer: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&buffer.lock().unwrap()).to_string()
}

fn file_has_content(path: &std::path::Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > 0)
}

fn wait_for_file(path: &std::path::Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if file_has_content(path) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn wait_for_output(buffer: &Arc<Mutex<Vec<u8>>>, needle: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if output_text(buffer).contains(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

// portable-pty asks the terminal for its cursor position while inheriting the
// Windows console cursor. xterm replies automatically in production; the test
// sink must complete the same handshake before interactive shell input flows.
fn complete_cursor_handshake(mgr: &PtyManager, id: &str, buffer: &Arc<Mutex<Vec<u8>>>) {
    assert!(
        wait_for_output(buffer, "\x1b[6n"),
        "ConPTY should request the terminal cursor position"
    );
    mgr.write(id, b"\x1b[1;1R")
        .expect("cursor-position reply should write");
}

fn wait_until_stopped(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !process_is_running(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn pid_after_marker(text: &str, marker: &str) -> Option<u32> {
    text.match_indices(marker).find_map(|(index, _)| {
        let suffix = &text[index + marker.len()..];
        let digits: String = suffix
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
    })
}

fn wait_for_pid(buffer: &Arc<Mutex<Vec<u8>>>, marker: &str) -> Option<u32> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Some(pid) = pid_after_marker(&output_text(buffer), marker) {
            return Some(pid);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn spawn_descendant(mgr: &PtyManager, id: &str, buffer: &Arc<Mutex<Vec<u8>>>) -> u32 {
    let command = shell_command(
        "$p = Start-Process -PassThru powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 30'; Write-Output ('KODADE-CHILD-' + $p.Id)",
        "powershell.exe -NoLogo -NoProfile -Command \"$p = Start-Process -PassThru powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30'; Write-Output ('KODADE-CHILD-' + $p.Id)\"",
    );
    mgr.write(id, &command)
        .expect("descendant command should write");
    let child_pid =
        wait_for_pid(buffer, "KODADE-CHILD-").expect("PowerShell should report the descendant pid");
    assert!(
        process_is_running(child_pid),
        "descendant should start alive"
    );
    child_pid
}

#[test]
fn conpty_handles_cwd_unicode_output_resize_and_exit() {
    let dir = temp_dir("heartbeat");
    let mgr = PtyManager::new();
    let (on_output, on_exit, buffer, rx) = sinks();
    mgr.spawn(
        "heartbeat".into(),
        dir.to_string_lossy().to_string(),
        80,
        24,
        on_output,
        on_exit,
    )
    .expect("ConPTY shell should start");
    complete_cursor_handshake(&mgr, "heartbeat", &buffer);

    std::thread::sleep(Duration::from_millis(400));
    mgr.resize("heartbeat", 120, 40)
        .expect("resize should work");
    mgr.write(
        "heartbeat",
        &shell_command(
            "Write-Output 'KODADE-UNICODE-✓'; Write-Output ('KODADE-CWD-' + (Get-Location).Path)",
            "chcp 65001 >nul & echo KODADE-UNICODE-✓ & echo KODADE-CWD-%CD%",
        ),
    )
    .expect("write should work");

    assert!(wait_for_output(&buffer, "KODADE-UNICODE-✓"));
    assert!(wait_for_output(&buffer, "KODADE-CWD-"));
    assert!(output_text(&buffer).contains("kodade ConPTY Kødade heartbeat"));

    mgr.write("heartbeat", &shell_command("exit", "exit"))
        .expect("exit write should work");
    rx.recv_timeout(Duration::from_secs(8))
        .expect("exit event should fire");
    assert!(mgr.resize("heartbeat", 80, 24).is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn conpty_ctrl_c_interrupts_a_command_and_returns_to_the_shell() {
    let marker_dir = temp_dir("interrupt recovery marker");
    let started_marker = marker_dir.join("started ünicode.txt");
    let missed_marker = marker_dir.join("missed ünicode.txt");
    let recovered_marker = marker_dir.join("recovered ünicode.txt");
    let mgr = PtyManager::new();
    let (on_output, on_exit, buffer, rx) = sinks();
    mgr.spawn(
        "interrupt".into(),
        String::new(),
        80,
        24,
        on_output,
        on_exit,
    )
    .expect("ConPTY shell should start");
    complete_cursor_handshake(&mgr, "interrupt", &buffer);

    let powershell_started = started_marker.to_string_lossy().replace('\'', "''");
    let powershell_missed = missed_marker.to_string_lossy().replace('\'', "''");
    let powershell_long_command = format!(
        "Set-Content -LiteralPath '{powershell_started}' -Value 'started' -NoNewline; Start-Sleep -Seconds 30; Set-Content -LiteralPath '{powershell_missed}' -Value 'missed' -NoNewline"
    );
    let cmd_long_command = format!(
        "echo started>\"{}\" & ping.exe -n 31 127.0.0.1 >nul & echo missed>\"{}\"",
        started_marker.display(),
        missed_marker.display()
    );
    mgr.write(
        "interrupt",
        &shell_command(&powershell_long_command, &cmd_long_command),
    )
    .expect("long command should write");
    let started = wait_for_file(&started_marker, Duration::from_secs(8));

    let mut recovered = false;
    if started && !file_has_content(&missed_marker) {
        mgr.write("interrupt", b"\x03")
            .expect("Ctrl-C should reach ConPTY");
        let powershell_recovered = recovered_marker.to_string_lossy().replace('\'', "''");
        let powershell_recovery = format!(
            "Set-Content -LiteralPath '{powershell_recovered}' -Value 'recovered' -NoNewline"
        );
        let cmd_recovery = format!("echo recovered>\"{}\"", recovered_marker.display());
        let recovery = shell_command(&powershell_recovery, &cmd_recovery);
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && !file_has_content(&recovered_marker) {
            mgr.write("interrupt", &recovery)
                .expect("shell should accept input after Ctrl-C");
            std::thread::sleep(Duration::from_millis(500));
        }
        recovered = file_has_content(&recovered_marker);
    }
    let missed = file_has_content(&missed_marker);
    let failure_output = output_text(&buffer);

    mgr.kill("interrupt")
        .expect("interrupt session should kill");
    rx.recv_timeout(Duration::from_secs(8))
        .expect("interrupt session should emit exit");
    let _ = std::fs::remove_dir_all(marker_dir);
    assert!(
        started,
        "long command never executed its start side effect; ConPTY output: {failure_output}"
    );
    assert!(
        recovered,
        "shell did not execute a recovery side effect after Ctrl-C; ConPTY output: {failure_output}"
    );
    assert!(
        !missed,
        "long command reached its post-sleep side effect instead of being interrupted; ConPTY output: {failure_output}"
    );
}

#[test]
fn duplicate_id_is_rejected_and_fast_exit_releases_it() {
    let mgr = PtyManager::new();
    let (on_output, on_exit, buffer, rx) = sinks();
    mgr.spawn(
        "duplicate".into(),
        String::new(),
        80,
        24,
        on_output,
        on_exit,
    )
    .expect("first spawn should work");
    complete_cursor_handshake(&mgr, "duplicate", &buffer);

    let (second_output, second_exit, _, _) = sinks();
    let error = mgr
        .spawn(
            "duplicate".into(),
            String::new(),
            80,
            24,
            second_output,
            second_exit,
        )
        .expect_err("duplicate live id must fail");
    assert!(error.contains("already in use"));

    mgr.write("duplicate", &shell_command("exit", "exit"))
        .expect("fast exit should write");
    rx.recv_timeout(Duration::from_secs(8))
        .expect("fast exit should emit once");
    assert!(mgr.resize("duplicate", 80, 24).is_err());

    let (reuse_output, reuse_exit, reuse_buffer, reuse_rx) = sinks();
    mgr.spawn(
        "duplicate".into(),
        String::new(),
        80,
        24,
        reuse_output,
        reuse_exit,
    )
    .expect("an id should be reusable after its previous shell exits");
    complete_cursor_handshake(&mgr, "duplicate", &reuse_buffer);
    mgr.write(
        "duplicate",
        &shell_command("Write-Output 'KODADE-ID-REUSED'", "echo KODADE-ID-REUSED"),
    )
    .expect("reused session should accept input");
    assert!(wait_for_output(&reuse_buffer, "KODADE-ID-REUSED"));
    mgr.kill("duplicate").expect("reused session should kill");
    reuse_rx
        .recv_timeout(Duration::from_secs(8))
        .expect("reused session should emit exit");
}

#[test]
fn foreground_has_an_honest_shell_fallback() {
    let shell_name = ShellEnvironment::current().display_name();
    let mgr = PtyManager::new();
    let (on_output, on_exit, _buffer, rx) = sinks();
    mgr.spawn(
        "foreground".into(),
        String::new(),
        80,
        24,
        on_output,
        on_exit,
    )
    .expect("spawn should work");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut observed = None;
    while Instant::now() < deadline {
        observed = mgr.foreground("foreground");
        if observed.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(observed.as_deref(), Some(shell_name.as_str()));
    assert!(mgr.foreground("missing").is_none());

    mgr.kill("foreground").expect("kill should work");
    rx.recv_timeout(Duration::from_secs(8))
        .expect("kill should emit exit");
}

#[test]
fn job_object_kills_a_spawned_descendant() {
    let mgr = PtyManager::new();
    let (on_output, on_exit, buffer, rx) = sinks();
    mgr.spawn("tree".into(), String::new(), 80, 24, on_output, on_exit)
        .expect("spawn should work");
    complete_cursor_handshake(&mgr, "tree", &buffer);
    std::thread::sleep(Duration::from_millis(400));

    let child_pid = spawn_descendant(&mgr, "tree", &buffer);

    mgr.kill("tree")
        .expect("Job Object termination should work");
    rx.recv_timeout(Duration::from_secs(8))
        .expect("tree kill should emit exit");
    assert!(
        wait_until_stopped(child_pid),
        "descendant {child_pid} survived PTY teardown"
    );
}

#[test]
fn retained_identity_exposes_the_attached_pid_and_creation_filetime() {
    prepare_spawn().expect("root Job Object should be ready before direct spawn");
    let mut child = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("identity root should spawn");
    let tree = ProcessTree::attach_child(&child);

    let (retained_pid, creation_filetime) = tree
        .retained_identity()
        .expect("the child should expose its retained Windows identity");
    assert_eq!(retained_pid, child.id());
    assert!(creation_filetime > 0, "creation FILETIME must be populated");

    tree.terminate().expect("identity root should terminate");
    child.wait().expect("identity root should be reapable");
}

#[test]
fn retained_handle_fallback_is_idempotent_through_drop() {
    prepare_spawn().expect("root Job Object should be ready before direct spawn");
    // This process predates the fallback root. The test seam forges a stale
    // ToolHelp parent edge to that newer root; creation-time validation must
    // reject it rather than terminating an unrelated retained handle.
    let mut stale_candidate = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("stale candidate should spawn");
    let mut child = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "$p = Start-Process -PassThru powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 30'; Write-Output ('KODADE-CHILD-' + $p.Id); Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("fallback root should spawn");

    force_next_session_job_assignment_failure_for_test();
    let tree = ProcessTree::attach_child(&child);
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().expect("capture fallback pid"))
        .read_line(&mut line)
        .expect("read fallback descendant pid");
    let child_pid = pid_after_marker(&line, "KODADE-CHILD-")
        .expect("fallback root should report descendant pid");
    assert!(process_is_running(child_pid));

    forge_next_snapshot_parent_edge_for_test(stale_candidate.id());
    tree.terminate()
        .expect("retained-handle fallback should terminate once");
    tree.terminate()
        .expect("a repeated termination should be an idempotent no-op");
    drop(tree); // Drop must not repeat a completed identity-bound sweep.
    child.wait().expect("fallback root should be reapable");
    assert!(
        wait_until_stopped(child_pid),
        "fallback descendant {child_pid} survived retained-handle teardown"
    );
    assert!(
        stale_candidate
            .try_wait()
            .expect("query stale candidate")
            .is_none(),
        "forged stale parent edge terminated an unrelated process"
    );
    stale_candidate.kill().expect("clean up stale candidate");
    stale_candidate.wait().expect("reap stale candidate");
}

#[test]
fn direct_child_time_bounds_reject_stale_and_post_exit_identities() {
    // 99 is an older process behind a stale parent edge; 201 models a new
    // process reusing the root PID after the original root exited at 200.
    assert!(!direct_child_creation_is_valid_for_test(100, 200, 99));
    assert!(direct_child_creation_is_valid_for_test(100, 200, 150));
    assert!(!direct_child_creation_is_valid_for_test(100, 200, 201));
    assert!(direct_child_creation_is_valid_for_test(100, 0, 201));
}

#[test]
fn fallback_reenumerates_a_descendant_created_during_teardown() {
    prepare_spawn().expect("root Job Object should be ready before direct spawn");
    let mut root = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("teardown root should spawn");
    force_next_session_job_assignment_failure_for_test();
    let tree = ProcessTree::attach_child(&root);

    let late_child = Arc::new(Mutex::new(None));
    let hook_child = late_child.clone();
    run_during_next_teardown_for_test(move || {
        let child = std::process::Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("late descendant should spawn");
        forge_next_snapshot_parent_edge_for_test(child.id());
        *hook_child.lock().unwrap() = Some(child);
    });

    tree.terminate()
        .expect("post-stop enumeration should quiesce the fallback tree");
    root.wait().expect("teardown root should be reapable");
    let mut late_child = late_child
        .lock()
        .unwrap()
        .take()
        .expect("teardown hook should create a descendant");
    let late_pid = late_child.id();
    late_child
        .wait()
        .expect("late descendant should be reapable");
    assert!(
        !process_is_running(late_pid),
        "descendant {late_pid} created during teardown survived"
    );
}

#[test]
fn kill_all_terminates_every_conpty_session() {
    let mgr = PtyManager::new();
    let mut exits = Vec::new();
    let mut descendant_pid = None;
    for id in ["all-one", "all-two"] {
        let (on_output, on_exit, buffer, rx) = sinks();
        mgr.spawn(id.into(), String::new(), 80, 24, on_output, on_exit)
            .expect("spawn should work");
        if id == "all-one" {
            complete_cursor_handshake(&mgr, id, &buffer);
            std::thread::sleep(Duration::from_millis(400));
            descendant_pid = Some(spawn_descendant(&mgr, id, &buffer));
        }
        exits.push((id, rx));
    }

    mgr.kill_all();
    for (id, rx) in exits {
        rx.recv_timeout(Duration::from_secs(8))
            .unwrap_or_else(|_| panic!("{id} should emit exit after kill_all"));
        assert!(mgr.resize(id, 80, 24).is_err());
    }
    let descendant_pid = descendant_pid.expect("kill_all test should spawn a descendant");
    assert!(
        wait_until_stopped(descendant_pid),
        "descendant {descendant_pid} survived kill_all"
    );
}
