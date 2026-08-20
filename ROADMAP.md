# Ködade roadmap

GitHub issues are the source of truth for implementation details and status.
This file states the public product boundary.

## Supported

- macOS Apple Silicon on macOS 13 or newer
- The tabbed workspace shell — Agents, Code, and Editor tabs with a persistent
  workspace sidebar; tabs keep running in the background. The classic 1.x
  layout remains available as an escape hatch for one release.
- Agent personas and runs in the Agents tab, prepared onto KödWork, with
  MCP Connections from a curated catalog or custom entries installed into the
  CLI's own config through reviewed changes — strictly bring-your-own-key
- KödChat with Claude Code, Codex, Grok Build, and OpenCode through their
  official CLIs. OpenCode models are discovered per local project from the
  installed CLI, with Default retained and no bundled model catalog.
- Ollama local HTTP chat at `127.0.0.1:11434`, with dynamic local-model picks,
  streamed reasoning/responses, stop, and persisted client-side conversation
  history bounded to the active provider/model. Ollama chat has no filesystem
  or tool access.
- Native terminals, projects, files, and editor
- KödMem, KödMCP, KödHarness, and KödSkills, including projects-vault-backed
  durable memory, portable logical project identity, and agent onboarding
- KödWork background tasks with durable progress, scoped permissions,
  reviewable file output, native attention, skill templates, and recurrence
- GitHub desktop pane

## In development

- Windows packaging, signing, and platform QA
- KödLocal local-model workflows
- KödWhisper local voice workflows
- KödSSH and Remote projects
- The embedded KödBrowser pane and its agent tools, archived: compiled out of
  public release builds while the surface is reworked, and kept in source so it
  can be revived

Development features are compiled out of public release builds until they are
ready to support. Their presence in source is not a support promise.

## Not in the current product

Ködade is a native desktop application. A hosted browser application is not
part of this repository or the current product direction.
