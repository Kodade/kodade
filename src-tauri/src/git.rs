// KödPR's read-only `git` surface. Mirrors github.rs's discipline exactly: the
// binary is resolved once through the login shell, the argv is validated against
// a fixed allowlist of read-only command shapes here in Rust, and the shared
// runner prepends fixed hermetic config and execs it directly (no shell) from
// the project root with a 10s timeout and a 1 MiB output cap. KödPR NEVER writes
// to the repository — there is no
// add/commit/checkout/merge/push shape, and no shape can execute arbitrary code
// (`-c`, `--exec-path`, `--upload-pack`, alias hooks are all rejected). Rust
// never parses git output; TypeScript (M12b) does all the interpretation.

use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use crate::exec::{run_exec, ExecEnvironment, ProcOutput};
use crate::shell::ShellEnvironment;

const GIT_TIMEOUT: Duration = Duration::from_secs(10);
// The commit line format for `log`: hash, subject, author name, author date,
// each field NUL-separated so TypeScript splits it faithfully.
const LOG_FORMAT: &str = "--format=%H%x00%s%x00%an%x00%aI";
// The longest ref/path we will hand to git. Well past any real branch name, but
// a hard ceiling so a pathological argument can't balloon the command line.
const MAX_ARG_LEN: usize = 256;
static GIT_BINARY: OnceLock<Result<std::path::PathBuf, String>> = OnceLock::new();
const HERMETIC_CONFIG: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "diff.external=",
    "-c",
    "core.pager=cat",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
}

fn validate_args(args: &[String]) -> Result<(), String> {
    let Some((subcommand, rest)) = args.split_first() else {
        return Err("git subcommand is required".to_string());
    };

    match subcommand.as_str() {
        "status" => exact(rest, &["--porcelain=v2", "-z"]),
        "rev-parse" => match rest {
            [flag, head] if flag == "--abbrev-ref" && head == "HEAD" => Ok(()),
            [flag, reference] if flag == "--verify" => validate_ref(reference),
            _ => Err("git rev-parse shape is not allowed".to_string()),
        },
        "merge-base" => match rest {
            [reference, head] if head == "HEAD" => validate_ref(reference),
            _ => Err("git merge-base shape is not allowed".to_string()),
        },
        "branch" => exact(rest, &["--list", "--format=%(refname:short)"]),
        "worktree" => exact(rest, &["list", "--porcelain"]),
        "diff" => validate_diff(rest),
        "log" => validate_log(rest),
        _ => Err(format!("git command is not allowed: {subcommand}")),
    }
}

// Working-tree/branch diffs. `--numstat -z` reports churn (optionally for a
// `<base>...HEAD` branch range); `--no-color -- <path>` reads one file's diff
// (optionally for the same range). No other flags, and the path is a single
// validated relative path.
fn validate_diff(rest: &[String]) -> Result<(), String> {
    match rest {
        [a, b] if a == "--numstat" && b == "-z" => Ok(()),
        [a, b, range] if a == "--numstat" && b == "-z" => validate_diff_range(range),
        [a, sep, path] if a == "--no-color" && sep == "--" => validate_path(path),
        [a, range, sep, path] if a == "--no-color" && sep == "--" => {
            validate_diff_range(range)?;
            validate_path(path)
        }
        _ => Err("git diff shape is not allowed".to_string()),
    }
}

// Recent commits, optionally over a `<base>..HEAD` range. Fixed count and format.
fn validate_log(rest: &[String]) -> Result<(), String> {
    match rest {
        [count, format] if count == "--max-count=50" && format == LOG_FORMAT => Ok(()),
        [count, format, range] if count == "--max-count=50" && format == LOG_FORMAT => {
            validate_log_range(range)
        }
        _ => Err("git log shape is not allowed".to_string()),
    }
}

// A `<base>...HEAD` diff range: a validated base ref plus the literal `...HEAD`.
fn validate_diff_range(range: &str) -> Result<(), String> {
    let base = range
        .strip_suffix("...HEAD")
        .ok_or_else(|| format!("git diff range must be <base>...HEAD: {range}"))?;
    validate_ref(base)
}

// A `<base>..HEAD` log range: a validated base ref plus the literal `..HEAD`.
fn validate_log_range(range: &str) -> Result<(), String> {
    let base = range
        .strip_suffix("..HEAD")
        .ok_or_else(|| format!("git log range must be <base>..HEAD: {range}"))?;
    validate_ref(base)
}

