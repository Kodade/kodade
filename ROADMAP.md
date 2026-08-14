# Ködade roadmap

GitHub issues are the source of truth for implementation details and status.
This file states the public product boundary.

## Supported

- macOS Apple Silicon on macOS 13 or newer
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
- Embedded browser and GitHub desktop panes

## In development

- Windows packaging, signing, and platform QA
- KödLocal local-model workflows
- KödWhisper local voice workflows
- KödSSH and Remote projects
- KödWork background-agent workflows

Development features are compiled out of public release builds until they are
ready to support. Their presence in source is not a support promise.

## Not in the current product

Ködade is a native desktop application. A hosted browser application is not
part of this repository or the current product direction.
