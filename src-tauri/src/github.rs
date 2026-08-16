use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use crate::exec::{run_exec, ExecEnvironment, ProcOutput};
use crate::shell::ShellEnvironment;

const GH_TIMEOUT: Duration = Duration::from_secs(10);
const LIST_FIELDS: &str = "number,title,author,labels,updatedAt";
// The exact field set KödPR's PR view surface reads — status + identity, no more.
const PR_VIEW_FIELDS: &str = "number,title,author,state,url,statusCheckRollup";
static GH_BINARY: OnceLock<Result<std::path::PathBuf, String>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhOutput {
    pub stdout: String,
    pub stderr: String,
}

fn validate_args(args: &[String]) -> Result<(), String> {
    let Some((family, subcommand, rest)) = args.split_first().and_then(|(family, tail)| {
        tail.split_first()
            .map(|(subcommand, rest)| (family, subcommand, rest))
    }) else {
        return Err("gh command and subcommand are required".to_string());
    };

    match (family.as_str(), subcommand.as_str()) {
        ("auth", "status") => validate_flags(rest, &[]),
        ("repo", "view") => validate_flags(rest, &[("--json", "url")]),
        ("issue", "list") | ("pr", "list") => validate_flags(
            rest,
            &[
                ("--state", "open"),
                ("--limit", "50"),
                ("--json", LIST_FIELDS),
            ],
        ),
        // KödPR PR-review reads (M12). A numbered view reads an explicitly
        // selected PR; the no-number shape asks gh to resolve the current
        // checkout's PR for chat-target association. Both keep one exact JSON
        // field set and accept no arbitrary positionals or flags.
        ("pr", "view") => {
            if rest.first().is_some_and(|arg| arg == "--json") {
                validate_flags(rest, &[("--json", PR_VIEW_FIELDS)])
            } else {
                let (number, flags) = split_pr_number(rest)?;
                let _ = number;
                validate_flags(flags, &[("--json", PR_VIEW_FIELDS)])
            }
        }
        ("pr", "diff") | ("pr", "checks") => {
            let (number, flags) = split_pr_number(rest)?;
            let _ = number;
            if flags.is_empty() {
                Ok(())
            } else {
                Err("gh pr command takes only a PR number".to_string())
            }
        }
        _ => Err(format!("gh command is not allowed: {family} {subcommand}")),
    }
}

// A PR selector is a single leading positional made only of ASCII digits. It is
// never routed through a shell, but keeping it digits-only means it cannot be a
// flag (`-`), a path, or anything but the number gh expects.
fn split_pr_number(rest: &[String]) -> Result<(&str, &[String]), String> {
    let (number, flags) = rest
        .split_first()
        .ok_or_else(|| "gh pr command requires a PR number".to_string())?;
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("gh PR number must be digits only: {number}"));
    }
    Ok((number, flags))
}

// Every approved flag has one exact value, may appear once, and may be ordered
// however gh accepts it. Bare positionals and unapproved caller flags fail.
fn validate_flags(args: &[String], allowed: &[(&str, &str)]) -> Result<(), String> {
    if args.len() != allowed.len() * 2 {
        return Err("gh arguments do not match the approved command shape".to_string());
    }
    let mut seen = Vec::new();
    for pair in args.chunks_exact(2) {
        let flag = pair[0].as_str();
        let value = pair[1].as_str();
        let approved = allowed
            .iter()
            .any(|(allowed_flag, allowed_value)| flag == *allowed_flag && value == *allowed_value);
        if !approved || seen.contains(&flag) {
            return Err(format!("gh argument is not allowed: {flag}"));
        }
        seen.push(flag);
    }
    Ok(())
}

pub fn run_gh(
    shell: &ShellEnvironment,
    project_root: &Path,
    args: Vec<String>,
) -> Result<GhOutput, String> {
    validate_args(&args)?;
    let binary = GH_BINARY
        .get_or_init(|| {
            crate::detect::resolve_binary(shell, "gh")
                .ok_or_else(|| "gh is not installed".to_string())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    // The gh path was resolved once through the login-shell PATH and the argv
    // already crossed the allowlist above, so the shared runner execs it
    // directly with no shell in between.
    let out = run_exec(
        "gh",
        binary,
        project_root,
        &args,
        GH_TIMEOUT,
        ExecEnvironment::Gh,
    )?;
    Ok(to_output(out))
}

fn to_output(out: ProcOutput) -> GhOutput {
    GhOutput {
        stdout: out.stdout,
        stderr: out.stderr,
    }
}

#[cfg(test)]
mod tests {
    use super::validate_args;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    #[test]
    fn allows_only_the_exact_read_only_command_shapes() {
        for args in [
            vec!["auth", "status"],
            vec!["repo", "view", "--json", "url"],
            vec![
                "issue",
                "list",
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "number,title,author,labels,updatedAt",
            ],
            vec![
                "pr",
                "list",
                "--json",
                "number,title,author,labels,updatedAt",
                "--limit",
                "50",
                "--state",
                "open",
            ],
            // KödPR PR-review reads (M12): each takes one digits-only PR number.
            vec![
                "pr",
                "view",
                "42",
                "--json",
                "number,title,author,state,url,statusCheckRollup",
            ],
            vec![
                "pr",
                "view",
                "--json",
                "number,title,author,state,url,statusCheckRollup",
            ],
            vec!["pr", "diff", "42"],
            vec!["pr", "checks", "7"],
        ] {
            assert!(validate_args(&strings(&args)).is_ok(), "rejected {args:?}");
        }
        assert!(validate_args(&strings(&["api", "user"])).is_err());
        assert!(validate_args(&[]).is_err());
    }

    #[test]
    fn rejects_unapproved_subcommands_flags_and_leading_args() {
        for args in [
            vec!["auth", "token"],
            vec!["repo", "delete", "owner/repo", "--yes"],
            vec!["issue", "list", "--web"],
            vec!["--hostname", "github.com", "auth", "status"],
            vec!["repo", "view", "--repo", "owner/repo", "--json", "url"],
            vec!["pr", "list", "--json", "url"],
            // PR-review shapes reject anything but a bare digits-only number.
            vec!["pr", "view", "42", "--json", "url"],
            vec!["pr", "view", "42"],
            vec!["pr", "view", "-1", "--json", PR_VIEW_FIELDS_STR],
            vec!["pr", "diff", "--web", "42"],
            vec!["pr", "diff", "42", "--patch"],
            vec!["pr", "diff", "owner/repo"],
            vec!["pr", "checks", "7", "--watch"],
            vec!["pr", "merge", "7"],
        ] {
            assert!(validate_args(&strings(&args)).is_err(), "accepted {args:?}");
        }
    }

    // The exact PR view field set, kept in sync with PR_VIEW_FIELDS.
    const PR_VIEW_FIELDS_STR: &str = "number,title,author,state,url,statusCheckRollup";
}
