// Config-root confinement for KödHarness. This is a DIFFERENT trust model from
// pathguard: pathguard confines mutations to one project root and rejects every
// symlink that escapes it; configguard authorizes reads across a STATIC
// ALLOWLIST of known CLI config roots (resolved from the login-shell home) plus
// the active project root passed per call. A path is allowed only if it
// canonicalizes INSIDE an allowlisted root AND matches a known artifact shape.
//
// The allowlist is deliberately smaller and static (fewer moving parts than
// dynamic confinement), and M10a wires only the READ side — no write command
// exists yet, but the guard and its escape tests land first so the mutation
// milestones (M10d/M10e) build on a proven surface.

use std::path::{Component, Path, PathBuf};

// Exact config filenames we recognize regardless of extension rules below.
const KNOWN_FILENAMES: &[&str] = &[
    "CLAUDE.md",
    "AGENTS.md",
    "AGENT.md",
    "GROK.md",
    ".mcp.json",
    "config.toml",
    "SKILL.md",
    "opencode.json",
];

// Extensions a harness artifact file may carry (instructions, skills, subagents
// are markdown; MCP configs are json/jsonc/toml). Broad but read-only and
// capped — the real confinement is the allowlist, this is a shape sanity check.
const KNOWN_EXTENSIONS: &[&str] = &["md", "markdown", "json", "jsonc", "toml"];

const DISABLED_SUFFIX: &str = ".disabled";

// Infix marking a timestamped backup sibling written before a mutating write
// (e.g. `CLAUDE.md.kodade-bak-2026-07-14T12-30-00-000Z`). Backups are readable
// and restorable through the guard but never authorized as artifacts, and the
// TS scan (scan.ts) skips them so they never surface as harness rows.
pub const BACKUP_INFIX: &str = ".kodade-bak-";

// The two directories whose entries the reversible `.disabled` rename mechanic
// may toggle: a `skills` dir (skill dirs / single-file skills) and an `agents`
// dir (subagent files). A rename target MUST sit directly inside one of these,
// so config_rename can never rename an instruction file or an MCP config.
const TOGGLE_CONTAINERS: &[&str] = &["skills", "agents"];

// The kind of access a caller wants.
//
// Read side (M10a): ScanDir enumerates a config directory; ReadFile reads one
// config file's bytes. Write side (M10d): WriteFile authorizes an atomic write
// to a known artifact file (following an existing symlink to a contained
// referent); RenameEntry authorizes the reversible `.disabled` rename of a
// skill/subagent entry, operating on the LINK itself (never following the final
// symlink into a dotfiles target); ReadBackup authorizes reading a `.kodade-bak`
// sibling for the restore flow. Every mode requires allowlist containment; each
// adds its own shape/type discipline below.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    ScanDir,
    ReadFile,
    ReadOptionalFile,
    WriteFile,
    RenameEntry,
    ReadBackup,
    SkillsContainer,
    SkillDir,
    SkillBackupDir,
}

pub struct ConfigGuard {
    // Canonicalized, existing allowlisted roots. Missing roots (e.g. a user with
    // no ~/.codex) are simply absent — nothing under them will ever match, and a
    // missing config dir is a normal "nothing to scan" state, not an error.
    roots: Vec<PathBuf>,
    // Claude's user-scope MCP config is one documented file directly under
    // home. Keep it exact instead of widening the root allowlist to all of home.
    files: Vec<PathBuf>,
    // Literal catalog-owned skills containers under existing Claude/Codex roots.
    // This is narrower than general root containment: an arbitrary project
    // subdirectory named `skills` is never a KödSkills mutation target.
    skill_containers: Vec<PathBuf>,
}

impl ConfigGuard {
    // Build the per-call allowlist from the login-shell home and the active
    // project root. The known CLI config dirs plus the project's own config dirs
    // and the project root itself (for top-level CLAUDE.md/AGENTS.md/.mcp.json).
    pub fn new(home: &Path, project_root: &Path) -> Self {
        let candidates = [
            home.join(".claude"),
            home.join(".codex"),
            home.join(".agents"),
            home.join(".grok"),
            home.join(".config").join("opencode"),
            project_root.join(".claude"),
            project_root.join(".codex"),
            project_root.join(".agents"),
            project_root.join(".grok"),
            project_root.join(".opencode"),
            project_root.to_path_buf(),
        ];
        let roots = candidates
            .iter()
            .filter_map(|candidate| std::fs::canonicalize(candidate).ok())
            .collect();
        let home_anchor = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
        let project_anchor =
            std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
        let skill_containers = [
            home_anchor.join(".claude").join("skills"),
            home_anchor.join(".codex").join("skills"),
            home_anchor.join(".agents").join("skills"),
            project_anchor.join(".claude").join("skills"),
            project_anchor.join(".codex").join("skills"),
            project_anchor.join(".agents").join("skills"),
        ]
        .into_iter()
        .collect();
        let files = vec![home_anchor.join(".claude.json")];
        Self {
            roots,
            files,
            skill_containers,
        }
    }

    fn contained(&self, canonical: &Path) -> bool {
        self.roots.iter().any(|root| canonical.starts_with(root))
            || self.files.iter().any(|file| canonical == file)
    }

    // True when `canonical` is exactly one of the allowlisted roots (not merely
    // contained by one). Used to keep the rename primitive scoped to skills/agents
    // SUBdirectories and off a root's own top-level artifacts.
    fn is_root(&self, canonical: &Path) -> bool {
        self.roots.iter().any(|root| canonical == root)
    }

