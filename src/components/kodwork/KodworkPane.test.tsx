import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTask } from "../../kodwork/model";
import type { KodworkState } from "../../kodwork/store";
import { KodworkPane } from "./KodworkPane";

function progressStore() {
  const task = {
    ...newTask("task-1", "project-1", "/repo", "claude", 1),
    outcome: "Prepare the release report",
    title: "Prepare release report",
    state: "done" as const,
    plan: [{ text: "Draft report", status: "completed" as const }],
    tools: [{ id: "tool-1", tool: "Write", detail: "/repo/report.md", ok: true }],
    summary: "Created report.md",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  };
  return createStore(() => ({
    tasks: { [task.id]: task },
    loaded: { [task.id]: true },
    start: vi.fn(),
    openTask: vi.fn(),
    setOutcome: vi.fn(),
    setFolder: vi.fn(),
    setProvider: vi.fn(),
    setAccess: vi.fn(),
    startTask: vi.fn(),
    resumeTask: vi.fn(),
    cancelTask: vi.fn(),
    removeTask: vi.fn(),
    flush: vi.fn(),
  })) as unknown as StoreApi<KodworkState>;
}

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});

describe("KodworkPane", () => {
  it("renders task progress, files, summary, and token usage without a chat transcript", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() => mounted?.render(<KodworkPane taskId="task-1" workStore={progressStore()} />));

    expect(host.textContent).toContain("Prepare release report");
    expect(host.textContent).toContain("Draft report");
    expect(host.textContent).toContain("/repo/report.md");
    expect(host.textContent).toContain("Created report.md");
    expect(host.textContent).toContain("30 total");
    expect(host.textContent).not.toContain("You said");
  });

  it("shows an honest missing-task state for a stale tab", () => {
    const store = createStore(() => ({ tasks: {} })) as unknown as StoreApi<KodworkState>;
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() => mounted?.render(<KodworkPane taskId="gone" workStore={store} />));
    expect(host.textContent).toContain("no longer open");
  });
});