// A ref name we will pass to git as a bare argument. It is never routed through
// a shell, but the constraints keep it from acting as a flag (`-`), a range
// (`..`), an option-injection, or an unbounded/control-laden string.
fn validate_ref(reference: &str) -> Result<(), String> {
    if reference.is_empty() {
        return Err("git ref must not be empty".to_string());
    }
    if reference.len() > MAX_ARG_LEN {
        return Err("git ref is too long".to_string());
    }
    if reference.starts_with('-') {
        return Err(format!("git ref must not start with '-': {reference}"));
    }
    if reference.contains("..") {
        return Err(format!("git ref must not contain '..': {reference}"));
    }
    if reference.chars().any(|c| c.is_control() || c == ' ') {
        return Err(format!("git ref has an invalid character: {reference}"));
    }
    Ok(())
}

// A single relative path inside the project. Rejects flags, absolute paths, and
// any `..` traversal component so a diff can never read outside the repo root.
fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("git path must not be empty".to_string());
    }
    if path.len() > MAX_ARG_LEN {
        return Err("git path is too long".to_string());
    }
    if path.starts_with('-') {
        return Err(format!("git path must not start with '-': {path}"));
    }
    // A leading ':' is git pathspec magic (e.g. ":(exclude)", ":/") — reject so
    // a path arg can never widen/narrow the diff beyond the literal file.
    if path.starts_with(':') {
        return Err(format!("git path must not start with ':': {path}"));
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err(format!("git path must be relative: {path}"));
    }
    // Reject a Windows drive-absolute path (e.g. C:\...), which is not relative.
    if path.as_bytes().get(1) == Some(&b':') {
        return Err(format!("git path must be relative: {path}"));
    }
    if path.chars().any(|c| c.is_control()) {
        return Err(format!("git path has an invalid character: {path}"));
    }
    // Any `..` component escapes the repo; check per-component on both separators.
    let traverses = path.split(['/', '\\']).any(|component| component == "..");
    if traverses {
        return Err(format!("git path must not traverse with '..': {path}"));
    }
    Ok(())
}

// rest matches the fixed token list exactly, in order, with no extras.
fn exact(rest: &[String], expected: &[&str]) -> Result<(), String> {
    if rest.len() == expected.len() && rest.iter().zip(expected).all(|(a, b)| a == b) {
        Ok(())
    } else {
        Err("git arguments do not match the approved command shape".to_string())
    }
}

fn hardened_args(approved: &[String]) -> Vec<String> {
    let (subcommand, rest) = approved.split_first().expect("validated git args");
    let mut args = HERMETIC_CONFIG
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    args.push("--no-pager".to_string());
    args.push("--no-optional-locks".to_string());
    args.push(subcommand.clone());
    if matches!(subcommand.as_str(), "diff" | "log") {
        args.push("--no-textconv".to_string());
        args.push("--no-ext-diff".to_string());
    }
    args.extend_from_slice(rest);
    args
}