    // Full canonicalization (follows every symlink) plus containment. Used by the
    // read modes and by WriteFile for an already-existing file: an escaping link
    // (e.g. ~/.claude/evil.md -> /etc/passwd) lands outside every root and is
    // rejected here.
    fn canonicalize_contained(&self, raw: &Path, path: &str) -> Result<PathBuf, String> {
        let canonical = std::fs::canonicalize(raw)
            .map_err(|e| format!("config path is unavailable: {path}: {e}"))?;
        if !self.contained(&canonical) {
            return Err(format!("path is outside the allowed config roots: {path}"));
        }
        Ok(canonical)
    }

    // Canonicalize the PARENT and re-attach the LITERAL final component (pathguard's
    // confine_mutation discipline). This never follows a final symlink, so a
    // rename of a dotfiles-symlinked skill renames THE LINK, never its target; and
    // a not-yet-existing write/rename destination still resolves (its parent
    // exists). Containment is then checked on the reconstructed path.
    fn parent_canonical_join(&self, raw: &Path, path: &str) -> Result<PathBuf, String> {
        let file_name = raw
            .file_name()
            .ok_or_else(|| format!("path has no final component: {path}"))?;
        let parent = raw
            .parent()
            .ok_or_else(|| format!("path has no parent directory: {path}"))?;
        let parent_canon = std::fs::canonicalize(parent)
            .map_err(|e| format!("parent directory is unavailable: {path}: {e}"))?;
        Ok(parent_canon.join(file_name))
    }

    // Authorize `path` for `access`, returning the path to operate on. Every
    // rejection is a clear, caller-surfaceable error string; nothing here panics.
    //
    // Trust posture (same as pathguard): `project_root` and every path arrive from
    // the frontend and are treated as untrusted. Containment is decided against the
    // static, home-derived allowlist plus the one project root, and the confused-
    // deputy class (a caller pointing us at ~/.ssh via a crafted path or symlink)
    // is blocked by canonicalization landing outside every allowlisted root.
    pub fn authorize(&self, path: &str, access: Access) -> Result<PathBuf, String> {
        let raw = Path::new(path);
        if !raw.is_absolute() {
            return Err(format!("config path must be absolute: {path}"));
        }
        // Reject any literal `..` up front. canonicalize would resolve it, but a
        // defensive lexical check documents intent and blocks obvious escapes
        // before we ever touch the filesystem.
        if raw.components().any(|c| c == Component::ParentDir) {
            return Err(format!("config path must not contain '..': {path}"));
        }

        match access {
            Access::ScanDir => {
                let canonical = self.canonicalize_contained(raw, path)?;
                if !canonical.is_dir() {
                    return Err(format!("config scan target is not a directory: {path}"));
                }
                Ok(canonical)
            }
            Access::ReadFile => {
                let canonical = self.canonicalize_contained(raw, path)?;
                if !is_known_artifact_file(&canonical) {
                    return Err(format!("not a known config artifact: {path}"));
                }
                Ok(canonical)
            }
            Access::ReadOptionalFile => {
                let candidate = match std::fs::canonicalize(raw) {
                    Ok(canonical) => canonical,
                    Err(_) => self.parent_canonical_join(raw, path)?,
                };
                if !self.contained(&candidate) {
                    return Err(format!("path is outside the allowed config roots: {path}"));
                }
                if !is_known_artifact_file(&candidate) {
                    return Err(format!("not a known config artifact: {path}"));
                }
                Ok(candidate)
            }
            Access::ReadBackup => {
                // A `.kodade-bak` sibling, for the restore flow. Restorable but
                // never an artifact — the shape check is the backup infix, not a
                // known artifact name/extension.
                let canonical = self.canonicalize_contained(raw, path)?;
                let name = canonical.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !is_backup_name(name) {
                    return Err(format!("not a kodade backup file: {path}"));
                }
                Ok(canonical)
            }
            Access::WriteFile => {
                // Follow an existing file's symlink to its referent (which MUST be
                // contained — an escaping link is rejected); a brand-new file
                // (M10e first save) resolves through its parent instead.
                let candidate = match std::fs::canonicalize(raw) {
                    Ok(canonical) => canonical,
                    Err(_) => self.parent_canonical_join(raw, path)?,
                };
                if !self.contained(&candidate) {
                    return Err(format!("path is outside the allowed config roots: {path}"));
                }
                if !is_known_artifact_file(&candidate) {
                    return Err(format!("not a known config artifact: {path}"));
                }
                Ok(candidate)
            }
            Access::RenameEntry => {
                // Operate on the link entry itself — parent-canonicalize, keep the
                // literal final component. Never follows the final symlink.
                let candidate = self.parent_canonical_join(raw, path)?;
                if !self.contained(&candidate) {
                    return Err(format!("path is outside the allowed config roots: {path}"));
                }
                // Check container membership on the RAW (pre-resolution) parent
                // name, not the canonicalized one: a `skills`/`agents` dir that is
                // ITSELF a symlink (a whole-directory dotfiles/stow layout, e.g.
                // `.claude/skills -> ~/dotfiles/kodade-skills`) resolves to a
                // differently-named real directory, which would otherwise fail
                // this check even though the entry is legitimately reached via a
                // literal `skills`/`agents` path. Containment (just above) already
                // enforces the actual security boundary — this check only scopes
                // WHICH directories the rename primitive may target, and that
                // scoping is a property of the path the caller used, not of
                // whatever a symlink happens to resolve to.
                if !parent_is_toggle_container(raw) {
                    return Err(format!(
                        "rename target is not inside a skills/agents dir: {path}"
                    ));
                }
                // The literal-name check above is spoofable: a `skills`/`agents`
                // symlink can point its whole directory at anything. Containment
                // keeps that inside the allowlist, but a symlink aimed at a config
                // ROOT itself (e.g. a malicious project's `.claude/skills -> ~/.claude`
                // or `-> <project>`) would otherwise expose that root's OWN
                // top-level artifacts (CLAUDE.md, .mcp.json, ...) to the rename
                // primitive. A real skills/agents container is always a
                // subdirectory of a root, never the root; so reject when the
                // resolved container IS an allowlisted root. This preserves the
                // stow layout (container resolves to a differently-named subdir)
                // while closing the spoof.
                if candidate.parent().is_some_and(|c| self.is_root(c)) {
                    return Err(format!(
                        "rename container resolves to a config root, not a skills/agents dir: {path}"
                    ));
                }
                // If the entry EXISTS as a plain file (not a dir, not a link to a
                // dir), require a known artifact shape so a stray non-skill file in
                // the dir can't be renamed. A skill DIR (or a symlink to one) needs
                // only container membership; a not-yet-existing destination (the
                // enable/disable target) is gated by container membership plus the
                // command's suffix-equality check.
                if std::fs::symlink_metadata(&candidate).is_ok() {
                    let is_dir = std::fs::metadata(&candidate)
                        .map(|m| m.is_dir())
                        .unwrap_or(false);
                    if !is_dir && !is_known_artifact_file(&candidate) {
                        return Err(format!(
                            "rename target is not a known skill/subagent artifact: {path}"
                        ));
                    }
                }
                Ok(candidate)
            }
            Access::SkillsContainer => {
                if raw.file_name().and_then(|name| name.to_str()) != Some("skills") {
                    return Err(format!("not a skills container: {path}"));
                }
                let config_root = raw
                    .parent()
                    .ok_or_else(|| format!("skills container has no parent: {path}"))?;
                if std::fs::symlink_metadata(config_root)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(format!("not an allowed skills container: {path}"));
                }
                let config_name = config_root
                    .file_name()
                    .ok_or_else(|| format!("skills config root has no name: {path}"))?;
                let owner = config_root
                    .parent()
                    .ok_or_else(|| format!("skills config root has no parent: {path}"))?;
                let owner_canon = std::fs::canonicalize(owner)
                    .map_err(|error| format!("skills owner is unavailable: {path}: {error}"))?;
                let candidate = owner_canon.join(config_name).join("skills");
                if !self
                    .skill_containers
                    .iter()
                    .any(|allowed| allowed == &candidate)
                {
                    return Err(format!("not an allowed skills container: {path}"));
                }
                if std::fs::symlink_metadata(raw)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(format!(
                        "skills dir is symlinked — managed externally: {path}"
                    ));
                }
                if raw.exists() && !raw.is_dir() {
                    return Err(format!("skills container is not a directory: {path}"));
                }
                Ok(candidate)
            }
            Access::SkillDir | Access::SkillBackupDir => {
                let parent = raw
                    .parent()
                    .ok_or_else(|| format!("skill directory has no parent: {path}"))?;
                if parent.file_name().and_then(|name| name.to_str()) != Some("skills") {
                    return Err(format!(
                        "skill directory is not directly inside skills: {path}"
                    ));
                }
                if std::fs::symlink_metadata(parent)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(format!(
                        "skills dir is symlinked — managed externally: {}",
                        parent.display()
                    ));
                }
                let parent_canon = std::fs::canonicalize(parent)
                    .map_err(|error| format!("skills directory is unavailable: {path}: {error}"))?;
                if !self
                    .skill_containers
                    .iter()
                    .any(|allowed| allowed == &parent_canon)
                {
                    return Err(format!(
                        "path is outside a managed skills container: {path}"
                    ));
                }
                let name = raw
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| format!("skill directory name is not UTF-8: {path}"))?;
                let valid_name = match access {
                    Access::SkillDir => is_skill_dir_name(name),
                    Access::SkillBackupDir => is_skill_backup_dir_name(name),
                    _ => unreachable!(),
                };
                if !valid_name {
                    return Err(format!("invalid skill directory name: {path}"));
                }
                if std::fs::symlink_metadata(raw)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(format!("skill directory must not be a symlink: {path}"));
                }
                Ok(parent_canon.join(name))
            }
        }
    }
}

