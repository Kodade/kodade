// Cross-platform process-tree lifecycle.
//
// portable-pty exposes a ConPTY child only after CreateProcess and cannot pass
// PROC_THREAD_ATTRIBUTE_JOB_LIST at process creation. A per-session Job Object
// therefore has a small post-spawn assignment race. Windows closes that gap with
// a process-wide root Job Object established BEFORE any Kodade child spawn;
// children inherit it automatically, and KILL_ON_JOB_CLOSE guarantees cleanup
// when the app exits. Per-session jobs still provide targeted teardown. Closing
// a session also snapshots its parent chain before stopping the shell, then
// explicitly terminates those recorded descendants after the shell stops, which
// covers children created before per-session assignment completed.

use std::process::Child;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};

pub struct ProcessTree {
    pid: u32,
    #[cfg(windows)]
    job: Option<windows::JobHandle>,
    #[cfg(windows)]
    root: Option<windows::ProcessIdentity>,
    #[cfg(windows)]
    terminated: AtomicBool,
}

// Must run before spawning any PTY, shell probe, provider, or gh process.
pub fn prepare_spawn() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::ensure_root_job()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

impl ProcessTree {
    // Best-effort per-child assignment. The process already inherited the root
    // job before this call; a fast exit or assignment failure therefore cannot
    // escape app-exit cleanup, and targeted teardown falls back to retained
    // identity-bound process handles.
    pub fn attach(pid: u32) -> Self {
        #[cfg(windows)]
        {
            let root = match windows::ProcessIdentity::open_root(pid) {
                Ok(root) => Some(root),
                Err(error) => {
                    eprintln!("kodade: process {pid}: root identity unavailable: {error}");
                    None
                }
            };
            let job = match root
                .as_ref()
                .ok_or_else(|| "root identity unavailable".to_string())
                .and_then(windows::attach_session_job)
            {
                Ok(job) => Some(job),
                Err(error) => {
                    eprintln!("kodade: process {pid}: per-session Job Object unavailable: {error}");
                    None
                }
            };
            Self {
                pid,
                job,
                root,
                terminated: AtomicBool::new(false),
            }
        }
        #[cfg(not(windows))]
        {
            Self { pid }
        }
    }

    pub fn attach_child(child: &Child) -> Self {
        Self::attach(child.id())
    }

    // Exact identity retained by the Windows process handle. Callers may read
    // it for proof/correlation, but cannot mutate or replace the handle.
    #[cfg(windows)]
    pub fn retained_identity(&self) -> Option<(u32, u64)> {
        self.root.as_ref().map(windows::ProcessIdentity::identity)
    }

    pub fn terminate(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if self.terminated.load(Ordering::Acquire) {
                return Ok(());
            }
            let result = windows::terminate_tree(self.pid, self.root.as_ref(), self.job.as_ref());
            if result.is_ok() {
                self.terminated.store(true, Ordering::Release);
            }
            result
        }
        #[cfg(unix)]
        {
            let rc = unsafe { libc::kill(-(self.pid as i32), libc::SIGKILL) };
            if rc == 0 {
                Ok(())
            } else {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(())
                } else {
                    Err(format!("terminate process group {}: {error}", self.pid))
                }
            }
        }
        #[cfg(all(not(unix), not(windows)))]
        {
            Err("process-tree termination is unsupported on this platform".to_string())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // Natural shell/probe exit must also clean up disowned descendants.
        let _ = self.terminate();
    }
}

// Terminate through the tree first, with Child::kill as a last-resort fallback.
pub fn terminate_child(tree: &ProcessTree, child: &mut Child) {
    if tree.terminate().is_err() {
        let _ = child.kill();
    }
}

#[cfg(windows)]
pub fn process_is_running(pid: u32) -> bool {
    windows::process_is_running(pid)
}

// Debug-only integration seam: fail exactly the next per-session assignment on
// this thread without interfering with the process-wide root Job Object.
#[cfg(all(windows, debug_assertions))]
#[doc(hidden)]
pub fn force_next_session_job_assignment_failure_for_test() {
    windows::force_next_session_job_assignment_failure();
}

#[cfg(all(windows, debug_assertions))]
#[doc(hidden)]
pub fn forge_next_snapshot_parent_edge_for_test(pid: u32) {
    windows::forge_next_snapshot_parent_edge(pid);
}

