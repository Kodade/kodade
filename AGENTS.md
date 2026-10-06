# kodade

Ködade is a macOS-first Agentic Development Environment: a native desktop app
for projects, terminals, files, an editor, and installed agent CLIs. The public
product is at `kodade.com`.

## Current status

The supported public package targets macOS Apple Silicon. Windows, KödLocal,
KödWhisper, KödSSH, and Remote are active development surfaces. The hosted
browser application has been removed and is not part of this repository.

## Commands

```bash
pnpm install
pnpm tauri dev
pnpm typecheck
pnpm test
pnpm test:public
pnpm verify:public-source
pnpm tauri:build:public
```

`pnpm tauri build` is the full-feature development/QA package.
`pnpm tauri:build:public` is the public-release flavor and packages only
approved public resources.

## Non-negotiable conventions

- Köd[Name] uses the umlaut in prose, docs, comments, and UI strings. Use ASCII
  only where required by filenames, identifiers, binary names, or URLs.
- Keep Rust thin: PTY, filesystem, process, and platform integration belong
  there; product logic belongs in TypeScript.
- Resolve providers through a login shell so `PATH` matches the user's real
  environment. Ködade wraps official CLIs and never proxies credentials.
- Build user-facing features for progressive disclosure: clear defaults,
  visible state, and escape hatches for advanced users.
- Ködade is a general-purpose ADE, not an estimating tool.
- Keep research, internal planning, monetization work, release evidence, and
  machine-specific material outside this public repository.

Read [ROADMAP.md](ROADMAP.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the
relevant public documentation before changing an area. GitHub issues are the
source of truth for detailed work status.
