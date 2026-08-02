# Contributing to Ködade

Thanks for helping improve Ködade. Small, focused changes with a clear user
outcome are easiest to review and ship.

## Before starting

- Search existing issues and discussions before opening a duplicate.
- For a bug fix or small documentation improvement, a focused pull request is
  welcome.
- For a new product surface, architectural change, or dependency, open an issue
  first so the direction can be agreed before substantial work begins.
- Never include provider credentials, tokens, terminal transcripts, private
  project data, or machine-specific paths in an issue, fixture, or commit.

## Development setup

Prerequisites are Node.js 24+, pnpm 11+, Rust stable, and the platform tools
required by Tauri. On macOS, install Xcode Command Line Tools.

```bash
git clone https://github.com/Kodade/kodade.git
cd kodade
pnpm install --frozen-lockfile
pnpm tauri dev
```

The normal validation loop is:

```bash
pnpm check:version
pnpm typecheck
pnpm test
pnpm test:public
pnpm build:public
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --all-targets
```

Platform-specific or native changes may require additional checks documented in
[`docs/`](docs/) and the pull-request template.

## Project conventions

- Spell product surfaces as `Köd[Name]` in prose and UI text. ASCII names are
  used only where required by code, paths, package names, or URLs.
- Keep Rust focused on platform boundaries. Product behavior normally belongs
  in TypeScript.
- Preserve the distinction between supported public features and development
  features described in [ROADMAP.md](ROADMAP.md).
- Public builds must fail closed: hiding navigation is not enough if a native
  or frontend command remains callable.
- Prefer readable, maintainable code and focused regression tests.
- New dependencies need a clear benefit and a compatible redistributable
  license.

## Commits and sign-off

Commit messages use `<type>: <description>`, for example:

```text
fix: preserve terminal working directory
docs: clarify public build scope
```

Types include `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, and
`ci`.

Ködade uses the [Developer Certificate of Origin](DCO). Sign every commit:

```bash
git commit -s -m "fix: describe the change"
```

The sign-off certifies that you have the right to contribute the work under the
project license. It is not an AI-attribution field; do not add generated-by or
co-author trailers for tools.

## Pull requests

- Keep the diff scoped to one coherent outcome.
- Explain what changed, why, and how it was verified.
- Include screenshots for visible UI changes.
- Call out platform-specific validation that was not run.
- Update user-facing docs and `CHANGELOG.md` when behavior changes.
- Do not claim a packaged, signed, notarized, or user-tested result without the
  corresponding artifact evidence.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
