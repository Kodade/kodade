import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryWorkspace,
  ProjectsVault,
  WorkspaceProjectMapping,
} from "../../ipc/contract";
import {
  ProjectsVaultSetup,
  type ProjectsVaultIpc,
} from "./ProjectsVaultSetup";

const workspace: MemoryWorkspace = {
  id: "ws_portable",
  canonicalRoot: "/workspace",
  displayName: "Checkout",
  color: null,
  capturePaused: false,
  activityRetentionDays: 30,
  auditRetentionDays: 30,
  tombstoneRetentionDays: 30,
  createdAt: 1,
  updatedAt: 1,
};

const vault: ProjectsVault = {
  canonicalRoot: "/projects-vault",
  projects: [
    { id: "existing-project", displayName: "Existing project", folderExists: true },
  ],
  createdAt: 1,
  updatedAt: 1,
};

const mapping: WorkspaceProjectMapping = {
  workspaceId: workspace.id,
  projectId: "existing-project",
  workspaceRoot: workspace.canonicalRoot,
  workspaceDisplayName: workspace.displayName,
  projectDisplayName: "Existing project",
  createdAt: 1,
  updatedAt: 1,
};

function projectsVaultIpc(
  overrides: Partial<ProjectsVaultIpc> = {},
): ProjectsVaultIpc {
  return {
    projectsVault: vi.fn().mockResolvedValue(null),
    registerProjectsVault: vi.fn().mockResolvedValue(vault),
    workspaceProjectMapping: vi.fn().mockResolvedValue(null),
    mapWorkspaceToProject: vi.fn().mockResolvedValue(mapping),
    projectWorkspaceMappings: vi.fn().mockResolvedValue([mapping]),
    ...overrides,
  };
}

describe("projects vault setup", () => {
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("registers a selected Obsidian projects vault and creates a stable mapping", async () => {
    const ipc = projectsVaultIpc();
    const pickFolder = vi.fn().mockResolvedValue("/projects-vault");
    await render(
      <ProjectsVaultSetup workspace={workspace} ipc={ipc} pickFolder={pickFolder} />,
    );

    const choose = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Choose projects vault…",
    );
    await act(async () => choose?.click());

    expect(pickFolder).toHaveBeenCalledOnce();
    expect(ipc.registerProjectsVault).toHaveBeenCalledWith("/projects-vault");
    expect(container?.textContent).toContain("/projects-vault");

    const id = container?.querySelector<HTMLInputElement>(
      'input[aria-label="logical project ID"]',
    );
    const name = container?.querySelector<HTMLInputElement>(
      'input[aria-label="logical project name"]',
    );
    expect(id?.value).toBe("checkout");
    expect(name?.value).toBe("Checkout");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (id) {
        setValue?.call(id, "portable-project");
        id.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (name) {
        setValue?.call(name, "Portable project");
        name.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const save = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Save project mapping",
    );
    await act(async () => save?.click());

    expect(ipc.mapWorkspaceToProject).toHaveBeenCalledWith(
      workspace.id,
      null,
      "portable-project",
      "Portable project",
    );
  });

  it("shows a persisted mapping and the other workspaces using its project identity", async () => {
    const other = {
      ...mapping,
      workspaceId: "ws_other",
      workspaceRoot: "/other-workspace",
      workspaceDisplayName: "Other checkout",
    };
    const ipc = projectsVaultIpc({
      projectsVault: vi.fn().mockResolvedValue(vault),
      workspaceProjectMapping: vi.fn().mockResolvedValue(mapping),
      projectWorkspaceMappings: vi.fn().mockResolvedValue([mapping, other]),
    });

    await render(<ProjectsVaultSetup workspace={workspace} ipc={ipc} />);

    expect(container?.textContent).toContain("Mapped to existing-project");
    expect(container?.textContent).toContain("2 workspaces use this project identity");
    expect(
      container?.querySelector<HTMLInputElement>(
        'input[aria-label="logical project ID"]',
      )?.value,
    ).toBe("existing-project");
  });
});