#[cfg(all(windows, debug_assertions))]
#[doc(hidden)]
pub fn direct_child_creation_is_valid_for_test(
    root_creation: u64,
    root_exit: u64,
    child_creation: u64,
) -> bool {
    windows::direct_child_creation_is_valid(root_creation, root_exit, child_creation)
}

#[cfg(all(windows, debug_assertions))]
#[doc(hidden)]
pub fn run_during_next_teardown_for_test(hook: impl FnOnce() + 'static) {
    windows::run_during_next_teardown(Box::new(hook));
}

#[cfg(windows)]
mod windows {
    #[cfg(debug_assertions)]
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::sync::OnceLock;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    static ROOT_JOB: OnceLock<Result<JobHandle, String>> = OnceLock::new();
    #[cfg(debug_assertions)]
    thread_local! {
        static FORCE_NEXT_SESSION_ASSIGNMENT_FAILURE: Cell<bool> = const { Cell::new(false) };
        static FORGED_SNAPSHOT_PARENT_EDGE: Cell<Option<u32>> = const { Cell::new(None) };
        static TEARDOWN_HOOK: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
    }

    pub(super) fn ensure_root_job() -> Result<(), String> {
        ROOT_JOB
            .get_or_init(|| JobHandle::attach(std::process::id()))
            .as_ref()
            .map(|_| ())
            .map_err(Clone::clone)
    }

    pub(super) fn attach_session_job(process: &ProcessIdentity) -> Result<JobHandle, String> {
        #[cfg(debug_assertions)]
        if FORCE_NEXT_SESSION_ASSIGNMENT_FAILURE.with(|force| force.replace(false)) {
            return Err("forced per-session Job Object assignment failure".to_string());
        }
        JobHandle::attach_process(process)
    }

    #[cfg(debug_assertions)]
    pub(super) fn force_next_session_job_assignment_failure() {
        FORCE_NEXT_SESSION_ASSIGNMENT_FAILURE.with(|force| force.set(true));
    }

    #[cfg(debug_assertions)]
    pub(super) fn forge_next_snapshot_parent_edge(pid: u32) {
        FORGED_SNAPSHOT_PARENT_EDGE.with(|forged| forged.set(Some(pid)));
    }

    #[cfg(debug_assertions)]
    pub(super) fn run_during_next_teardown(hook: Box<dyn FnOnce()>) {
        TEARDOWN_HOOK.with(|slot| *slot.borrow_mut() = Some(hook));
    }

    #[cfg(debug_assertions)]
    fn run_teardown_hook() {
        if let Some(hook) = TEARDOWN_HOOK.with(|slot| slot.borrow_mut().take()) {
            hook();
        }
    }

    pub(super) struct JobHandle(HANDLE);

