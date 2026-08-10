import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectScaffoldPlan } from "../../ipc/contract";
import {
  ProjectKnowledgeSetup,
  type ProjectKnowledgeIpc,
} from "./ProjectKnowledgeSetup";

const plan: ProjectScaffoldPlan = {
  workspaceId: "ws_portable",
  projectId: "portable-project",
  projectDisplayName: "Portable project",
  vaultRoot: "vault-root",
  fingerprint: "abc123",
  operations: [
    {
      kind: "createDirectory",
      relativePath: "10-Projects/portable-project/Worklog",
      content: null,
    },
    {
      kind: "createFile",
      relativePath: "10-Projects/portable-project/Project.md",
      content: "# Portable project\n",
    },
  ],
};

function projectKnowledgeIpc(
  overrides: Partial<ProjectKnowledgeIpc> = {},
): ProjectKnowledgeIpc {
  return {
    previewProjectScaffold: vi.fn().mockResolvedValue(plan),
    applyProjectScaffold: vi.fn().mockResolvedValue({
      projectId: plan.projectId,
      created: plan.operations,
    }),
    openProjectInObsidian: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("project knowledge setup", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  const render = async (element: React.ReactElement) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(element));
  };

  const button = (label: string) =>
    Array.from(container?.querySelectorAll("button") ?? []).find(
      (candidate) => candidate.textContent === label,
    );

  it("previews every operation before applying the exact plan and opening Obsidian", async () => {
    const ready = { ...plan, fingerprint: "ready", operations: [] };
    const ipc = projectKnowledgeIpc({
      previewProjectScaffold: vi
        .fn()
        .mockResolvedValueOnce(plan)
        .mockResolvedValueOnce(ready),
    });
    await render(<ProjectKnowledgeSetup workspaceId="ws_portable" ipc={ipc} />);

    await act(async () => button("Preview knowledge setup")?.click());

    expect(ipc.previewProjectScaffold).toHaveBeenCalledWith("ws_portable");
    expect(container?.textContent).toContain(
      "10-Projects/portable-project/Worklog",
    );
    expect(container?.textContent).toContain(
      "10-Projects/portable-project/Project.md",
    );
    expect(container?.textContent).toContain("# Portable project");
    const planDetails = container?.querySelector("details");
    expect(planDetails?.open).toBe(false);
    expect(planDetails?.querySelector("summary")?.textContent).toBe(
      "Plan details",
    );
    expect(button("Open in Obsidian")?.disabled).toBe(true);

    await act(async () => button("Create 2 missing items")?.click());

    expect(ipc.applyProjectScaffold).toHaveBeenCalledWith(
      "ws_portable",
      "abc123",
    );
    expect(container?.textContent).toContain(
      "Created 2 missing items. Existing notes were left unchanged.",
    );
    expect(container?.textContent).toContain("Project knowledge is ready.");
    expect(button("Open in Obsidian")?.disabled).toBe(false);

    await act(async () => button("Open in Obsidian")?.click());
    expect(ipc.openProjectInObsidian).toHaveBeenCalledWith("ws_portable");
  });

  it("keeps a stale-plan failure visible and offers a refresh", async () => {
    const ipc = projectKnowledgeIpc({
      applyProjectScaffold: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "project knowledge changed after preview; refresh the preview",
          ),
        ),
    });
    await render(<ProjectKnowledgeSetup workspaceId="ws_portable" ipc={ipc} />);
    await act(async () => button("Preview knowledge setup")?.click());
    await act(async () => button("Create 2 missing items")?.click());

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "project knowledge changed after preview",
    );
    expect(button("Refresh preview")).toBeDefined();
  });
});
