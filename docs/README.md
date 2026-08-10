# Ködade documentation

This directory contains public contributor and release documentation only.
Research, internal design notes, planning records, monetization work, and
release evidence are maintained outside the public repository.

- [Roadmap](../ROADMAP.md)
- [Projects vault workflow](#projects-vault-workflow)
- [Projects vault acceptance](PROJECTS-VAULT-ACCEPTANCE.md)
- [macOS release process](RELEASING.md)
- [Windows build and status](WINDOWS.md)
- [Windows CI](WINDOWS-CI.md)

## Projects vault workflow

Ködade can register an Obsidian projects vault, map a workspace to a portable
project identity, and preview the minimal knowledge structure for that project.
The preview lists every missing folder and file, shows generated file content,
and carries a fingerprint that prevents applying a stale plan.

The minimal structure provides these roles:

- `Project.md` for identity, purpose, links, and boundaries
- `STATE.md` for bounded current context
- `Worklog/` for daily work notes
- `Decisions/Decisions.md` for durable decisions
- `Knowledge/Knowledge.md` for approved durable facts, tasks, summaries, and
  preferences
- `Plans/Plans.md` for project plans
- `Research/Research.md` for project research
- `References.md` for durable project links

Repair creates only missing roles. Existing files remain byte-for-byte
unchanged, role collisions and symlinks are rejected, and repository contents
are never copied into the vault. If a write fails, Ködade removes only the
artifacts created by that attempt.

A newly generated `Project.md` contains the portable marker:

```markdown
<!-- kodmem-project {"schema":1,"projectId":"<project-id>","authority":"projects-vault"} -->
```

For a newly scaffolded project with this valid matching marker, projects-vault
Markdown is the durable authority: checkpoints append exact structured entries
to daily `Worklog/YYYY/YYYY-MM-DD.md` notes, explicit state updates use a
content-hash compare-and-swap on `STATE.md`, and durable records use stable
machine markers in `Decisions/` or `Knowledge/`. SQLite remains a rebuildable,
workspace-local search projection. Human edits are refreshed before reads;
conflicting writes fail instead of overwriting them.

An existing `Project.md` is accepted for mapping when its `project_id` matches,
but Ködade does not inject the authority marker into an existing note. Projects
that contain legacy durable KödMem data remain blocked until the native setup
screen previews and applies a validated migration. The preview names the target
logical project, proposed Markdown operations, duplicates, and conflicts. Apply
creates a durable local recovery backup, writes bounded provenance-tagged notes,
rebuilds the SQLite projection, and commits the portable cutover receipt last.
Interrupted work can be retried or rolled back without overwriting later human
edits. Legacy `.kodade/memory` files and SQLite rows are retained as recovery
sources but are excluded from active context, search, lookup, and export after
cutover. Migration is intentionally unavailable through KödMCP.

Portable writes use stable idempotency markers, a machine-local project lock,
and a recoverable journal. Rebuild validates confined regular files, bounded
sizes, strict marker schemas, and secret exclusions before replacing the local
projection. Archived records retain their canonical provenance and can be
restored within the configured tombstone retention window.

After `Project.md` exists, **Open in Obsidian** uses the note's absolute path in
an `obsidian://` deep link. Obsidian can therefore select the correct registered
vault even when two vault folders share the same name.

### Agent onboarding

The Memory pane's **Connect agents** setup prepares Claude Code and Codex in one
reviewable transaction. It installs the versioned `kodmem-project` workflow for
the current project (or reuses an exact externally managed copy), adds bounded
managed blocks to `AGENTS.md` and `CLAUDE.md`, and registers the bundled KödMCP
helper in each agent's machine-local configuration. Existing unrelated config
entries and instruction text remain untouched.

The user chooses read-only or read-write access before reviewing the batch. An
apply is complete only after both agent CLIs discover the connection and a fresh
stdio session initializes, advertises the expected mode-specific tools, and
returns context for the selected logical workspace. Any apply or health failure
restores prior files in reverse order; removal reverses the same owned artifacts
without changing an externally managed skill.

Provider-facing context omits machine-local workspace, working-memory, and vault
paths. The project skill directs agents to refresh context, search before asking
for prior facts, keep durable memories concise, and use the current `STATE`
source hash as `expectedStateHash` for state-changing checkpoints.

The automated durability, recovery, concurrency, conflict, isolation, and
secret-residue proof is documented in the
[projects vault acceptance procedure](PROJECTS-VAULT-ACCEPTANCE.md). Packaging,
signing, installation, publication, and public-download verification remain
separate release stages.
