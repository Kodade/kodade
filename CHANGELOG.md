# Changelog

## Unreleased

- Branded the macOS application, WebKit helpers, window, and document title as
  Ködade while preserving the stable lowercase `kodade.app` bundle path.
- Added Grok 4.6 to the KödChat Grok Build model picker while retaining Grok
  4.5 for existing threads.
- Added a per-thread Codex Default or Fast speed control to KödChat, with Fast
  requesting the CLI's 1.5x speed tier and increased usage per turn.
- Fixed automatic KödBrowser setup to migrate known stale packaged helper paths
  to the profile-neutral executable without replacing user-owned MCP servers.
- Fixed KödPR review diffs to wrap long lines in both unified and split views.

## 1.6.1 - 2026-08-12

- Fixed agent onboarding to persist the profile-neutral packaged KödMCP
  executable path so switching between development and public app bundles does
  not strand Claude Code or Codex on a removed resource path.
- Fixed legacy KödMem migration for existing rich `Project.md` files by adding
  the authority marker inside the pending transaction and restoring the exact
  unmarked preimage on rollback.

## 1.6.0 - 2026-08-11

- Consolidated the duplicate Providers and KödChat settings pages into one
  KödChat section while redirecting retired Providers links safely.
- Added KödMem projects-vault registration and portable logical project
  mappings so multiple local workspaces can share one stable project identity
  without using checkout paths as identity.
- Added bounded, provenance-tagged project context refreshed from mapped
  Obsidian Markdown in KödMem, KödMCP, local KödChat providers, and the Memory
  pane while preserving the existing unmapped workflow.
- Added a previewable, idempotent project-knowledge setup that creates only
  missing Obsidian roles, preserves existing notes, rejects stale plans and
  unsafe paths, and opens the mapped project hub in Obsidian.
- Added Markdown-first KödMem writes for greenfield mapped projects, including
  exact-once daily Worklog checkpoints, content-hash-protected STATE updates,
  portable Decisions and Knowledge records, recoverable journaling, and full
  SQLite projection rebuilds from validated canonical notes.
- Preserved canonical source, pin, version, and timestamp metadata in fresh or
  already-projected read-only searches without stale duplicate hits; literal
  Obsidian template syntax now round-trips without substitution, and bounded
  authority/journal reads plus durable lane moves harden portable recovery.
- Added a native-only preview, apply, recovery, and rollback workflow for
  migrating eligible repo-local KödMem history into canonical projects-vault
  Markdown. Portable cutover receipts are committed last, legacy sources are
  retained but deactivated, and interrupted or cross-machine migrations fail
  closed until their durable recovery state is resolved.
- Added one previewed, reversible agent-onboarding transaction for Claude Code
  and Codex: project-scoped KödMCP discovery, exact managed instruction blocks,
  the versioned `kodmem-project` workflow, read-only or writable access, and
  real CLI plus stdio context health verification.
- Added a clean-commit acceptance harness and owner procedure proving mapped
  projects-vault recovery across machines, forced concurrent checkpoints,
  Obsidian edit conflicts, scoped KödMCP isolation, failpoint recovery, and
  zero secret residue.

## 1.5.1 - 2026-08-08

- Added OpenCode as a first-class KödChat provider with native session resume,
  structured reasoning/tool output, access modes, and project-scoped dynamic
  model discovery that always retains the CLI-configured Default.
- Added public Ollama chat over its loopback OpenAI-compatible API, including
  dynamic installed models, streamed reasoning/text, stop, and persisted
  client-side conversation history with clean provider/model boundaries.
- Replaced KödChat's per-call tool rows with compact work summaries that keep
  bounded arguments and results available through Details.
- Added GitHub issue/pull-request link icons and a current-working-tree Edited
  files card that opens the existing KödPR review beside KödChat.
- Made KödChat's thread-owned terminal split vertically resizable while
  preserving the chat and terminal across thread switches.
- Removed the terminal work/status shelf so terminal PTYs are created only by
  the explicit Show terminal action and remain owned by their KödChat thread.

## 1.4.15 - 2026-08-08

- Added Grok Build as a chat-capable KödChat agent through the grok CLI's
  structured headless stream, with session resume, model selection, and
  permission-mode access levels.
- Preserved the login-shell PATH when KödChat launches provider CLIs so Grok
  Build can find secondary runtimes such as Node.js in the packaged macOS app.
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
- Published as the stable Apple Silicon release after owner-installed
  acceptance, including Grok Build validation.

## 1.4.14 - 2026-08-02

First public Ködade release for Apple Silicon Macs running macOS 13 or newer.

- Developer ID signed, Apple-notarized, and Gatekeeper-verified distribution.
- KödChat for Claude Code and Codex, native terminals, projects, files, editor,
  KödMem, KödMCP, KödHarness, KödSkills, browser, and GitHub panes.
- Apache-2.0 source release with bundled third-party license notices.

Earlier internal development history is intentionally not reproduced here.