fn is_skill_dir_name(name: &str) -> bool {
    let base = name.strip_suffix(DISABLED_SUFFIX).unwrap_or(name);
    !base.is_empty()
        && base.chars().enumerate().all(|(index, ch)| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || (index > 0 && ch == '-')
        })
}

fn is_skill_backup_dir_name(name: &str) -> bool {
    let Some((base, stamp)) = name.split_once(BACKUP_INFIX) else {
        return false;
    };
    !stamp.is_empty() && is_skill_dir_name(base)
}

// True when `candidate`'s immediate parent is one of the toggle containers
// (a `skills` or `agents` directory). candidate is `parent_canon.join(final)`,
// so its parent is the canonicalized container dir.
fn parent_is_toggle_container(candidate: &Path) -> bool {
    candidate
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|n| TOGGLE_CONTAINERS.contains(&n))
        .unwrap_or(false)
}

// A backup sibling carries the `.kodade-bak-` infix followed by a timestamp.
// Require a non-empty tail so a file literally named `x.kodade-bak-` is not
// mistaken for a real (restorable) backup.
pub fn is_backup_name(name: &str) -> bool {
    match name.find(BACKUP_INFIX) {
        Some(at) => !name[at + BACKUP_INFIX.len()..].is_empty(),
        None => false,
    }
}

