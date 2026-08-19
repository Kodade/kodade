# Windows CI

The `Windows verification` workflow is Kodade's native Windows regression gate.
It runs on the pinned `windows-2025` GitHub-hosted image with stable x64 MSVC
Rust, Node 24, pnpm 11.8.0, and the LunarG Vulkan SDK required by KödLocal's
Windows `modeld` build.

Every push, pull request, merge-queue candidate, and manual dispatch runs:

```text
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm vitest run
pnpm build
pnpm build:cli
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features modeld --all-targets -- -D warnings
cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets
cargo check --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features modeld --all-targets
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets -- --test-threads=1
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features modeld --lib --bin kodade-modeld --test modeld_http -- --test-threads=1
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib browser::platform::windows_smoke::real_webview2_child_enforces_lifecycle_and_remote_ipc_boundary -- --exact --ignored --nocapture --test-threads=1
pnpm tauri build --bundles nsis
./scripts/windows-release-metadata.ps1 ...
./scripts/windows-rc.ps1 ...
```

The KödLocal CLI bundle is built before any Rust command because Tauri validates
configured resource paths during `cargo check` and Clippy, not only during the
final installer build.

Rust runs two explicit native feature matrices. The default application matrix
includes KödWhisper; the `--no-default-features --features modeld` matrix covers
the KödLocal daemon. Both upstream engines vendor ggml, and MSVC correctly
rejects linking both copies into one binary, so combining the features would be
a false product configuration rather than stronger coverage.

The full Rust test command executes `src-tauri/tests/pty_windows.rs` on native
Windows, including ConPTY I/O, resize and exit, Job Object teardown, retained
handle fallback, and descendant cleanup. The browser-child test is ignored by
the general suite and immediately invoked by its exact name in a required,
five-minute-bounded step. CI also checks the test summary for exactly one pass,
so a stale filter cannot produce a zero-test false green. Its milestone output
makes a native lifecycle stall diagnosable without weakening the gate. Keeping
the tests serial prevents the process-global failure-injection seams from
interfering with one another.

The release gate uses `pnpm tauri build --bundles nsis`. It produces the
versioned x64 installer, a SHA-256 checksum, and a JSON release manifest. The RC
script performs a clean silent current-user install with NSIS `/S`, requires an
`HKCU` uninstall entry, and rejects a matching `HKLM` entry. It seeds a project
path containing spaces and Unicode, launches the app, gracefully closes its real
main window, requires and identity-tracks the real `msedgewebview2.exe` tree to
quiescence, reinstalls, launches again, and uninstalls. The project document and
a separate current-user sentinel must remain byte-identical across every step.

Successful runs retain two artifacts:

- the versioned installer, `.sha256`, and JSON release manifest for 14 days
- the unpacked `Kodade.exe`, PDB, and frontend `dist/` for seven days

The first artifact is the distributable installer; the unpacked build is useful
for diagnostics. Pull-request packages are intentionally unsigned and require
no signing secrets. See `docs/WINDOWS.md` for install, build, troubleshooting,
and release instructions.

The Rust suite also creates a real Win32 parent window and Wry child WebView2 on
the runner. A loopback HTTP fixture drives navigation, non-HTTP frame and main
document attempts, `about:blank` and `srcdoc` frame probes, a popup, a download,
and both WebView2 message APIs. At Kodade's private native Wry policy surface,
the harness verifies bounds and visibility, back/forward history, reload, real
child-HWND destruction, policy callback denials, `IsWebMessageEnabled = false`,
JavaScript message attempts, and zero arrivals at an independent native message
sentinel. WebView2 may return normally to JavaScript while discarding a disabled
message. The harness does not exercise `platform::create`/`destroy`, Tauri
main-thread scheduling, or registry dispatch. The harness is compiled only for
Windows tests and does not add a command bridge or test endpoint to the
production application.

Automation still does not prove visible UI interaction, authenticated
providers/`gh`, WebView2 recovery on a missing-runtime host, or visual browser
behavior. Those remain Windows 11 human gates and must be recorded with the
release issue.

This native gate supplements rather than replaces the macOS integration proof.
Before merging the Windows train, also run the TypeScript typecheck, Vitest,
Rust tests, and the Tauri build on macOS.

To reproduce the native gate on a Windows development machine, install the
stable x86_64 MSVC toolchain with `rustfmt` and `clippy`, install the LunarG
Vulkan SDK, set `VULKAN_SDK` to its version directory, then run the commands
above from the repository root. CUDA is intentionally not part of this lane.
