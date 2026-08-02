// Path confinement for filesystem operations. Mutations keep the literal final
// path component so rename/trash affect a symlink itself; document reads resolve
// the entire target so a symlink cannot expose data outside the project.

use std::path::{Component, Path, PathBuf};

// Resolve the parent of a mutation target and preserve the target's literal final
// component. This confines creates and blocks directory-symlink escapes, while
// preserving the expected semantics for rename/trash of an existing symlink.
pub fn confine_mutation(root: &str, target: &str) -> Result<PathBuf, String> {
    let root_canon = std::fs::canonicalize(root)
        .map_err(|e| format!("project root is unavailable: {root}: {e}"))?;
    let target_path = Path::new(target);
    if !target_path.is_absolute() {
        return Err(format!("path must be absolute: {target}"));
    }
    let file_name = target_path
        .file_name()
        .ok_or_else(|| format!("path has no final component: {target}"))?;
    if matches!(file_name.to_str(), Some(".") | Some("..")) {
        return Err(format!("invalid final path component: {target}"));
    }
    let parent = target_path
        .parent()
        .ok_or_else(|| format!("path has no parent directory: {target}"))?;
    let parent_canon = std::fs::canonicalize(parent)
        .map_err(|e| format!("parent directory is unavailable: {}: {e}", parent.display()))?;

    ensure_inside_root(&root_canon, parent_canon.join(file_name), target)
}

// Resolve an existing document fully before serving it. Unlike mutation
// confinement, the resolved path intentionally follows the final symlink.
pub fn confine_document_read(root: &str, target: &str) -> Result<PathBuf, String> {
    confine_existing(root, target, false)
}

// Resolve an existing directory fully before listing it. Directory reads use
// the same symlink-aware boundary as document reads, but the project root
// itself is a valid list target (`list_dir({path:"."})`).
pub fn confine_directory_read(root: &str, target: &str) -> Result<PathBuf, String> {
    confine_existing(root, target, true)
}

fn confine_existing(root: &str, target: &str, allow_root: bool) -> Result<PathBuf, String> {
    let root_canon = std::fs::canonicalize(root)
        .map_err(|e| format!("project root is unavailable: {root}: {e}"))?;
    let target_path = Path::new(target);
    if !target_path.is_absolute() {
        return Err(format!("path must be absolute: {target}"));
    }
    let resolved = std::fs::canonicalize(target_path)
        .map_err(|e| format!("document is unavailable: {target}: {e}"))?;

    ensure_inside_root_with(&root_canon, resolved, target, allow_root)
}

fn ensure_inside_root(
    root_canon: &Path,
    resolved: PathBuf,
    target: &str,
) -> Result<PathBuf, String> {
    ensure_inside_root_with(root_canon, resolved, target, false)
}

