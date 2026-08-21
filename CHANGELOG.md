# Changelog

## 2.0.2 - 2026-08-21

- The Code tab now keeps a chat and its terminal in one workspace. "New
  terminal" beside an open chat joins that chat's workspace instead of opening
  a separate sidebar entry, and starting a chat beside a standalone terminal
  folds the terminal (and its splits) into the new thread.
- Selecting a terminal no longer blanks the chat window: KödChat keeps the
  project's latest thread on screen so chat and terminal stay usable side by
  side.
- The workspace sidebar highlights the open session only in the active
  project, and no longer repeats the "Workspaces" heading.
- Splitting a standalone terminal works again in the public build.

Platform status: macOS Apple Silicon — automated suite green (2,558 tests),
human QA by Keith on this build. Windows — untested.

## 2.0.1 - 2026-08-21

- Fixed the Code tab's "New terminal" button doing nothing when no chat was
  selected. An explicit click now opens a project-scoped terminal, the same
  way login and agent terminals already could.

## 2.0.0 - 2026-08-20

- The tabbed layout is now how Ködade opens. Projects, terminals, files, the
  editor, and agents live behind Agents, Code, and Editor tabs in the title
  bar, with one workspace sidebar that stays put as you move between them — and
  a tab you have opened keeps running in the background, so switching away from
  a terminal or an agent never interrupts it. Upgrading carries your work over:
  the sidebar width you already chose becomes the tabbed layout's, and your
  projects, open files, and sessions are where you left them. If you would
  rather keep the four-pane layout from 1.x, the title-bar button to the left
  of the workspace actions switches back to the classic layout at any time, and
  that choice sticks across restarts. The classic layout stays available for
  one more release.
- The Agents tab now builds reusable agent personas. A persona is a name, a
  provider, a system prompt, and the KödSkills it should lean on, kept in an
  app-wide or per-workspace list; preparing a run drafts a normal KödWork
  background task from the persona and hands off to the existing spawn path, so
  a launched persona keeps durable progress, scoped permissions, review, and
  recurrence. The persona document is versioned and never overwritten when it
  can't be read, so a downgrade or a corrupt file can't wipe your agents.
- Personas can now attach Connections — MCP servers an agent should reach —
  from a curated catalog (vidIQ, fal Docs, Gmail, GitHub, Notion, Context7,
  Playwright, and Fetch, each with its provenance and auth requirement shown)
  or a custom stdio/remote server you enter yourself. Ködade stays bring-your-
  own-key: it never stores, bundles, or proxies a credential, and there are no
  key fields anywhere — a catalog entry only tells you which token or OAuth
  client to set up in your own CLI config. Enabling a connection installs its
  server into the CLI's own MCP config through the same preview-then-apply
  review the KödHarness tools use, so nothing is written silently, and an
  attached connection can't let a run do anything a KödWork task with the same
  CLI config couldn't. Remote endpoints install into every supported CLI —
  including Codex and Grok `config.toml`, verified against each CLI's own docs,
  where only the server URL is ever written so auth stays in your hands.
  Preparing a run warns — without blocking — when an attached connection
  isn't installed for the chosen provider.
- Signing an agent CLI in now lives in the surface where it fails. When a chat
  turn or a KödWork task stops because the CLI is signed out, the thread or
  task says so and offers a terminal running that CLI's own sign-in command —
  `claude auth login`, `codex login`, `grok login`, or `opencode auth login` —
  so every provider lands on its login flow instead of a TUI, and nothing
  routes through settings to get working again. Where a login terminal has
  nowhere to open yet, the button says so instead of failing silently. Ködade
  still never sees or stores the credential. Settings → Providers keeps the
  provider identity it is for: which agent CLIs are detected and at what
  version, where to install a missing one, the same sign-in shortcut, and which
  provider a new chat starts on.
- New KödMem setups keep project knowledge in a git-ignored
  `.kodade/knowledge` directory inside the project, with zero setup: enabling
  KödMem for a project now creates the knowledge surface and its files in the
  same step, so there is nothing to choose and nothing to connect first. Sync
  with an Obsidian projects vault is now the explicit option, collapsed under
  Settings → KödMem, and switching a project from local knowledge to vault sync
  asks first and leaves the files already in `.kodade/knowledge` on disk.
  Existing vault setups are unchanged and keep their current screen; a project
  that had KödMem enabled before this release is never converted on its own and
  can set up local project knowledge with one click. A project can only have
  one knowledge surface: mapping a project to an Obsidian vault is now refused
  while local project knowledge is on, and asks you to turn it off first.
