# Projects vault acceptance

This procedure proves the supported projects-vault KödMem source behavior at
one exact commit. It is safe to run locally because the automated scenarios use
temporary vaults, checkouts, databases, and agent configurations. The harness
does not inspect or modify a real Obsidian vault.

The automated proof is deliberately narrower than a release. It does not claim
that an application was packaged, signed, notarized, installed, published, or
downloaded from the public release page.

## Automated acceptance

Start from a clean checkout of the commit being accepted:

```sh
pnpm install --frozen-lockfile
pnpm test:projects-vault
```

The runner fails closed if any tracked or non-ignored untracked source change is
present before it records `git rev-parse HEAD`. Its only output file is ignored
by Git:

```text
artifacts/projects-vault-acceptance.json
```

The evidence contains the exact commit, platform, fixed gate command, exit
status, duration, and SHA-256 of each gate's combined output. It never stores
raw command output. A caller cannot substitute a different command for a named
gate.

The gates prove:

| Gate | Proof |
| --- | --- |
| `native-scenarios` | Fresh-machine relink and exact reconstruction from empty and byte-corrupt SQLite; deterministic two-process overlap on the production project lock; a direct Obsidian edit after hash read followed by typed conflict and fresh-hash retry; real scoped KödMCP cross-project read and write denial; secret rejection and residue scanning. |
| `checkpoint-recovery` | Every persisted checkpoint failpoint from the recovery suite can be retried without a lost or duplicate durable entry. |
| `mapped-mcp` | The existing real-stdio mapped KödMCP contract, including state compare-and-swap, fallback, and exact Markdown rebuild. |
| `ui-workflows` | Migration preview, retained sources, conflict display, rollback, and the reversible Claude Code and Codex onboarding flow. |
| `public-profile` | The compiled public frontend retains the KödMem settings surface while development-only features remain absent. |
| `public-source` | Only the explicit public documentation and source boundary is tracked; private, retired, and machine-specific material is rejected. |
| `public-frontend` | The public frontend, Tauri public configuration, bundled-resource manifest, and dependency-license reports pass their source build gates. |

`nativeAcceptance` in the manifest means native source-level behavior compiled
without default Cargo features. It is not a packaged or installed application
claim. The later release fields remain `not-run` until their own stages occur.

### Scenario details

The fresh-machine scenario creates canonical Markdown on machine A, copies only
that vault to a distinct vault path on machine B, maps it from a distinct
checkout, and reconstructs a new empty SQLite projection. It then replaces the
derived database with non-SQLite bytes and proves that recovery preserves a
corrupt backup while rebuilding the same known semantic snapshot and canonical
tree hash. Neither checkout path appears in canonical Markdown.

The concurrency scenario uses two child processes with distinct databases and
workspaces. Writer A holds the real shared project lock. Writer B announces its
attempt but cannot cross its post-lock barrier until A is released. Both unique
checkpoint markers appear exactly once, including after idempotent retries.

The Obsidian scenario reads the current `STATE.md` source hash through a real
scoped KödMCP process, changes the file directly, and attempts the stale write.
The server returns `content_conflict`, preserves the human bytes, exposes the
fresh hash, and accepts one intentionally reconciled retry.

The isolation scenario runs the real KödMCP stdio server scoped to project A.
It proves that project B is absent from context and search and that project B
context, checkpoint, and revision calls are denied. A runtime-generated secret
is rejected, then a fresh real-MCP context read and search prove it cannot be
retrieved from the logical projection. Its bytes are also searched across the
full vault and store tree, SQLite plus WAL/SHM and a derived-store backup,
recovery journals and locks, audit and error serialization, MCP stderr, and the
sanitized evidence fixture. The scan must report zero matches.

## Full local and CI source gates

Run the same source checks used by the quality workflow before handoff:

```sh
pnpm check:version
pnpm typecheck
pnpm test
pnpm test:public
pnpm verify:public-source
pnpm build:public
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
TAURI_CONFIG='{"build":{"frontendDist":".."},"bundle":{"resources":[]}}' \
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
  --no-default-features --all-targets -- --test-threads=1
```

The projects-vault harness intentionally repeats the focused proof at the exact
accepted commit. The full Cargo command is the broader native source-profile CI
gate. Neither command creates a distributable application package.

## Visible owner evidence

Use a disposable Obsidian vault and disposable repository for this review. Do
not use a production vault for acceptance screenshots.

1. In **Settings → KödMem**, register the disposable projects vault and map
   the repository to a portable project ID. Capture the registered vault,
   logical project ID, and mapped state without exposing a home-directory path.
2. Seed eligible legacy memory, open **Project knowledge setup**, and capture
   the migration preview. The image must visibly identify the logical project,
   list every planned Markdown operation, state that sources are retained, and
   show any duplicate or conflict counts.
3. Apply the preview, verify the success and recovery-backup state, then use a
   second disposable run to capture retry or rollback. Redact the backup path;
   retain only its basename or a stable artifact hash in evidence.
4. In the Memory pane, open **Connect agents**. Capture Claude Code and Codex,
   the chosen read-only or read-write mode, the reversible batch preview, and
   the final discovery plus scoped-stdio health result.
5. Close and reopen the app, relink the disposable project from a second
   checkout path, and verify that the same logical project context appears.

The repository's UI tests use a simulated DOM and do not include a browser or
native screenshot driver. The `ui-workflows` gate therefore automates the
visible behavior and copy, while the four screenshots above remain explicit
owner evidence. Do not mark them complete from component-test output alone.

## Evidence checklist

Record paths as repository-relative names or redacted basenames. Never attach
vault contents, raw logs, tokens, credentials, or home-directory paths.

| Stage | Required evidence | Status |
| --- | --- | --- |
| Automated acceptance | Evidence JSON commit and overall result; each fixed gate is `passed`; artifact SHA-256 recorded. | PASS / FAIL |
| Commit | Accepted Git commit and clean-tree proof. | PASS / FAIL |
| Source profile | Public profile test, source allowlist, frontend build, and full no-default-features native tests. | PASS / FAIL |
| Package | Package command, exact commit, platform/architecture, artifact name, and SHA-256. | PASS / FAIL / NOT RUN |
| Sign | Signing identity and verification result, without certificate secrets. | PASS / FAIL / NOT RUN |
| Notarize | Apple submission identifier and stapling verification. | PASS / FAIL / NOT RUN |
| Installed owner acceptance | Installed artifact hash plus the visible workflow evidence above. | PASS / FAIL / NOT RUN |
| Publish | Release URL, tag, and uploaded artifact hashes. | PASS / FAIL / NOT RUN |
| Public-download verification | Independent download URL, downloaded hashes, Gatekeeper result, launch result, and visible workflow result. | PASS / FAIL / NOT RUN |

For each automated or manual row, also record the date, tester, operating
system and architecture, command or action, expected assertion, actual status,
artifact SHA-256 where applicable, and concise redacted notes. A source-level
PASS must never be copied forward as package, installation, publication, or
public-download proof.