    // A Job Object handle is an owned kernel handle. Windows permits it to move
    // between threads, and all operations here are thread-safe kernel calls.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        pub(super) fn attach(pid: u32) -> Result<Self, String> {
            let process = ProcessIdentity::open_root(pid)?;
            Self::attach_process(&process)
        }

        fn attach_process(process: &ProcessIdentity) -> Result<Self, String> {
            let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw_job.is_null() {
                return Err(last_error("create Windows Job Object"));
            }
            let job = Self(raw_job);

            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(last_error("configure Windows Job Object"));
            }

            if unsafe { AssignProcessToJobObject(job.0, process.handle.0) } == 0 {
                return Err(last_error(&format!(
                    "assign process {} to Job Object",
                    process.pid
                )));
            }
            Ok(job)
        }

        fn terminate(&self) -> Result<(), String> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                Err(last_error("terminate Windows Job Object"))
            } else {
                Ok(())
            }
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    struct OwnedHandle(HANDLE);

    // Owned kernel handles may be used from any thread; CloseHandle and the
    // process APIs used here are thread-safe.
    unsafe impl Send for OwnedHandle {}
    unsafe impl Sync for OwnedHandle {}

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[derive(Clone, Copy)]
    struct ProcessEntry {
        pid: u32,
        parent: u32,
    }

    pub(super) struct ProcessIdentity {
        pid: u32,
        handle: OwnedHandle,
        creation_time: u64,
    }

    impl ProcessIdentity {
        pub(super) fn open_root(pid: u32) -> Result<Self, String> {
            Self::open(pid, PROCESS_SET_QUOTA)
        }

        fn open_candidate(pid: u32) -> Result<Self, String> {
            Self::open(pid, 0)
        }

        fn open(pid: u32, extra_access: u32) -> Result<Self, String> {
            let access =
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE | extra_access;
            let raw = unsafe { OpenProcess(access, 0, pid) };
            if raw.is_null() {
                Err(last_error(&format!(
                    "open process {pid} for retained identity"
                )))
            } else {
                let handle = OwnedHandle(raw);
                let (creation_time, _) = process_times(handle.0, pid)?;
                Ok(Self {
                    pid,
                    handle,
                    creation_time,
                })
            }
        }

        pub(super) fn identity(&self) -> (u32, u64) {
            (self.pid, self.creation_time)
        }

        fn exit_time(&self) -> Result<u64, String> {
            process_times(self.handle.0, self.pid).map(|(_, exit)| exit)
        }

        fn is_running(&self) -> bool {
            self.exit_time() == Ok(0)
        }

        fn terminate(&self) -> Result<(), String> {
            if self.exit_time()? != 0 {
                return Ok(());
            }
            if unsafe { TerminateProcess(self.handle.0, 1) } == 0 {
                Err(last_error(&format!(
                    "terminate retained process {}",
                    self.pid
                )))
            } else {
                Ok(())
            }
        }

        fn wait_for_exit(&self, timeout: Duration) -> Result<(), String> {
            let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
            match unsafe { WaitForSingleObject(self.handle.0, timeout_ms) } {
                WAIT_OBJECT_0 => Ok(()),
                WAIT_TIMEOUT => Err(format!(
                    "process {} did not stop within {timeout_ms}ms",
                    self.pid
                )),
                _ => Err(last_error(&format!("wait for process {} exit", self.pid))),
            }
        }
    }

    pub(super) fn terminate_tree(
        root_pid: u32,
        root: Option<&ProcessIdentity>,
        job: Option<&JobHandle>,
    ) -> Result<(), String> {
        const MAX_POST_STOP_PASSES: usize = 16;

        // Resolve the parent chain and retain identity-bound process handles
        // before stopping anything. A PID is never reopened after this point.
        let mut descendants = match root {
            Some(root) => descendant_handles(root)?,
            None => Vec::new(),
        };

        #[cfg(debug_assertions)]
        run_teardown_hook();

        let targeted_result = match job {
            Some(job) => job.terminate(),
            None => root
                .ok_or_else(|| format!("retained root identity unavailable for process {root_pid}"))
                .and_then(ProcessIdentity::terminate),
        };
        let root_stop_result = root
            .ok_or_else(|| format!("retained root identity unavailable for process {root_pid}"))
            .and_then(|root| root.wait_for_exit(Duration::from_millis(500)));

        // The shell is stopped now. Kill deepest descendants first so nothing can
        // remain alive merely because it was created before per-session attach.
        descendants.sort_by_key(|(_, depth)| std::cmp::Reverse(*depth));
        for (process, _) in descendants {
            let _ = process.terminate();
        }

        // A descendant can be created after the first snapshot but before the
        // root actually stops. Re-enumerate from the retained root identity
        // until one full post-stop pass observes no validated descendants.
        for _ in 0..MAX_POST_STOP_PASSES {
            let Some(root) = root else {
                break;
            };
            let mut late_descendants = descendant_handles(root)?;
            if late_descendants.is_empty() {
                targeted_result?;
                return root_stop_result;
            }
            late_descendants.sort_by_key(|(_, depth)| std::cmp::Reverse(*depth));
            for (process, _) in late_descendants {
                let _ = process.terminate();
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        targeted_result?;
        root_stop_result?;
        Err(format!(
            "Windows process tree {root_pid} did not quiesce after {MAX_POST_STOP_PASSES} passes"
        ))
    }

    fn descendant_handles(root: &ProcessIdentity) -> Result<Vec<(ProcessIdentity, usize)>, String> {
        let mut entries = process_entries()?;
        #[cfg(debug_assertions)]
        if let Some(forged_pid) = FORGED_SNAPSHOT_PARENT_EDGE.with(|forged| forged.take()) {
            if let Some(entry) = entries.iter_mut().find(|entry| entry.pid == forged_pid) {
                entry.parent = root.pid;
            } else {
                entries.push(ProcessEntry {
                    pid: forged_pid,
                    parent: root.pid,
                });
            }
        }
        let by_pid: HashMap<u32, ProcessEntry> =
            entries.iter().map(|entry| (entry.pid, *entry)).collect();
        let candidates: HashMap<u32, ProcessIdentity> = entries
            .iter()
            .filter(|entry| entry.pid != root.pid)
            // PID ancestry is only a candidate selector. No selected handle is
            // acted on until every edge passes creation-time validation below.
            .filter(|entry| raw_descendant_depth(entry.pid, root.pid, &by_pid).is_some())
            .filter_map(|entry| {
                ProcessIdentity::open_candidate(entry.pid)
                    .ok()
                    .filter(ProcessIdentity::is_running)
                    .map(|process| (entry.pid, process))
            })
            .collect();
        let root_exit_time = root.exit_time()?;
        let valid_depths: HashMap<u32, usize> = candidates
            .keys()
            .filter_map(|pid| {
                validated_descendant_depth(*pid, root, root_exit_time, &by_pid, &candidates)
                    .map(|depth| (*pid, depth))
            })
            .collect();
        Ok(candidates
            .into_iter()
            .filter_map(|(pid, process)| valid_depths.get(&pid).map(|depth| (process, *depth)))
            .collect())
    }

    fn raw_descendant_depth(
        pid: u32,
        root_pid: u32,
        entries: &HashMap<u32, ProcessEntry>,
    ) -> Option<usize> {
        let mut current = pid;
        for depth in 1..=entries.len() {
            let entry = entries.get(&current)?;
            if entry.parent == root_pid {
                return Some(depth);
            }
            if entry.parent == 0 || entry.parent == current {
                return None;
            }
            current = entry.parent;
        }
        None
    }

    fn validated_descendant_depth(
        pid: u32,
        root: &ProcessIdentity,
        root_exit_time: u64,
        entries: &HashMap<u32, ProcessEntry>,
        identities: &HashMap<u32, ProcessIdentity>,
    ) -> Option<usize> {
        let mut current = pid;
        let mut child_creation = identities.get(&current)?.creation_time;
        for depth in 1..=entries.len() {
            let entry = entries.get(&current)?;
            if entry.parent == root.pid {
                return direct_child_creation_is_valid(
                    root.creation_time,
                    root_exit_time,
                    child_creation,
                )
                .then_some(depth);
            }
            if entry.parent == 0 || entry.parent == current {
                return None;
            }
            let parent = identities.get(&entry.parent)?;
            if child_creation < parent.creation_time {
                return None;
            }
            current = entry.parent;
            child_creation = parent.creation_time;
        }
        None
    }

    fn filetime_value(value: FILETIME) -> u64 {
        ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
    }

    pub(super) fn direct_child_creation_is_valid(
        root_creation: u64,
        root_exit: u64,
        child_creation: u64,
    ) -> bool {
        child_creation >= root_creation && (root_exit == 0 || child_creation <= root_exit)
    }

    fn process_times(handle: HANDLE, pid: u32) -> Result<(u64, u64), String> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            Err(last_error(&format!("read process times for process {pid}")))
        } else {
            Ok((filetime_value(creation), filetime_value(exit)))
        }
    }

    fn process_entries() -> Result<Vec<ProcessEntry>, String> {
        let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw_snapshot == INVALID_HANDLE_VALUE {
            return Err(last_error("snapshot Windows processes"));
        }
        let snapshot = OwnedHandle(raw_snapshot);
        let mut native = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if unsafe { Process32FirstW(snapshot.0, &mut native) } == 0 {
            return Err(last_error("read first Windows process snapshot entry"));
        }

        let mut entries = Vec::new();
        loop {
            entries.push(ProcessEntry {
                pid: native.th32ProcessID,
                parent: native.th32ParentProcessID,
            });
            if unsafe { Process32NextW(snapshot.0, &mut native) } == 0 {
                break;
            }
        }
        Ok(entries)
    }

    pub(super) fn process_is_running(pid: u32) -> bool {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            return false;
        }
        let process = OwnedHandle(raw);
        let mut code = 0;
        unsafe { GetExitCodeProcess(process.0, &mut code) != 0 && code == STILL_ACTIVE as u32 }
    }

    fn last_error(context: &str) -> String {
        format!("{context}: {}", std::io::Error::last_os_error())
    }
}