// A path matches a known artifact shape if its filename is a known config name,
// or its extension is a known artifact extension. The reversible `.disabled`
// suffix is stripped first so a disabled artifact keeps matching.
fn is_known_artifact_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let name = name.strip_suffix(DISABLED_SUFFIX).unwrap_or(name);
    if KNOWN_FILENAMES.contains(&name) {
        return true;
    }
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| KNOWN_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A unique home+project fixture per test so parallel tests never collide.
    // Both are canonicalized so expectations compare against the same real
    // location the guard resolves to (/tmp vs /private/tmp on macOS).
    struct Fixture {
        base: PathBuf,
        home: PathBuf,
        project: PathBuf,
    }

    fn fixture(tag: &str) -> Fixture {
        let base =
            std::env::temp_dir().join(format!("kodade-configguard-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let project = base.join("project");
        std::fs::create_dir_all(home.join(".claude").join("skills")).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(home.join(".grok")).unwrap();
        std::fs::create_dir_all(home.join(".config").join("opencode")).unwrap();
        std::fs::create_dir_all(project.join(".claude").join("skills")).unwrap();
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

    fn guard(fx: &Fixture) -> ConfigGuard {
        ConfigGuard::new(&fx.home, &fx.project)
    }

    #[test]
    fn allows_a_known_file_inside_a_config_root() {
        let fx = fixture("allow-file");
        let claude_md = fx.home.join(".claude").join("CLAUDE.md");
        std::fs::write(&claude_md, "hi").unwrap();
        let ok = guard(&fx)
            .authorize(claude_md.to_str().unwrap(), Access::ReadFile)
            .expect("a known artifact inside a root must be allowed");
        assert_eq!(ok, std::fs::canonicalize(&claude_md).unwrap());
    }

    #[test]
    fn allows_only_claudes_exact_home_level_mcp_file() {
        let fx = fixture("allow-claude-user-mcp");
        let claude_json = fx.home.join(".claude.json");
        guard(&fx)
            .authorize(claude_json.to_str().unwrap(), Access::WriteFile)
            .expect("the documented Claude user MCP file must be writable");

        let sibling = fx.home.join(".claude-other.json");
        let error = guard(&fx)
            .authorize(sibling.to_str().unwrap(), Access::WriteFile)
            .expect_err("another home-level JSON file must remain outside the allowlist");
        assert!(error.contains("outside the allowed config roots"));
    }

    #[test]
    fn allows_a_project_root_instruction_file() {
        let fx = fixture("allow-project-instruction");
        let agents = fx.project.join("AGENTS.md");
        std::fs::write(&agents, "codex").unwrap();
        guard(&fx)
            .authorize(agents.to_str().unwrap(), Access::ReadFile)
            .expect("a top-level project instruction file must be allowed");
    }

    #[test]
    fn allows_scanning_a_skills_dir() {
        let fx = fixture("allow-scan");
        let skills = fx.home.join(".claude").join("skills");
        guard(&fx)
            .authorize(skills.to_str().unwrap(), Access::ScanDir)
            .expect("a skills dir inside a root must be scannable");
    }

    #[test]
    fn allows_grok_and_opencode_global_roots() {
        let fx = fixture("allow-grok-opencode");
        let grok_md = fx.home.join(".grok").join("GROK.md");
        std::fs::write(&grok_md, "grok").unwrap();
        guard(&fx)
            .authorize(grok_md.to_str().unwrap(), Access::ReadFile)
            .expect("~/.grok/GROK.md must be allowed");

        let opencode_json = fx
            .home
            .join(".config")
            .join("opencode")
            .join("opencode.json");
        std::fs::write(&opencode_json, "{}").unwrap();
        guard(&fx)
            .authorize(opencode_json.to_str().unwrap(), Access::ReadFile)
            .expect("~/.config/opencode/opencode.json must be allowed");
    }

    #[test]
    fn allows_grok_and_opencode_project_roots() {
        let fx = fixture("allow-grok-opencode-project");
        std::fs::create_dir_all(fx.project.join(".grok")).unwrap();
        std::fs::create_dir_all(fx.project.join(".opencode")).unwrap();
        let grok_md = fx.project.join(".grok").join("GROK.md");
        std::fs::write(&grok_md, "grok").unwrap();
        guard(&fx)
            .authorize(grok_md.to_str().unwrap(), Access::ReadFile)
            .expect("project .grok/GROK.md must be allowed");

        let opencode_json = fx.project.join(".opencode").join("opencode.json");
        std::fs::write(&opencode_json, "{}").unwrap();
        guard(&fx)
            .authorize(opencode_json.to_str().unwrap(), Access::ReadFile)
            .expect("project .opencode/opencode.json must be allowed");
    }

    #[test]
    fn rejects_a_grok_sibling_root_escape() {
        // A sibling dir sharing the `.grok` prefix (`.grok-evil`) must not be
        // treated as inside the `.grok` root — same prefix-escape class as
        // the existing `.claude-evil` test.
        let fx = fixture("grok-prefix-sibling");
        let evil = fx.home.join(".grok-evil");
        std::fs::create_dir_all(&evil).unwrap();
        let file = evil.join("GROK.md");
        std::fs::write(&file, "gotcha").unwrap();
        let err = guard(&fx)
            .authorize(file.to_str().unwrap(), Access::ReadFile)
            .expect_err("a prefix-sibling .grok root must not be treated as inside .grok");
        assert!(
            err.contains("outside the allowed config roots"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_a_dotdot_escape() {
        let fx = fixture("dotdot");
        // Build the untrusted text directly. Pushing onto a Windows verbatim
        // (`\\?\`) PathBuf normalizes `..` before authorize can inspect it,
        // which turns this lexical-guard test into a containment-guard test.
        let escape = format!(
            "{}{}..{}secret.md",
            fx.home.join(".claude").display(),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR,
        );
        std::fs::write(fx.home.join("secret.md"), "nope").unwrap();
        let err = guard(&fx)
            .authorize(&escape, Access::ReadFile)
            .expect_err("a ../ escape must be rejected");
        assert!(err.contains("must not contain '..'"), "got: {err}");
    }

    #[test]
    fn rejects_a_file_directly_in_home_outside_a_config_root() {
        // ~/.zshrc sits in home but NOT inside any allowlisted config root.
        let fx = fixture("home-file");
        let rc = fx.home.join(".zshrc");
        std::fs::write(&rc, "export X=1").unwrap();
        let err = guard(&fx)
            .authorize(rc.to_str().unwrap(), Access::ReadFile)
            .expect_err("an arbitrary home file must be rejected");
        assert!(
            err.contains("outside the allowed config roots"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_an_unknown_filename_inside_a_root() {
        let fx = fixture("unknown-name");
        let secret = fx.home.join(".claude").join("id_rsa");
        std::fs::write(&secret, "KEY").unwrap();
        let err = guard(&fx)
            .authorize(secret.to_str().unwrap(), Access::ReadFile)
            .expect_err("an unknown filename must be rejected even inside a root");
        assert!(err.contains("not a known config artifact"), "got: {err}");
    }

    #[test]
    fn rejects_a_prefix_sibling_root() {
        // A sibling dir whose name merely shares the `.claude` prefix
        // (`.claude-evil`) is NOT inside the `.claude` root.
        let fx = fixture("prefix-sibling");
        let evil = fx.home.join(".claude-evil");
        std::fs::create_dir_all(&evil).unwrap();
        let file = evil.join("CLAUDE.md");
        std::fs::write(&file, "gotcha").unwrap();
        let err = guard(&fx)
            .authorize(file.to_str().unwrap(), Access::ReadFile)
            .expect_err("a prefix-sibling root must not be treated as inside .claude");
        assert!(
            err.contains("outside the allowed config roots"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_escaping_a_config_root() {
        use std::os::unix::fs::symlink;
        // A markdown-named symlink inside ~/.claude pointing OUT to a secret. The
        // shape check would pass, but full canonicalization lands outside every
        // root, so the read is refused.
        let fx = fixture("symlink-escape");
        let secret = fx.base.join("secret.txt");
        std::fs::write(&secret, "TOP SECRET").unwrap();
        let link = fx.home.join(".claude").join("leak.md");
        symlink(&secret, &link).unwrap();
        let err = guard(&fx)
            .authorize(link.to_str().unwrap(), Access::ReadFile)
            .expect_err("a symlink escaping the config root must be rejected");
        assert!(
            err.contains("outside the allowed config roots"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_a_relative_path() {
        let fx = fixture("relative");
        let err = guard(&fx)
            .authorize("not/absolute.md", Access::ReadFile)
            .expect_err("a relative path must be rejected");
        assert!(err.contains("must be absolute"), "got: {err}");
    }

    #[test]
    fn rejects_a_missing_path() {
        let fx = fixture("missing");
        let ghost = fx.home.join(".claude").join("ghost.md");
        let err = guard(&fx)
            .authorize(ghost.to_str().unwrap(), Access::ReadFile)
            .expect_err("a non-existent path cannot be canonicalized/authorized");
        assert!(err.contains("unavailable"), "got: {err}");
    }

    // --- Write-side access modes (M10d) ---

    #[test]
    fn allows_writing_a_known_artifact_file() {
        let fx = fixture("write-known");
        let claude_md = fx.home.join(".claude").join("CLAUDE.md");
        std::fs::write(&claude_md, "hi").unwrap();
        guard(&fx)
            .authorize(claude_md.to_str().unwrap(), Access::WriteFile)
            .expect("a known artifact inside a root must be writable");
    }

    #[test]
    fn allows_writing_a_new_file_that_does_not_exist_yet() {
        // First-save case (M10e): the file doesn't exist, but its parent does and
        // is inside a root, and the name is a known artifact.
        let fx = fixture("write-new");
        let fresh = fx.project.join("CLAUDE.md");
        guard(&fx)
            .authorize(fresh.to_str().unwrap(), Access::WriteFile)
            .expect("a new known-artifact file inside a root must be writable");
    }

    #[test]
    fn rejects_writing_an_unknown_filename() {
        let fx = fixture("write-unknown");
        let secret = fx.home.join(".claude").join("id_rsa");
        std::fs::write(&secret, "KEY").unwrap();
        let err = guard(&fx)
            .authorize(secret.to_str().unwrap(), Access::WriteFile)
            .expect_err("an unknown filename must not be writable");
        assert!(err.contains("not a known config artifact"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_writing_through_a_symlink_escaping_a_root() {
        use std::os::unix::fs::symlink;
        // CLAUDE.md in the project is a symlink to a file OUTSIDE every root.
        let fx = fixture("write-symlink-escape");
        let outside = fx.base.join("outside.md");
        std::fs::write(&outside, "not ours").unwrap();
        let link = fx.project.join("CLAUDE.md");
        symlink(&outside, &link).unwrap();
        let err = guard(&fx)
            .authorize(link.to_str().unwrap(), Access::WriteFile)
            .expect_err("writing through an escaping symlink must be rejected");
        assert!(
            err.contains("outside the allowed config roots"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn allows_writing_through_a_symlink_to_a_contained_target_without_clobbering_the_link() {
        use std::os::unix::fs::symlink;
        // A project CLAUDE.md that is a symlink to a REAL file inside another
        // allowlisted root (e.g. a user who symlinks their project instructions
        // to a shared global file). WriteFile intentionally follows a
        // non-escaping symlink to its referent — authorize() must return the
        // REAL target, never the link path, so the caller's atomic write lands
        // on the target's content and the link entry itself is left alone (a
        // separate concern from RenameEntry, which never follows the final
        // symlink at all).
        let fx = fixture("write-symlink-contained");
        let shared = fx.home.join(".claude").join("CLAUDE.md");
        std::fs::write(&shared, "shared bytes").unwrap();
        let link = fx.project.join("CLAUDE.md");
        symlink(&shared, &link).unwrap();

        let authorized = guard(&fx)
            .authorize(link.to_str().unwrap(), Access::WriteFile)
            .expect("writing through a contained (non-escaping) symlink must be allowed");
        assert_eq!(authorized, std::fs::canonicalize(&shared).unwrap());

        // The link itself is untouched by authorization alone — still a
        // symlink, still pointing at the same real file.
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(meta.file_type().is_symlink(), "the link entry must survive");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_writing_a_new_file_whose_parent_dir_symlink_escapes_the_allowlist() {
        use std::os::unix::fs::symlink;
        // The first-save (not-yet-existing file) path resolves through the
        // PARENT directory instead of the file itself. If that parent is a
        // symlink escaping the allowlist, the escape must still be caught —
        // exercising `parent_canonical_join`'s containment check specifically,
        // as opposed to the final-component escape covered above.
        let fx = fixture("write-new-file-parent-symlink-escape");
        let outside = fx.base.join("outside-dir");
        std::fs::create_dir_all(&outside).unwrap();
        let claude_link = fx.project.join(".claude-linked");
        symlink(&outside, &claude_link).unwrap();
        let fresh = claude_link.join("CLAUDE.md"); // does not exist yet

        let err = guard(&fx)
            .authorize(fresh.to_str().unwrap(), Access::WriteFile)
            .expect_err(
                "a new file under a parent-dir symlink escaping the allowlist must be rejected",
            );
        assert!(
            err.contains("outside the allowed config roots"),
            "got: {err}"
        );
    }

    #[test]
    fn allows_renaming_a_skill_dir_entry() {
        let fx = fixture("rename-skill-dir");
        let skill = fx
            .project
            .join(".claude")
            .join("skills")
            .join("code-review");
        std::fs::create_dir_all(&skill).unwrap();
        guard(&fx)
            .authorize(skill.to_str().unwrap(), Access::RenameEntry)
            .expect("a skill dir inside a skills dir must be renamable");
    }

    #[test]
    fn allows_renaming_to_a_disabled_target_that_does_not_exist_yet() {
        // The disable destination (foo.disabled) does not exist; container
        // membership plus the command's suffix check gate it.
        let fx = fixture("rename-target-absent");
        std::fs::create_dir_all(fx.project.join(".claude").join("skills")).unwrap();
        let target = fx
            .project
            .join(".claude")
            .join("skills")
            .join("code-review.disabled");
        guard(&fx)
            .authorize(target.to_str().unwrap(), Access::RenameEntry)
            .expect("a not-yet-existing disable target inside a skills dir must authorize");
    }

    #[test]
    fn rejects_renaming_a_file_outside_a_toggle_container() {
        // A top-level project CLAUDE.md is a known artifact, but it is NOT inside a
        // skills/agents dir, so the rename primitive must refuse it.
        let fx = fixture("rename-not-container");
        let claude_md = fx.project.join("CLAUDE.md");
        std::fs::write(&claude_md, "hi").unwrap();
        let err = guard(&fx)
            .authorize(claude_md.to_str().unwrap(), Access::RenameEntry)
            .expect_err("an instruction file is not a rename target");
        assert!(err.contains("not inside a skills/agents dir"), "got: {err}");
    }

    #[test]
    fn rejects_renaming_a_non_artifact_file_inside_skills() {
        let fx = fixture("rename-stray-file");
        let skills = fx.project.join(".claude").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        let stray = skills.join("notes.txt");
        std::fs::write(&stray, "not a skill").unwrap();
        let err = guard(&fx)
            .authorize(stray.to_str().unwrap(), Access::RenameEntry)
            .expect_err("a stray non-skill file must not be renamable");
        assert!(
            err.contains("not a known skill/subagent artifact"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rename_authorizes_the_link_path_not_the_symlink_target() {
        use std::os::unix::fs::symlink;
        // A dotfiles-symlinked skill dir: the rename must resolve to the LINK
        // location inside the project skills dir, never the dotfiles target.
        let fx = fixture("rename-symlinked-skill");
        let dotfiles = fx.base.join("dotfiles").join("x-post");
        std::fs::create_dir_all(&dotfiles).unwrap();
        let skills = fx.project.join(".claude").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        let link = skills.join("x-post");
        symlink(&dotfiles, &link).unwrap();

        let authorized = guard(&fx)
            .authorize(link.to_str().unwrap(), Access::RenameEntry)
            .expect("a symlinked skill dir must be renamable via its link path");

        let expected = std::fs::canonicalize(&skills).unwrap().join("x-post");
        assert_eq!(
            authorized, expected,
            "must be the link path, not the target"
        );
        assert!(
            !authorized.starts_with(std::fs::canonicalize(fx.base.join("dotfiles")).unwrap()),
            "must never resolve into the dotfiles target"
        );
    }

    // --- M10g: whole-directory symlinked containers (stow/dotfiles layouts) ---

    #[cfg(unix)]
    #[test]
    fn allows_renaming_inside_a_skills_dir_that_is_itself_a_symlink_to_a_contained_target() {
        use std::os::unix::fs::symlink;
        // A GNU-stow-style layout: `.claude/skills` is ENTIRELY a symlink to a
        // differently-named real directory that is nonetheless inside another
        // allowlisted root (here, the home `.claude/skills`). The rename must be
        // authorized via the literal `.claude/skills/<entry>` path the caller
        // used, even though the container's canonicalized name isn't "skills".
        let fx = fixture("rename-symlinked-container-contained");
        let real_target = fx.home.join(".claude").join("skills");
        // fixture() already creates home/.claude/skills; rename it to a
        // differently-named sibling so the resolved name really doesn't match
        // the toggle-container name, then symlink `skills` back to it.
        let renamed_target = fx.home.join(".claude").join("kodade-skills");
        std::fs::rename(&real_target, &renamed_target).unwrap();
        symlink(&renamed_target, &real_target).unwrap();
        std::fs::create_dir_all(renamed_target.join("code-review")).unwrap();

        let entry = real_target.join("code-review");
        let authorized = guard(&fx)
            .authorize(entry.to_str().unwrap(), Access::RenameEntry)
            .expect(
                "a skill inside a whole-dir-symlinked (but contained) skills dir must authorize",
            );
        assert_eq!(
            authorized,
            std::fs::canonicalize(&renamed_target)
                .unwrap()
                .join("code-review"),
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_renaming_inside_a_skills_dir_that_is_a_symlink_escaping_the_allowlist() {
        use std::os::unix::fs::symlink;
        // Same whole-directory-symlink shape as above, but the target is
        // OUTSIDE every allowlisted root. Containment must still reject it —
        // the RenameEntry container-name relaxation must never widen what's
        // authorized, only which literal paths can reach an authorized target.
        let fx = fixture("rename-symlinked-container-escape");
        let outside = fx.base.join("outside-skills");
        std::fs::create_dir_all(outside.join("code-review")).unwrap();
        let skills = fx.project.join(".claude").join("skills");
        std::fs::remove_dir_all(&skills).ok();
        symlink(&outside, &skills).unwrap();

        let entry = skills.join("code-review");
        let err = guard(&fx)
            .authorize(entry.to_str().unwrap(), Access::RenameEntry)
            .expect_err("a whole-dir symlink escaping the allowlist must still be rejected");
        assert!(
            err.contains("outside the allowed config roots"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_renaming_a_root_top_level_artifact_via_a_spoofed_skills_symlink() {
        use std::os::unix::fs::symlink;
        // ADVERSARIAL (M10g review): the literal-name container relaxation must
        // not let a caller spoof the `skills` name to reach a config ROOT's own
        // top-level artifacts. A malicious project ships `.claude/skills` as a
        // symlink to the user's GLOBAL `~/.claude` (an allowlisted root). The
        // symlink target is contained, so the containment check passes; the raw
        // literal parent is "skills", so the old relaxation passed too — which
        // would authorize renaming/disabling the user's global CLAUDE.md,
        // violating the module guarantee that config_rename can never rename an
        // instruction file. Must be rejected: the resolved container is a root,
        // not a skills/agents dir.
        let fx = fixture("rename-spoofed-skills-to-root");
        let global_claude = fx.home.join(".claude").join("CLAUDE.md");
        std::fs::write(&global_claude, "global guardrails").unwrap();
        let proj_skills = fx.project.join(".claude").join("skills");
        std::fs::remove_dir_all(&proj_skills).ok();
        symlink(fx.home.join(".claude"), &proj_skills).unwrap();

        let entry = proj_skills.join("CLAUDE.md");
        let err = guard(&fx)
            .authorize(entry.to_str().unwrap(), Access::RenameEntry)
            .expect_err(
                "renaming a config root's top-level artifact via a spoofed skills symlink must be rejected",
            );
        assert!(
            err.contains("skills/agents"),
            "expected a skills/agents scoping rejection, got: {err}"
        );
        // The global instruction file must be untouched by the failed authorize.
        assert!(global_claude.exists(), "global CLAUDE.md must survive");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_renaming_a_project_root_instruction_via_a_spoofed_skills_symlink() {
        use std::os::unix::fs::symlink;
        // Same spoof, pointed at the project ROOT itself: a repo whose
        // `.claude/skills` symlinks to `.` would otherwise expose the project's
        // own top-level CLAUDE.md / AGENTS.md / .mcp.json to the rename primitive.
        let fx = fixture("rename-spoofed-skills-to-project-root");
        let proj_mcp = fx.project.join(".mcp.json");
        std::fs::write(&proj_mcp, "{}").unwrap();
        let proj_skills = fx.project.join(".claude").join("skills");
        std::fs::remove_dir_all(&proj_skills).ok();
        symlink(&fx.project, &proj_skills).unwrap();

        let entry = proj_skills.join(".mcp.json");
        let err = guard(&fx)
            .authorize(entry.to_str().unwrap(), Access::RenameEntry)
            .expect_err(
                "renaming a project-root artifact via a spoofed skills symlink must be rejected",
            );
        assert!(
            err.contains("skills/agents"),
            "expected a skills/agents scoping rejection, got: {err}"
        );
    }

    #[test]
    fn allows_reading_a_backup_file_but_not_as_an_artifact() {
        let fx = fixture("read-backup");
        let backup = fx
            .home
            .join(".claude")
            .join("CLAUDE.md.kodade-bak-2026-07-14T12-30-00-000Z");
        std::fs::write(&backup, "old bytes").unwrap();
        guard(&fx)
            .authorize(backup.to_str().unwrap(), Access::ReadBackup)
            .expect("a .kodade-bak sibling must be restorable");
        // The same file must NOT authorize as a normal artifact read.
        let err = guard(&fx)
            .authorize(backup.to_str().unwrap(), Access::ReadFile)
            .expect_err("a backup must never authorize as a config artifact");
        assert!(err.contains("not a known config artifact"), "got: {err}");
    }

    #[test]
    fn allows_managing_a_real_skill_directory_and_its_backup() {
        let fx = fixture("manage-skill-dir");
        let skills = fx.home.join(".claude").join("skills");
        let target = skills.join("code-review");
        guard(&fx)
            .authorize(skills.to_str().unwrap(), Access::SkillsContainer)
            .expect("a real skills container must authorize");
        guard(&fx)
            .authorize(target.to_str().unwrap(), Access::SkillDir)
            .expect("a direct child skill path must authorize before creation");
        let backup = skills.join("code-review.kodade-bak-2026-07-21T00-00-00-000Z");
        guard(&fx)
            .authorize(backup.to_str().unwrap(), Access::SkillBackupDir)
            .expect("a matching skill backup sibling must authorize");
    }

    #[test]
    fn allows_a_missing_catalog_config_root_for_first_install() {
        let fx = fixture("manage-missing-config-root");
        let codex = fx.home.join(".codex");
        std::fs::remove_dir_all(&codex).unwrap();
        let skills = codex.join("skills");
        let authorized = guard(&fx)
            .authorize(skills.to_str().unwrap(), Access::SkillsContainer)
            .expect("a first install may create a known catalog skills container");
        assert_eq!(authorized, skills);
    }

    #[test]
    fn allows_standard_agents_skill_containers_for_global_and_project_installs() {
        let fx = fixture("manage-agents-skills");
        let global = fx.home.join(".agents").join("skills");
        let project = fx.project.join(".agents").join("skills");

        assert_eq!(
            guard(&fx)
                .authorize(global.to_str().unwrap(), Access::SkillsContainer)
                .expect("the standard global .agents/skills container must authorize"),
            global,
        );
        assert_eq!(
            guard(&fx)
                .authorize(project.to_str().unwrap(), Access::SkillsContainer)
                .expect("the standard project .agents/skills container must authorize"),
            project,
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_config_root_symlink_escape_for_skill_mutation() {
        use std::os::unix::fs::symlink;
        let fx = fixture("manage-config-root-symlink");
        let codex = fx.home.join(".codex");
        std::fs::remove_dir_all(&codex).unwrap();
        let outside = fx.base.join("outside-codex");
        std::fs::create_dir_all(outside.join("skills")).unwrap();
        symlink(&outside, &codex).unwrap();
        let err = guard(&fx)
            .authorize(
                codex.join("skills").to_str().unwrap(),
                Access::SkillsContainer,
            )
            .expect_err("a catalog config-root symlink must not widen the allowlist");
        assert!(
            err.contains("not an allowed skills container"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_managing_through_a_symlinked_skills_container() {
        use std::os::unix::fs::symlink;
        let fx = fixture("manage-symlinked-container");
        let skills = fx.project.join(".claude").join("skills");
        std::fs::remove_dir_all(&skills).unwrap();
        let managed_elsewhere = fx.home.join(".claude").join("skills");
        symlink(&managed_elsewhere, &skills).unwrap();
        let err = guard(&fx)
            .authorize(
                skills.join("code-review").to_str().unwrap(),
                Access::SkillDir,
            )
            .expect_err("KödSkills must never write through a symlinked skills dir");
        assert!(err.contains("managed externally"), "got: {err}");
    }

    #[test]
    fn rejects_managing_a_skill_outside_a_literal_skills_container() {
        let fx = fixture("manage-wrong-container");
        let target = fx.home.join(".claude").join("code-review");
        let err = guard(&fx)
            .authorize(target.to_str().unwrap(), Access::SkillDir)
            .expect_err("a skill target outside skills must be rejected");
        assert!(err.contains("directly inside skills"), "got: {err}");
    }

    #[test]
    fn rejects_an_arbitrary_project_directory_named_skills() {
        let fx = fixture("manage-unlisted-skills-container");
        let skills = fx.project.join("feature").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        let err = guard(&fx)
            .authorize(skills.to_str().unwrap(), Access::SkillsContainer)
            .expect_err("only catalog skills containers may be mutated");
        assert!(
            err.contains("not an allowed skills container"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_reading_a_non_backup_as_a_backup() {
        let fx = fixture("read-backup-nonbackup");
        let claude_md = fx.home.join(".claude").join("CLAUDE.md");
        std::fs::write(&claude_md, "hi").unwrap();
        let err = guard(&fx)
            .authorize(claude_md.to_str().unwrap(), Access::ReadBackup)
            .expect_err("a normal file must not authorize as a backup");
        assert!(err.contains("not a kodade backup file"), "got: {err}");
    }

    #[test]
    fn backup_name_shape() {
        assert!(is_backup_name(
            "CLAUDE.md.kodade-bak-2026-07-14T12-30-00-000Z"
        ));
        assert!(is_backup_name("config.toml.kodade-bak-1"));
        assert!(!is_backup_name("CLAUDE.md"));
        assert!(!is_backup_name("x.kodade-bak-")); // empty timestamp tail
    }

    #[test]
    fn known_shapes_cover_disabled_and_extensions() {
        assert!(is_known_artifact_file(Path::new(
            "/x/.claude/skills/foo/SKILL.md"
        )));
        assert!(is_known_artifact_file(Path::new(
            "/x/.claude/skills/foo.md.disabled"
        )));
        assert!(is_known_artifact_file(Path::new("/x/.mcp.json")));
        assert!(is_known_artifact_file(Path::new("/x/.codex/config.toml")));
        assert!(is_known_artifact_file(Path::new("/x/.grok/GROK.md")));
        assert!(is_known_artifact_file(Path::new(
            "/x/.config/opencode/opencode.json"
        )));
        assert!(!is_known_artifact_file(Path::new("/x/.claude/id_rsa")));
        assert!(!is_known_artifact_file(Path::new("/x/.claude/notes.txt")));
    }
}