pub fn run_git(
    shell: &ShellEnvironment,
    project_root: &Path,
    args: Vec<String>,
) -> Result<GitOutput, String> {
    validate_args(&args)?;
    let binary = GIT_BINARY
        .get_or_init(|| {
            crate::detect::resolve_binary(shell, "git")
                .ok_or_else(|| "git is not installed".to_string())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    // git was resolved once through the login-shell PATH and the argv already
    // crossed the allowlist above, so the shared runner execs it directly with
    // no shell in between.
    let args = hardened_args(&args);
    let out = run_exec(
        "git",
        binary,
        project_root,
        &args,
        GIT_TIMEOUT,
        ExecEnvironment::Git,
    )?;
    Ok(to_output(out))
}

fn to_output(out: ProcOutput) -> GitOutput {
    GitOutput {
        stdout: out.stdout,
        stderr: out.stderr,
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::run_git;
    use super::{validate_args, LOG_FORMAT};
    #[cfg(unix)]
    use crate::shell::ShellEnvironment;
    #[cfg(unix)]
    use std::process::Command;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    #[test]
    fn allows_only_the_exact_read_only_command_shapes() {
        for args in [
            vec!["status", "--porcelain=v2", "-z"],
            vec!["rev-parse", "--abbrev-ref", "HEAD"],
            vec!["rev-parse", "--verify", "main"],
            vec!["rev-parse", "--verify", "origin/feature/m12-kodpr"],
            vec!["merge-base", "main", "HEAD"],
            vec!["branch", "--list", "--format=%(refname:short)"],
            vec!["worktree", "list", "--porcelain"],
            vec!["diff", "--numstat", "-z"],
            vec!["diff", "--numstat", "-z", "main...HEAD"],
            vec!["diff", "--no-color", "--", "src/lib.rs"],
            vec!["diff", "--no-color", "main...HEAD", "--", "src/a/b.ts"],
            vec!["log", "--max-count=50", LOG_FORMAT],
            vec!["log", "--max-count=50", LOG_FORMAT, "main..HEAD"],
        ] {
            assert!(validate_args(&strings(&args)).is_ok(), "rejected {args:?}");
        }
        assert!(validate_args(&[]).is_err());
    }

    #[test]
    fn rejects_writes_injection_and_traversal() {
        for args in [
            // Write / mutating commands are absent from the allowlist entirely.
            vec!["push"],
            vec!["commit", "-m", "x"],
            vec!["add", "-A"],
            vec!["checkout", "main"],
            vec!["merge", "main"],
            vec!["reset", "--hard"],
            vec!["clean", "-fd"],
            // Code-execution / option-injection vectors.
            vec!["-c", "core.pager=sh -c whoami", "status"],
            vec!["diff", "--no-color", "--ext-diff", "--", "x"],
            vec!["log", "--max-count=50", LOG_FORMAT, "--upload-pack=sh"],
            // rev-parse with a ref that could act as a flag.
            vec!["rev-parse", "--verify", "-main"],
            vec!["merge-base", "--all", "HEAD"],
            // A `..` slipped into a plain ref (not a range position).
            vec!["rev-parse", "--verify", "a..b"],
            // Path traversal and absolute paths must be refused.
            vec!["diff", "--no-color", "--", "../secret"],
            vec!["diff", "--no-color", "--", "a/../../etc/passwd"],
            vec!["diff", "--no-color", "--", "/etc/passwd"],
            vec!["diff", "--no-color", "--", "-oops"],
            // Leading ':' is git pathspec magic — reject it too.
            vec!["diff", "--no-color", "--", ":(exclude)src"],
            vec!["diff", "--no-color", "--", ":/x"],
            // Malformed ranges.
            vec!["diff", "--numstat", "-z", "main..HEAD"],
            vec!["diff", "--numstat", "-z", "mainHEAD"],
            vec!["log", "--max-count=50", LOG_FORMAT, "mainHEAD"],
            // Right family, wrong shape.
            vec!["status", "--porcelain=v2"],
            vec!["status", "-z", "--porcelain=v2"],
            vec!["branch", "--list"],
            vec!["worktree", "prune"],
            vec!["log", "--max-count=100", LOG_FORMAT],
        ] {
            assert!(validate_args(&strings(&args)).is_err(), "accepted {args:?}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn malicious_textconv_and_fsmonitor_never_run_or_refresh_the_index() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let repo = root.path();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(repo)
                .status()
                .unwrap();
            assert!(status.success(), "git fixture command failed: {args:?}");
        };
        run(&["init", "--quiet"]);
        std::fs::write(repo.join("probe.evil"), "before\n").unwrap();
        std::fs::write(repo.join("clean.txt"), "clean\n").unwrap();
        std::fs::write(repo.join(".gitattributes"), "*.evil diff=malicious\n").unwrap();
        run(&["add", "probe.evil", "clean.txt", ".gitattributes"]);
        run(&[
            "-c",
            "user.name=Ködade Test",
            "-c",
            "user.email=test@kodade.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ]);

        let marker = repo.join("helper-ran");
        let helper = repo.join("malicious-helper.sh");
        std::fs::write(
            &helper,
            format!(
                "#!/bin/sh\nprintf invoked >> '{}'\nif [ -f \"$1\" ]; then cat \"$1\"; fi\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let hook = repo.join(".git/hooks/fsmonitor-watchman");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\nprintf hook >> '{}'\necho\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        run(&[
            "config",
            "diff.malicious.textconv",
            helper.to_str().unwrap(),
        ]);
        run(&["config", "core.fsmonitor", "true"]);

        std::thread::sleep(std::time::Duration::from_millis(1_100));
        std::fs::write(repo.join("clean.txt"), "clean\n").unwrap();
        std::fs::write(repo.join("probe.evil"), "after\n").unwrap();
        let index = repo.join(".git/index");
        let index_before = std::fs::read(&index).unwrap();
        let shell = ShellEnvironment::current();

        let diff = run_git(
            &shell,
            repo,
            strings(&["diff", "--no-color", "--", "probe.evil"]),
        )
        .unwrap();
        assert!(diff.stdout.contains("-before"));
        assert!(diff.stdout.contains("+after"));
        run_git(&shell, repo, strings(&["status", "--porcelain=v2", "-z"])).unwrap();

        assert!(!marker.exists(), "configured git helper executed");
        assert_eq!(std::fs::read(index).unwrap(), index_before);
    }
}
