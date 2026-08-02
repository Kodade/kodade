// Integration tests for the fs module: directory listing, file read caps and
// binary sniffing, and the recursive debounced watcher against real temp dirs.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kodade_lib::document::MAX_IMAGE_BYTES;
use kodade_lib::fs::{
    create_dir, create_file, list_dir, read_file, rename, watch, write_file, ChangeSink, FileRead,
    MAX_FILE_BYTES,
};

// A unique temp dir per test so parallel tests never collide.
fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kodade-fs-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// --- list_dir ---

#[test]
fn list_dir_sorts_dirs_first_then_names_and_skips_ignored() {
    let dir = temp_dir("list");
    std::fs::create_dir(dir.join("src")).unwrap();
    std::fs::create_dir(dir.join("node_modules")).unwrap(); // must be skipped
    std::fs::create_dir(dir.join(".git")).unwrap(); // must be skipped
    std::fs::write(dir.join("README.md"), b"hi").unwrap();
    std::fs::write(dir.join("app.ts"), b"x").unwrap();

    let entries = list_dir(dir.to_str().unwrap()).expect("list ok");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    // "src" (dir) first, then files alphabetically; ignored dirs absent.
    assert_eq!(names, vec!["src", "app.ts", "README.md"]);
    assert!(entries[0].is_dir);
    assert!(!entries[1].is_dir);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn list_dir_missing_path_errors() {
    assert!(list_dir("/no/such/kodade/path/xyz").is_err());
}

// --- read_file ---

#[test]
fn read_file_returns_text_for_small_utf8() {
    let dir = temp_dir("read-text");
    let path = dir.join("hello.txt");
    std::fs::write(&path, b"hello kodade").unwrap();

    match read_file(path.to_str().unwrap()).expect("read ok") {
        FileRead::Text { content } => assert_eq!(content, "hello kodade"),
        other => panic!("expected Text, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn read_file_flags_too_large() {
    let dir = temp_dir("read-large");
    let path = dir.join("big.bin");
    // One byte over the cap.
    let data = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
    std::fs::write(&path, &data).unwrap();

    match read_file(path.to_str().unwrap()).expect("read ok") {
        FileRead::TooLarge { bytes } => assert_eq!(bytes, MAX_FILE_BYTES + 1),
        other => panic!("expected TooLarge, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn read_file_flags_binary_on_null_byte() {
    let dir = temp_dir("read-binary");
    let path = dir.join("data.bin");
    std::fs::write(&path, [0x89u8, 0x00, 0x50, 0x4e]).unwrap(); // contains NUL

    assert_eq!(
        read_file(path.to_str().unwrap()).expect("read ok"),
        FileRead::Binary { bytes: 4 }
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn read_file_uses_the_larger_image_viewer_cap() {
    let dir = temp_dir("read-image");
    let path = dir.join("diagram.png");
    let file = std::fs::File::create(&path).unwrap();

    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert_eq!(
        read_file(path.to_str().unwrap()).expect("viewer-sized image is readable"),
        FileRead::Binary {
            bytes: MAX_FILE_BYTES + 1
        }
    );

    file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
    assert_eq!(
        read_file(path.to_str().unwrap()).expect("oversized image is reported"),
        FileRead::TooLarge {
            bytes: MAX_IMAGE_BYTES + 1
        }
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// --- write_file ---

#[test]
fn write_file_creates_and_overwrites_atomically() {
    let dir = temp_dir("write");
    let path = dir.join("note.txt");

    // Create.
    write_file(path.to_str().unwrap(), "first").expect("create ok");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

    // Overwrite with different-length content — full replace, no truncation.
    write_file(path.to_str().unwrap(), "second-longer").expect("overwrite ok");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "second-longer");

    // No temp scratch files linger after the renames.
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".kodade.tmp"))
        .collect();
    assert!(leftovers.is_empty(), "lingering temp files: {leftovers:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn write_file_replaces_the_same_existing_path_repeatedly() {
    let dir = temp_dir("write-repeated");
    let path = dir.join("note.txt");

    for index in 0..16 {
        let contents = format!("save {index}: {}", "x".repeat(index * 17));
        write_file(path.to_str().unwrap(), &contents).expect("every replacement succeeds");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), contents);
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn write_file_missing_directory_errors() {
    let err = write_file("/no/such/kodade/dir/file.txt", "x").unwrap_err();
    assert!(
        err.contains("directory does not exist"),
        "expected missing-dir error, got: {err}"
    );
}

#[cfg(unix)]
#[test]
fn write_file_readonly_errors_and_keeps_original() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp_dir("write-ro");
    let path = dir.join("locked.txt");
    write_file(path.to_str().unwrap(), "precious").expect("seed ok");

    // Make the file read-only: a save must fail with a clear error, not clobber.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
    let err = write_file(path.to_str().unwrap(), "clobbered").unwrap_err();
    assert!(
        err.contains("read-only"),
        "expected read-only error, got: {err}"
    );

    // Restore perms so we can verify the original bytes survived.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "precious");

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn write_file_preserves_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp_dir("write-perms");
    let path = dir.join("run.sh");
    write_file(path.to_str().unwrap(), "#!/bin/sh\necho hi\n").expect("seed ok");

    // Make it executable (0o755) — a save must not silently drop the exec bits.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    write_file(path.to_str().unwrap(), "#!/bin/sh\necho bye\n").expect("overwrite ok");

    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o755, "exec bits must survive an atomic save");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "#!/bin/sh\necho bye\n"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn write_file_follows_symlink_to_referent_and_keeps_link() {
    use std::os::unix::fs::symlink;

    let dir = temp_dir("write-symlink");
    let real = dir.join("real.txt");
    let link = dir.join("link.txt");
    std::fs::write(&real, "original").unwrap();
    symlink(&real, &link).unwrap();

    // Save through the symlink: the referent's bytes must update...
    write_file(link.to_str().unwrap(), "via link").expect("write through link ok");
    assert_eq!(std::fs::read_to_string(&real).unwrap(), "via link");

    // ...and the link must still be a symlink pointing at `real` (not replaced
    // by a regular file from the rename).
    let meta = std::fs::symlink_metadata(&link).unwrap();
    assert!(
        meta.file_type().is_symlink(),
        "the symlink must remain a symlink after saving through it"
    );
    assert_eq!(std::fs::read_link(&link).unwrap(), real);

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn write_file_precreated_temp_path_does_not_clobber() {
    // A pre-existing file/symlink sitting at our predictable temp path must not
    // be truncated or followed: create_new (O_EXCL) fails on it and the write
    // retries with the next sequence number, so the save still succeeds and the
    // decoy is left untouched.
    let dir = temp_dir("write-excl");
    let target = dir.join("doc.txt");
    std::fs::write(&target, "before").unwrap();

    // The temp name is ".kodade.tmp.<pid>.<seq>". We can't know the exact seq,
    // so plant decoys across the first several sequence numbers this process
    // will try. Each must remain intact (O_EXCL skips them, never truncates).
    let pid = std::process::id();
    let mut decoys = Vec::new();
    for seq in 0..8u64 {
        let decoy = dir.join(format!(".kodade.tmp.{pid}.{seq}"));
        std::fs::write(&decoy, "DECOY").unwrap();
        decoys.push(decoy);
    }

    write_file(target.to_str().unwrap(), "after").expect("save skips decoys");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "after");

    // Every decoy that wasn't consumed as the eventual temp survives with its
    // contents. (The one the save used will have been renamed away; the rest
    // must still read "DECOY", never truncated.)
    let survivors = decoys
        .iter()
        .filter(|d| d.exists())
        .filter(|d| std::fs::read_to_string(d).unwrap() == "DECOY")
        .count();
    assert!(
        survivors >= decoys.len() - 1,
        "O_EXCL must not truncate precreated temp-path files"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// --- file-manager mutations (v1.1) ---

#[test]
fn create_file_makes_an_empty_file_and_rejects_a_collision() {
    let dir = temp_dir("create-file");
    let path = dir.join("new.txt");

    create_file(&path).expect("create ok");
    assert!(path.is_file());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "");

    // A second create at the same path must fail (never clobber a sibling).
    let err = create_file(&path).unwrap_err();
    assert!(err.contains("already exists"), "got: {err}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn create_dir_makes_a_directory_and_rejects_a_collision() {
    let dir = temp_dir("create-dir");
    let path = dir.join("sub");

    create_dir(&path).expect("create ok");
    assert!(path.is_dir());

    let err = create_dir(&path).unwrap_err();
    assert!(err.contains("already exists"), "got: {err}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rename_moves_and_refuses_to_overwrite() {
    let dir = temp_dir("rename");
    let from = dir.join("old.txt");
    let to = dir.join("renamed.txt");
    std::fs::write(&from, b"body").unwrap();

    rename(&from, &to).expect("rename ok");
    assert!(!from.exists());
    assert_eq!(std::fs::read_to_string(&to).unwrap(), "body");

    // Renaming onto an existing sibling must be refused, not silently destroy it.
    let other = dir.join("other.txt");
    std::fs::write(&other, b"keep").unwrap();
    let err = rename(&to, &other).unwrap_err();
    assert!(err.contains("already exists"), "got: {err}");
    assert_eq!(std::fs::read_to_string(&other).unwrap(), "keep");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rename_refuses_a_collision_race_free() {
    // The no-replace rename (renamex_np RENAME_EXCL on macOS) must refuse to
    // overwrite an existing target — same guarantee as before, now without the
    // exists()+rename TOCTOU window.
    let dir = temp_dir("rename-collision");
    let from = dir.join("src.txt");
    let to = dir.join("dst.txt");
    std::fs::write(&from, b"src").unwrap();
    std::fs::write(&to, b"keep").unwrap();

    let err = rename(&from, &to).unwrap_err();
    assert!(err.contains("already exists"), "got: {err}");
    // Neither side was touched.
    assert_eq!(std::fs::read_to_string(&from).unwrap(), "src");
    assert_eq!(std::fs::read_to_string(&to).unwrap(), "keep");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rename_case_only_succeeds_on_case_insensitive_volume() {
    // Foo.txt -> foo.txt is a case-only rename. On case-insensitive APFS the two
    // names are the same inode, so a plain no-replace rename would see the target
    // as "already existing" and fail; the case-only path uses a plain rename so
    // it succeeds. On a case-sensitive volume it's just an ordinary rename.
    let dir = temp_dir("rename-case");
    let from = dir.join("Foo.txt");
    let to = dir.join("foo.txt");
    std::fs::write(&from, b"body").unwrap();

    rename(&from, &to).expect("case-only rename must succeed");
    assert_eq!(std::fs::read_to_string(&to).unwrap(), "body");
    // The final on-disk name is the lowercase target (verify via the parent
    // listing so this holds on both case-sensitive and case-insensitive volumes).
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(names.contains(&"foo.txt".to_string()), "got: {names:?}");
    assert!(
        !names.contains(&"Foo.txt".to_string()),
        "old-case name lingered: {names:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(windows)]
#[test]
fn rename_unicode_case_only_succeeds_on_windows() {
    let dir = temp_dir("rename-unicode-case");
    let from = dir.join("CAFÉ.txt");
    let to = dir.join("café.txt");
    std::fs::write(&from, "content").unwrap();

    rename(&from, &to).expect("Windows ordinal case-only rename must succeed");

    assert_eq!(std::fs::read_to_string(&to).unwrap(), "content");
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert!(names.contains(&"café.txt".to_string()), "got: {names:?}");
    assert!(
        !names.contains(&"CAFÉ.txt".to_string()),
        "old-case name lingered: {names:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn rename_operates_on_a_dangling_symlink() {
    // A symlink whose referent is gone is still a real dir entry: rename checks
    // the source with symlink_metadata, so a dangling link can be renamed.
    use std::os::unix::fs::symlink;
    let dir = temp_dir("rename-dangling");
    let link = dir.join("dead.link");
    let renamed = dir.join("moved.link");
    symlink(dir.join("nonexistent-target"), &link).unwrap();
    assert!(!link.exists(), "precondition: the link must be dangling");

    rename(&link, &renamed).expect("a dangling symlink must be renamable");
    // The link entry moved; still a (dangling) symlink at the new path.
    assert!(std::fs::symlink_metadata(&renamed)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(std::fs::symlink_metadata(&link).is_err());

    let _ = std::fs::remove_dir_all(&dir);
}

// trash::delete needs a real desktop trash backend, which sandboxed CI often
// lacks (no XDG trash dir / no Finder). Ignored by default so the suite stays
// green everywhere; run explicitly with `cargo test -- --ignored` locally to
// verify the happy path moves a file off disk into the trash.
#[test]
#[ignore = "requires an OS trash backend (Finder/XDG); run with --ignored locally"]
fn trash_moves_a_file_off_disk() {
    use kodade_lib::fs::trash;
    let dir = temp_dir("trash");
    let path = dir.join("doomed.txt");
    std::fs::write(&path, b"bye").unwrap();

    trash(&path).expect("trash ok");
    assert!(
        !path.exists(),
        "trashed file must be gone from its original path"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn trash_missing_path_errors() {
    use kodade_lib::fs::trash;
    let err = trash(std::path::Path::new("/no/such/kodade/doomed.xyz")).unwrap_err();
    assert!(err.contains("no such file"), "got: {err}");
}

#[cfg(unix)]
#[test]
#[ignore = "requires an OS trash backend (Finder/XDG); run with --ignored locally"]
fn trash_operates_on_a_dangling_symlink() {
    // A dangling symlink must be trashable: trash() checks the source with
    // symlink_metadata, so the missing referent doesn't make it "not found".
    use kodade_lib::fs::trash;
    use std::os::unix::fs::symlink;
    let dir = temp_dir("trash-dangling");
    let link = dir.join("dead.link");
    symlink(dir.join("nonexistent-target"), &link).unwrap();
    assert!(!link.exists(), "precondition: the link must be dangling");

    trash(&link).expect("a dangling symlink must be trashable");
    assert!(
        std::fs::symlink_metadata(&link).is_err(),
        "trashed link must be gone"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// --- watcher ---

// A change sink that forwards each debounced batch of paths over a channel.
type TestChangeSink = (ChangeSink, Receiver<Vec<String>>, Arc<Mutex<Vec<String>>>);

fn change_sink() -> TestChangeSink {
    let all = Arc::new(Mutex::new(Vec::<String>::new()));
    let all_sink = all.clone();
    let (tx, rx): (Sender<Vec<String>>, Receiver<Vec<String>>) = channel();
    let sink: ChangeSink = Arc::new(move |paths: Vec<String>| {
        all_sink.lock().unwrap().extend(paths.clone());
        let _ = tx.send(paths);
    });
    (sink, rx, all)
}

// Wait for at least one change batch that references `needle`, up to ~5s.
fn wait_for_change(
    rx: &Receiver<Vec<String>>,
    all: &Arc<Mutex<Vec<String>>>,
    needle: &str,
) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if all.lock().unwrap().iter().any(|p| p.contains(needle)) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        // Block briefly on the channel so we react promptly to new batches.
        let _ = rx.recv_timeout(Duration::from_millis(200));
    }
}

#[test]
fn watcher_emits_on_create_change_and_delete() {
    let dir = temp_dir("watch");
    let (sink, rx, all) = change_sink();
    let handle = watch(dir.to_str().unwrap(), sink).expect("watch starts");

    // Give the watcher a moment to arm before mutating.
    std::thread::sleep(Duration::from_millis(200));

    // Create
    let path = dir.join("created.txt");
    std::fs::write(&path, b"one").unwrap();
    assert!(
        wait_for_change(&rx, &all, "created.txt"),
        "create should emit a change"
    );

    // Change
    all.lock().unwrap().clear();
    std::fs::write(&path, b"two-longer").unwrap();
    assert!(
        wait_for_change(&rx, &all, "created.txt"),
        "modify should emit a change"
    );

    // Delete
    all.lock().unwrap().clear();
    std::fs::remove_file(&path).unwrap();
    assert!(
        wait_for_change(&rx, &all, "created.txt"),
        "delete should emit a change"
    );

    handle.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn watcher_ignores_node_modules_churn() {
    let dir = temp_dir("watch-ignore");
    let ignored = dir.join("node_modules");
    std::fs::create_dir(&ignored).unwrap();

    let (sink, rx, all) = change_sink();
    let handle = watch(dir.to_str().unwrap(), sink).expect("watch starts");
    std::thread::sleep(Duration::from_millis(200));

    // Churn inside node_modules — must NOT surface.
    std::fs::write(ignored.join("junk.js"), b"noise").unwrap();
    // A real change outside — MUST surface, and proves the watcher is alive.
    std::fs::write(dir.join("real.ts"), b"code").unwrap();

    assert!(
        wait_for_change(&rx, &all, "real.ts"),
        "real change should surface"
    );
    assert!(
        !all.lock().unwrap().iter().any(|p| p.contains("junk.js")),
        "node_modules churn must be ignored"
    );

    handle.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn project_under_an_ancestor_named_build_still_gets_events() {
    // The ignore list must apply to components INSIDE the root only — a
    // project living at .../build/myproj must not be silently event-dead.
    let base = temp_dir("watch-ancestor");
    let root = base.join("build").join("myproj");
    std::fs::create_dir_all(&root).unwrap();

    let (sink, rx, all) = change_sink();
    let handle = watch(root.to_str().unwrap(), sink).expect("watch starts");
    std::thread::sleep(Duration::from_millis(200));

    std::fs::write(root.join("main.rs"), b"fn main() {}").unwrap();
    assert!(
        wait_for_change(&rx, &all, "main.rs"),
        "events must flow for a project under an ancestor named 'build'"
    );

    handle.stop();
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn dir_entry_serializes_camel_case_for_the_ipc_contract() {
    // The frontend reads `isDir`; snake_case here silently breaks the tree.
    let dir = temp_dir("serde-contract");
    std::fs::create_dir(dir.join("sub")).unwrap();
    let entries = list_dir(dir.to_str().unwrap()).unwrap();
    let json = serde_json::to_value(&entries[0]).unwrap();
    assert!(
        json.get("isDir").is_some(),
        "expected camelCase isDir, got: {json}"
    );
    assert!(json.get("is_dir").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}