- Retired the KödHarness inventory pane. The artifact matrix, its scope
  toggle, the in-app instruction editor, and the per-artifact enable/disable
  switches are gone: instruction files such as CLAUDE.md and AGENTS.md are
  yours to edit directly in the editor, and Ködade's own guidance to agents is
  the background prompt. The tools that actually change something stay, now
  inline under Settings → Advanced → KödHarness — install and update the
  KödSkills pack, add a project skill to the right target directories, and
  merge one MCP server into a detected config file, each with the same
  preview-then-apply confirmation as before.
- Agents Ködade starts in chat and KödWork now receive a short, token-lean
  background note that they are running inside Ködade, so answers arrive
  direct and render well in the chat and terminal panes. It is on by default,
  and Settings → Advanced → KödHarness shows the exact text, lets you rewrite
  it, and switches it off entirely. The note is sent only to sessions Ködade
  launches — it is never written to CLAUDE.md, AGENTS.md, or any other file on
  disk, so your own terminal sessions of the same CLIs are unaffected.
- Archived the embedded KödBrowser pane: public release builds no longer ship
  the browser tab, its title-bar action, the native browser commands, or the
  KödBrowser agent tools, and chat links open in the system browser instead.
  Persisted browser tabs from earlier versions are dropped on restore without
  affecting other tabs. On first launch after upgrading, Ködade also removes
  the `kodade-browser` MCP server and the managed browser rule it previously
  wrote into installed agent CLIs, leaving any same-named entry a user owns
  untouched. The surface stays in source behind the development-feature flag
  so it can be revived.
- Fixed the macOS application identity so the app installs as `Kodade.app` with
  a `Kodade` main executable, keeping Ködade in Finder, the Dock, and the menu
  bar while Activity Monitor no longer shows a lowercase process name.
  Documented why the separate WebKit web-content row is attributed to the
  embedded web view's page origin.

## 1.7.1 - 2026-08-16

- Fixed KödMem settings overflow and added one-time, reviewable consent for
  automatic Claude Code and Codex connector reconciliation on mapped projects.
- Clarified KödWork's empty state with one explicit project-targeted task
  action while keeping populated views focused on projects with actual work.
- Kept KödChat ownership tied to the native provider process, including clear
  detached-stream status and recovery when Claude output resumes.
- Fixed KödPR to retain each KödChat's checkout, baseline, and explicit
  worktree/PR review target instead of silently reviewing an unrelated root.
- Fixed Codex collaboration activity emitted by the CLI to appear in KödChat
  tool cards instead of being silently dropped.
- Added user- and project-scoped Codex custom-agent TOML profiles to the
  KödHarness inventory without exposing them as KödLocal agents.

### Platform status

- macOS Apple Silicon: stable DMG; Developer ID signed, Apple notarized,
  stapled, and Gatekeeper verified.
- Windows x64: not packaged or tested for this release.

## 1.7.0 - 2026-08-14

- Added the KödWork surface for background CLI tasks with
  durable progress, scoped tool approvals, reviewable and restorable file
  output, native attention, KödSkills templates, and in-app recurrence.
- Branded the macOS application, WebKit helpers, window, and document title as
  Ködade while preserving the stable lowercase `kodade.app` bundle path.
- Added Grok 4.6 to the KödChat Grok Build model picker while retaining Grok
  4.5 for existing threads.
- Added a per-thread Codex Default or Fast speed control to KödChat, with Fast
  requesting the CLI's 1.5x speed tier and increased usage per turn.
- Fixed automatic KödBrowser setup to migrate known stale packaged helper paths
  to the profile-neutral executable without replacing user-owned MCP servers.
- Fixed KödPR review diffs to wrap long lines in both unified and split views.
- Fixed workspace panes to retain one user-sized layout across chats and
  projects, preserve explicit sidebar visibility, and keep the Files pane
  recoverable when editor content changes.
- Fixed long KödChat tool paths and command details to wrap inside the chat
  activity card instead of painting across adjacent panes.

### Platform status

- macOS Apple Silicon: stable DMG; owner accepted, Developer ID signed, Apple
  notarized, stapled, and Gatekeeper verified.
- Windows x64: not packaged or tested for this candidate.

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
