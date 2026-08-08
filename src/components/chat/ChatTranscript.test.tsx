import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { parsePersistedThread, type ChatThread } from "../../chat/model";
import { ChatTranscript } from "./ChatTranscript";

function thread(entries: ChatThread["entries"]): ChatThread {
  return {
    id: "chat-1",
    projectId: "project-1",
    providerId: "codex",
    title: "Transcript",
    entries,
    resumeId: null,
    model: null,
    access: "standard",
    thinking: null,
    status: "idle",
    needsLogin: false,
    updatedAt: 0,
  };
}

async function flush() {
  await act(async () => await Promise.resolve());
}

describe("ChatTranscript", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function render(entries: ChatThread["entries"]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <ChatTranscript thread={thread(entries)} onOpenLink={() => {}} onOpenLoginTerminal={() => {}} />,
      ),
    );
    await flush();
    return container;
  }

  it("groups contiguous tool calls into a compact readable summary with bounded details", async () => {
    const host = await render([
      { kind: "tool", id: "1", call: { tool: "Read", args: { file_path: "src/a.ts" } }, outcome: { status: "executed", result: "source" } },
      { kind: "tool", id: "2", call: { tool: "shell", args: { command: "pnpm test" } }, outcome: { status: "executed", result: "passed" } },
      { kind: "tool", id: "3", call: { tool: "edit", args: { files: ["src/a.ts", "src/b.ts"] } }, outcome: null },
    ]);

    const summary = host.querySelector('[data-testid="chat-tool-activity"]')!;
    expect(summary.textContent).toContain("3 actions");
    expect(summary.textContent).toContain("Read src/a.ts");
    expect(summary.textContent).toContain("Ran pnpm test");
    expect(summary.textContent).toContain("Edited 2 files");
    expect(summary.textContent).toContain("working");
    expect(summary.textContent).not.toContain("file_path:");

    const details = summary.querySelector<HTMLButtonElement>('button[aria-label="Show tool details"]')!;
    act(() => details.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(summary.textContent).toContain("file_path: src/a.ts");
    expect(summary.textContent).toContain("source");
  });

  it("keeps failed and denied work visible without merging across message boundaries", async () => {
    const host = await render([
      { kind: "tool", id: "1", call: { tool: "search", args: { query: "adapter" } }, outcome: { status: "error", result: "offline" } },
      { kind: "tool", id: "2", call: { tool: "browser", args: { url: "https://kodade.com" } }, outcome: { status: "denied", result: "blocked" } },
      { kind: "message", id: "3", role: "assistant", text: "I need a different route." },
      { kind: "tool", id: "4", call: { tool: "Read", args: { file_path: "README.md" } }, outcome: { status: "executed", result: "ok" } },
    ]);

    const summaries = host.querySelectorAll('[data-testid="chat-tool-activity"]');
    expect(summaries).toHaveLength(2);
    expect(summaries[0].textContent).toContain("1 failed");
    expect(summaries[0].textContent).toContain("1 denied");
    expect(summaries[0].textContent).toContain("Searched adapter");
    expect(summaries[0].textContent).toContain("Opened kodade.com");
    expect(summaries[1].textContent).toContain("Read README.md");
  });

  it("decorates only GitHub issue and pull-request links in KödChat", async () => {
    const host = await render([
      {
        kind: "message",
        id: "1",
        role: "assistant",
        text: "[issue](https://github.com/Kodade/kodade/issues/25) [pr](https://github.com/Kodade/kodade/pull/26) [site](https://kodade.com) [relative](docs/readme.md)",
      },
    ]);

    expect(host.querySelectorAll("a.markdown-github-link")).toHaveLength(2);
    expect(host.querySelectorAll("a:not(.markdown-github-link)")).toHaveLength(2);
  });

  it("derives the same compact summary from a persisted transcript", async () => {
    const restored = parsePersistedThread(JSON.stringify({
      version: 1,
      id: "chat-1",
      projectId: "project-1",
      providerId: "codex",
      title: "Transcript",
      resumeId: null,
      model: null,
      access: "standard",
      thinking: null,
      updatedAt: 0,
      entries: [{ kind: "tool", id: "1", call: { tool: "Read", args: { file_path: "src/a.ts" } }, outcome: { status: "executed", result: "ok" } }],
    }))!;

    const host = await render(restored.entries);
    expect(host.querySelector('[data-testid="chat-tool-activity"]')?.textContent).toContain("Read src/a.ts");
  });
});
