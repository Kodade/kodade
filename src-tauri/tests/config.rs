// Integration tests for the KödHarness config surface: the configguard
// allowlist and the config scanner, against real tempdir fixtures with an
// injected home + project root (the Tauri commands wire ShellEnvironment's home;
// the underlying functions take the roots so tests stay deterministic).

use kodade_lib::config::scan_dir;
use kodade_lib::configguard::{Access, ConfigGuard};
use kodade_lib::fs::{read_file, FileRead};

struct Fixture {
    base: std::path::PathBuf,
    home: std::path::PathBuf,
    project: std::path::PathBuf,
}

fn fixture(tag: &str) -> Fixture {
    let base = std::env::temp_dir().join(format!("kodade-config-it-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let home = base.join("home");
    let project = base.join("project");
    std::fs::create_dir_all(home.join(".claude").join("skills")).unwrap();
    std::fs::create_dir_all(project.join(".claude")).unwrap();
    // Canonicalize so comparisons match the guard's resolved form (/private/tmp).
    let home = std::fs::canonicalize(&home).unwrap();
    let project = std::fs::canonicalize(&project).unwrap();
    Fixture {
        base,
        home,
        project,
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

#[test]
fn scans_skills_with_manifests_disabled_and_orphans() {
    let fx = fixture("scan-skills");
    let skills = fx.home.join(".claude").join("skills");

    // A real skill dir with a SKILL.md manifest.
    let code_review = skills.join("code-review");
    std::fs::create_dir(&code_review).unwrap();
    std::fs::write(code_review.join("SKILL.md"), "# code review").unwrap();

    // A reversibly-disabled skill dir (the `.disabled` mechanic).
    std::fs::create_dir(skills.join("wip.disabled")).unwrap();

    let guard = ConfigGuard::new(&fx.home, &fx.project);
    let dir = guard
        .authorize(skills.to_str().unwrap(), Access::ScanDir)
        .expect("skills dir is inside an allowlisted root");
    let entries = scan_dir(&dir).expect("scan ok");

    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"code-review"), "got: {names:?}");
    assert!(names.contains(&"wip.disabled"), "got: {names:?}");

    let cr = entries.iter().find(|e| e.name == "code-review").unwrap();
    assert!(cr.is_dir);
    let manifest = cr
        .children
        .as_ref()
        .expect("code-review recurses one level")
        .iter()
        .find(|c| c.name == "SKILL.md");
    assert!(
        manifest.is_some(),
        "SKILL.md must be visible via the recurse"
    );
}

#[cfg(unix)]
#[test]
fn reports_symlinked_and_orphaned_skill_entries() {
    use std::os::unix::fs::symlink;
    let fx = fixture("scan-symlinks");
    let skills = fx.home.join(".claude").join("skills");

    // A dotfiles-style symlinked skill dir (target exists).
    let dotfiles = fx.base.join("dotfiles").join("skills").join("x-post");
    std::fs::create_dir_all(&dotfiles).unwrap();
    std::fs::write(dotfiles.join("SKILL.md"), "# x post").unwrap();
    let dotfiles = std::fs::canonicalize(&dotfiles).unwrap();
    symlink(&dotfiles, skills.join("x-post")).unwrap();

    // A broken symlink (target missing) → orphaned.
    symlink(fx.base.join("gone"), skills.join("stale")).unwrap();

    let guard = ConfigGuard::new(&fx.home, &fx.project);
    let dir = guard
        .authorize(skills.to_str().unwrap(), Access::ScanDir)
        .unwrap();
    let entries = scan_dir(&dir).unwrap();

    let linked = entries.iter().find(|e| e.name == "x-post").unwrap();
    assert!(linked.is_symlink);
    assert!(linked.is_dir, "a symlink to a dir resolves as a dir");
    assert!(!linked.orphaned);
    assert_eq!(linked.target.as_deref(), Some(dotfiles.to_str().unwrap()));

    let stale = entries.iter().find(|e| e.name == "stale").unwrap();
    assert!(stale.is_symlink);
    assert!(stale.orphaned, "a broken symlink must report orphaned");
    assert!(!stale.is_dir);
}

#[test]
fn reads_a_guarded_instruction_file() {
    let fx = fixture("read-file");
    let claude_md = fx.project.join("CLAUDE.md");
    std::fs::write(&claude_md, "# project rules\nline two\n").unwrap();

    let guard = ConfigGuard::new(&fx.home, &fx.project);
    let file = guard
        .authorize(claude_md.to_str().unwrap(), Access::ReadFile)
        .expect("a top-level CLAUDE.md is a known artifact in the project root");
    match read_file(&file.to_string_lossy()).expect("read ok") {
        FileRead::Text { content } => assert!(content.contains("project rules")),
        other => panic!("expected Text, got {other:?}"),
    }
}

#[test]
fn refuses_to_read_a_secret_beside_the_config_root() {
    // A file directly in home (not inside ~/.claude) must be refused even though
    // the guard knows home — only the config roots under it are allowlisted.
    let fx = fixture("refuse-secret");
    let secret = fx.home.join("id_rsa");
    std::fs::write(&secret, "PRIVATE KEY").unwrap();

    let guard = ConfigGuard::new(&fx.home, &fx.project);
    let err = guard
        .authorize(secret.to_str().unwrap(), Access::ReadFile)
        .expect_err("a home secret outside a config root must be rejected");
    assert!(
        err.contains("outside the allowed config roots"),
        "got: {err}"
    );
}
