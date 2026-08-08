# Changelog

## Unreleased

## 1.4.15 - 2026-08-08

- Added Grok Build as a chat-capable KödChat agent through the grok CLI's
  structured headless stream, with session resume, model selection, and
  permission-mode access levels.
- Isolated unsent composer drafts per KödChat thread so switching conversations
  preserves each draft without leaking it into another thread.
- Auto-titled KödChat threads: new threads read "New chat" and take a short
  topic title from the first prompt instead of a provider-numbered name.
- Moved the composer's provider, model, and access chips below the input
  surface and added a thinking-level chip for models that support one
  (claude --effort; codex model_reasoning_effort).
- Added a collapse toggle for the right files sidebar, mirroring the projects
  sidebar's rail, persisted across restarts, with a Mod+Shift+B shortcut.
- Removed the account settings tab.
- Fixed KödChat terminals so Show terminal immediately opens a thread-owned
  split without replacing the chat or adding a workspace card.
- Opened assistant links in the editor's browser tab instead of navigating the
  entire app window away from Ködade.
- Removed the retired hosted browser application, pairing/service code, and
  deployment configuration from the desktop source tree.
- Decoupled KödLocal tools from the retired server through a fixed-root native
  tool host.
- Removed internal planning, research, and release-evidence documents and added
  a public-source privacy check to prevent them from being recommitted.

### Release verification

| Check | Result |
| --- | --- |
| Source and packaging | Version consistency, TypeScript, public-source verification, and dependency-license verification passed (78 JavaScript packages and 347 Rust crates). |
| Automated tests | 1,944 frontend tests, 3 dependency-license script tests, and 4 public-boundary tests passed. |
| Rust | Formatting, Clippy, and test suites passed with both default and no-default feature sets. |
| macOS artifact | Apple Silicon DMG built for macOS 13+, signed with Developer ID, and accepted by Apple in both notarization stages. |
| Mounted-image audit | App and helper signatures, stapled tickets, Gatekeeper assessment, public payload, and read-only volume checks passed. |
| Windows | Not built or validated for this release. |

Artifact: `kodade_1.4.15_aarch64.dmg`

SHA-256: `a05738a32916876dacb6830c1adfd1c63cd9445f7f7623c10bcc5e9ec83f4b6b`

Apple notarization submissions:
`fb0425ed-b8e2-4772-a94b-f90d058937ba` and
`55702afc-2ffe-4a99-a192-963595aacf65` (accepted).

Stable publication remains gated on an owner-installed-app acceptance pass.

## 1.4.14 - 2026-08-02

First public Ködade release for Apple Silicon Macs running macOS 13 or newer.

- Developer ID signed, Apple-notarized, and Gatekeeper-verified distribution.
- KödChat for Claude Code and Codex, native terminals, projects, files, editor,
  KödMem, KödMCP, KödHarness, KödSkills, browser, and GitHub panes.
- Apache-2.0 source release with bundled third-party license notices.

Earlier internal development history is intentionally not reproduced here.