fn ensure_inside_root_with(
    root_canon: &Path,
    resolved: PathBuf,
    target: &str,
    allow_root: bool,
) -> Result<PathBuf, String> {
    if !resolved.starts_with(root_canon) {
        return Err(format!(
            "refusing to operate outside the project root: {target}"
        ));
    }
    // The root itself is never a valid mutation target: you can create/rename/
    // trash things INSIDE the project, but the project directory itself must not
    // be renamed or trashed out from under the app. `starts_with` above is true
    // for `root == resolved`, so reject that exact case explicitly.
    if !allow_root && resolved == root_canon {
        return Err(format!(
            "refusing to operate on the project root itself: {target}"
        ));
    }
    // Belt-and-suspenders: no ".." survived into the resolved path (canonicalize
    // strips them, but a defensive check costs nothing and documents intent).
    if resolved.components().any(|c| c == Component::ParentDir) {
        return Err(format!("path escapes the project root: {target}"));
    }

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A unique temp dir per test so parallel tests never collide.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kodade-pathguard-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Canonicalize so the test's expectations compare against the same real
        // location the guard resolves to (/tmp vs /private/tmp on macOS).
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn confine_allows_a_child_inside_the_root() {
        let root = temp_dir("inside");
        let target = root.join("newfile.txt");
        let ok = confine_mutation(root.to_str().unwrap(), target.to_str().unwrap())
            .expect("a path inside the root must be allowed");
        assert!(ok.starts_with(&root));
        assert!(ok.ends_with("newfile.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn confine_allows_a_nested_child() {
        let root = temp_dir("nested");
        std::fs::create_dir(root.join("src")).unwrap();
        let target = root.join("src").join("mod.rs");
        confine_mutation(root.to_str().unwrap(), target.to_str().unwrap())
            .expect("a nested path inside the root must be allowed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn confine_rejects_a_dotdot_escape() {
        let root = temp_dir("dotdot");
        let sub = root.join("sub");
        std::fs::create_dir(&sub).unwrap();
        // sub/../../escape.txt resolves above the root.
        let target = sub.join("..").join("..").join("escape.txt");
        let err = confine_mutation(root.to_str().unwrap(), target.to_str().unwrap())
            .expect_err("a ../ escape must be rejected");
        assert!(err.contains("outside the project root"), "got: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn confine_rejects_a_sibling_outside_the_root() {
        let base = temp_dir("sibling");
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        // A path in `base` (the root's parent) is outside the confined root.
        let target = base.join("secret.txt");
        let err = confine_mutation(root.to_str().unwrap(), target.to_str().unwrap())
            .expect_err("a sibling outside the root must be rejected");
        assert!(err.contains("outside the project root"), "got: {err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn confine_rejects_a_symlink_that_points_out_of_the_root() {
        use std::os::unix::fs::symlink;

        let base = temp_dir("symlink");
        let root = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();

        // A symlink inside the root pointing AT the outside dir. Writing through
        // it (root/link/evil.txt) resolves the parent to `outside` — must reject.
        let link = root.join("link");
        symlink(&outside, &link).unwrap();
        let target = link.join("evil.txt");

        let err = confine_mutation(root.to_str().unwrap(), target.to_str().unwrap())
            .expect_err("a symlink escaping the root must be rejected");
        assert!(err.contains("outside the project root"), "got: {err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn confine_rejects_the_root_itself_as_a_target() {
        // The project root must never be a mutation target — fs_trash(root, root)
        // and the like must fail even though the root trivially "starts_with" itself.
        let root = temp_dir("root-target");
        let err = confine_mutation(root.to_str().unwrap(), root.to_str().unwrap())
            .expect_err("the root itself must be rejected as a mutation target");
        assert!(err.contains("project root itself"), "got: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn confine_rejects_a_relative_target() {
        let root = temp_dir("relative");
        let err = confine_mutation(root.to_str().unwrap(), "notabs.txt")
            .expect_err("a relative target must be rejected");
        assert!(err.contains("must be absolute"), "got: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn mutation_confinement_preserves_an_in_root_symlink_as_the_target() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("mutation-symlink");
        let referent = root.join("real.txt");
        let link = root.join("link.txt");
        std::fs::write(&referent, "real bytes").unwrap();
        symlink(&referent, &link).unwrap();

        let target = confine_mutation(root.to_str().unwrap(), link.to_str().unwrap())
            .expect("the symlink entry is a valid in-root mutation target");

        assert_eq!(target, link);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn document_confinement_rejects_a_symlink_to_outside_the_root() {
        use std::os::unix::fs::symlink;

        let base = temp_dir("document-symlink");
        let root = base.join("project");
        let outside = base.join("outside.png");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(&outside, "not for the viewer").unwrap();
        let link = root.join("outside.png");
        symlink(&outside, &link).unwrap();

        let err = confine_document_read(root.to_str().unwrap(), link.to_str().unwrap())
            .expect_err("document reads must follow and reject an escaping symlink");

        assert!(err.contains("outside the project root"), "got: {err}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn document_confinement_resolves_an_in_root_symlink_to_its_referent() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("document-in-root-symlink");
        let referent = root.join("real.png");
        let link = root.join("link.png");
        std::fs::write(&referent, "image bytes").unwrap();
        symlink(&referent, &link).unwrap();

        let target = confine_document_read(root.to_str().unwrap(), link.to_str().unwrap())
            .expect("document reads may follow an in-root symlink");

        assert_eq!(target, referent);
        let _ = std::fs::remove_dir_all(root);
    }
}
