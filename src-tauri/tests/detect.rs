// Integration tests for provider detection against the selected platform shell.
// rustc is present anywhere this Cargo test is running and supports --version.

use kodade_lib::detect::detect_version;
use kodade_lib::shell::ShellEnvironment;

#[test]
fn detects_an_existing_binary_and_returns_its_version_output() {
    let shell = ShellEnvironment::current();
    let out = detect_version(&shell, "rustc");
    assert!(out.is_some(), "rustc should be detected");
    let text = out.unwrap();
    assert!(
        !text.trim().is_empty(),
        "version output should be non-empty"
    );
    // The token trim happens in TypeScript; Rust returns the raw banner, which
    // for rustc contains a dotted release number.
    assert!(
        text.starts_with("rustc ") && text.chars().any(|c| c == '.'),
        "expected a rustc version banner, got: {text}"
    );
}

#[test]
fn missing_binary_returns_none() {
    let shell = ShellEnvironment::current();
    let out = detect_version(&shell, "kodade-definitely-not-a-real-binary-xyz");
    assert_eq!(out, None);
}

#[test]
fn unsafe_bin_names_are_rejected() {
    let shell = ShellEnvironment::current();
    assert_eq!(detect_version(&shell, "claude; rm -rf /"), None);
    assert_eq!(detect_version(&shell, "claude && echo pwned"), None);
    assert_eq!(detect_version(&shell, "$(whoami)"), None);
    assert_eq!(detect_version(&shell, r"C:\tools\claude.exe"), None);
    assert_eq!(detect_version(&shell, ""), None);
}
