# Ködade documentation

This directory contains public contributor and release documentation only.
Research, internal design notes, planning records, monetization work, and
release evidence are maintained outside the public repository.

- [Roadmap](../ROADMAP.md)
- [Projects vault workflow](#projects-vault-workflow) — in development
- [macOS release process](RELEASING.md)
- [Windows build and status](WINDOWS.md)
- [Windows CI](WINDOWS-CI.md)

## Projects vault workflow

> **Development status:** Projects-vault-backed KödMem is in development. It
> is not part of the current supported public release.

Ködade can register an Obsidian projects vault, map a workspace to a portable
project identity, and preview the minimal knowledge structure for that project.
The preview lists every missing folder and file, shows generated file content,
and carries a fingerprint that prevents applying a stale plan.

The minimal structure provides these roles:

- `Project.md` for identity, purpose, links, and boundaries
- `STATE.md` for bounded current context
- `Worklog/` for daily work notes
- `Decisions/Decisions.md` for durable decisions
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

An existing `Project.md` is accepted when its `project_id` matches the mapped
project. Ködade does not inject the marker into an existing note. Scaffolding
does not switch active KödMem storage authority; legacy migration and cutover
remain a separate, explicitly validated workflow.

After `Project.md` exists, **Open in Obsidian** uses the note's absolute path in
an `obsidian://` deep link. Obsidian can therefore select the correct registered
vault even when two vault folders share the same name.
