// The KödMem knowledge surface as each cohort sees it: local (the zero-setup
// default), vault (unchanged), and a workspace registered before local
// knowledge existed.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryWorkspace,
  ProjectsVault,
  WorkspaceKnowledgeSurface,
  WorkspaceProjectMapping,
} from "../../ipc/contract";
import {
  KnowledgeSurfacePanel,
  SWITCH_TO_VAULT_CONFIRM,
} from "./KnowledgeSurfacePanel";
import type { ProjectsVaultIpc } from "./ProjectsVaultSetup";

const workspace: MemoryWorkspace = {
  id: "ws_local",
  canonicalRoot: "/repo",
  displayName: "Checkout",
  color: null,
  capturePaused: false,
  activityRetentionDays: 30,
  auditRetentionDays: 30,
  tombstoneRetentionDays: 30,
  createdAt: 1,
  updatedAt: 1,
};

const mapping: WorkspaceProjectMapping = {
  workspaceId: workspace.id,
  projectId: "checkout",
  workspaceRoot: workspace.canonicalRoot,
  workspaceDisplayName: workspace.displayName,
  projectDisplayName: "Checkout",
  createdAt: 1,
  updatedAt: 1,
};

const localSurface: WorkspaceKnowledgeSurface = {
  workspaceId: workspace.id,
  mode: "local",
  projectId: "checkout",
  projectDisplayName: "Checkout",
  knowledgeRoot: "/repo/.kodade/knowledge",
  createdAt: 1,
  updatedAt: 1,
};

const vaultSurface: WorkspaceKnowledgeSurface = {
  ...localSurface,
  mode: "vault",
  knowledgeRoot: "/projects-vault/10-Projects/checkout",
};

const vault: ProjectsVault = {
  canonicalRoot: "/projects-vault",
  projects: [
    { id: "checkout", displayName: "Checkout", folderExists: true },
  ],
  createdAt: 1,
  updatedAt: 1,
};

function projectsVaultIpc(): ProjectsVaultIpc {
  return {
    projectsVault: vi.fn().mockResolvedValue(null),
    registerProjectsVault: vi.fn(),
    workspaceProjectMapping: vi.fn().mockResolvedValue(mapping),
    mapWorkspaceToProject: vi.fn(),
    projectWorkspaceMappings: vi.fn().mockResolvedValue([mapping]),
    previewProjectScaffold: vi.fn(),
    applyProjectScaffold: vi.fn(),
    previewLegacyMigration: vi.fn(),
    applyLegacyMigration: vi.fn(),
    rollbackLegacyMigration: vi.fn(),
    openProjectInObsidian: vi.fn(),
  };
}

describe("knowledge surface panel", () => {
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
    return container;
  };

  const button = (label: string) =>
    Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => candidate.textContent?.trim() === label,
    );

  it("states plainly where local project knowledge lives", async () => {
    await render(
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={localSurface}
        ipc={projectsVaultIpc()}
      />,
    );

    const panel = container?.querySelector('[data-knowledge-surface="local"]');
    expect(panel?.textContent).toContain(".kodade/knowledge");
    expect(panel?.textContent).toContain("git-ignored");
    expect(panel?.textContent).toContain("/repo/.kodade/knowledge");
    // Vault sync is an explicit, collapsed opt-in — and it never offers the
    // mapping form while local knowledge is active.
    const disclosure = panel?.querySelector("details");
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent).toBe(
      "Sync with an Obsidian projects vault",
    );
    expect(
      panel?.querySelector('[aria-label="Projects vault mapping"]'),
    ).toBeNull();
    expect(button("Set up project knowledge")).toBeUndefined();
  });

  it("renders a vault workspace exactly as its existing setup", async () => {
    await render(
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={vaultSurface}
        ipc={projectsVaultIpc()}
      />,
    );

    expect(
      container?.querySelector('[aria-label="Projects vault mapping"]'),
    ).not.toBeNull();
    // No local card, no "opt in to your own setup" disclosure.
    expect(container?.querySelector("[data-knowledge-surface]")).toBeNull();
    expect(container?.textContent).not.toContain(
      "Sync with an Obsidian projects vault",
    );
  });

  it("offers a one-click local setup to a workspace registered before it existed", async () => {
    const onSetUpLocal = vi.fn();
    await render(
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={null}
        onSetUpLocal={onSetUpLocal}
        ipc={projectsVaultIpc()}
      />,
    );

    const panel = container?.querySelector('[data-knowledge-surface="none"]');
    expect(panel?.textContent).toContain("no knowledge surface yet");
    const setUp = button("Set up project knowledge");
    expect(setUp).toBeDefined();
    await act(async () => setUp?.click());
    expect(onSetUpLocal).toHaveBeenCalledOnce();
    // The legacy cohort can still reach the vault mapping form, collapsed.
    expect(
      panel?.querySelector('[aria-label="Projects vault mapping"]'),
    ).not.toBeNull();
  });

  it("flips to the vault cohort as soon as a mapping is saved in the disclosure", async () => {
    // The bare cohort maps a vault from the collapsed disclosure; the owner
    // re-resolves on the callback, so the panel must not stay on the bare copy
    // and keep offering a setup action the model now refuses.
    const ipc = projectsVaultIpc();
    vi.mocked(ipc.projectsVault).mockResolvedValue(vault);
    vi.mocked(ipc.workspaceProjectMapping).mockResolvedValue(null);
    vi.mocked(ipc.mapWorkspaceToProject).mockResolvedValue(mapping);

    function Harness() {
      const [surface, setSurface] = useState<WorkspaceKnowledgeSurface | null>(
        null,
      );
      return (
        <KnowledgeSurfacePanel
          workspace={workspace}
          surface={surface}
          onSetUpLocal={vi.fn()}
          onMappingChanged={() => setSurface(vaultSurface)}
          ipc={ipc}
        />
      );
    }

    await render(<Harness />);
    expect(
      container?.querySelector('[data-knowledge-surface="none"]'),
    ).not.toBeNull();

    await act(async () => {
      button("Save project mapping")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ipc.mapWorkspaceToProject).toHaveBeenCalled();
    expect(container?.querySelector("[data-knowledge-surface]")).toBeNull();
    expect(
      container?.querySelector('[aria-label="Projects vault mapping"]'),
    ).not.toBeNull();
    expect(button("Set up project knowledge")).toBeUndefined();
  });

  it("shows a placeholder while the surface is still resolving", async () => {
    await render(
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={null}
        loading
        onSetUpLocal={vi.fn()}
        ipc={projectsVaultIpc()}
      />,
    );

    const panel = container?.querySelector('[data-knowledge-surface="loading"]');
    expect(panel?.textContent).toContain("Checking…");
    expect(container?.textContent).not.toContain("no knowledge surface yet");
    expect(button("Set up project knowledge")).toBeUndefined();
  });

  it("reports a failed surface resolve instead of offering a refusable setup", async () => {
    const onRetryResolve = vi.fn();
    await render(
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={null}
        resolveError="database is locked"
        onSetUpLocal={vi.fn()}
        onRetryResolve={onRetryResolve}
        ipc={projectsVaultIpc()}
      />,
    );

    const panel = container?.querySelector('[data-knowledge-surface="error"]');
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain(
      "database is locked",
    );
    expect(container?.textContent).not.toContain("no knowledge surface yet");
    expect(button("Set up project knowledge")).toBeUndefined();
    await act(async () => button("Retry")?.click());
    expect(onRetryResolve).toHaveBeenCalledOnce();
  });

  it("keeps a local surface visible when only its files failed to appear", async () => {
    const onSetUpLocal = vi.fn();
    await render(
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={localSurface}
        error="project knowledge path is inaccessible"
        onSetUpLocal={onSetUpLocal}
        ipc={projectsVaultIpc()}
      />,
    );

    const panel = container?.querySelector('[data-knowledge-surface="local"]');
    expect(panel?.textContent).toContain(".kodade/knowledge");
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain(
      "inaccessible",
    );
    expect(container?.textContent).not.toContain("no knowledge surface yet");
    await act(async () => button("Retry knowledge files")?.click());
    expect(onSetUpLocal).toHaveBeenCalledOnce();
  });

  it("surfaces a failed knowledge step and keeps the retry available", async () => {
    await render(
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={null}
        error="repo-local working memory is already active for this workspace"
        onSetUpLocal={vi.fn()}
        ipc={projectsVaultIpc()}
      />,
    );

    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("repo-local working memory");
    expect(button("Set up project knowledge")).toBeDefined();
  });

  it("switches local to vault only after a confirmation that names the files", async () => {
    const onSwitchToVault = vi.fn();
    const confirm = vi.fn().mockReturnValue(false);
    await render(
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={localSurface}
        onSwitchToVault={onSwitchToVault}
        confirm={confirm}
        ipc={projectsVaultIpc()}
      />,
    );

    const declined = button("Switch to vault sync…");
    await act(async () => declined?.click());
    expect(confirm).toHaveBeenCalledWith(SWITCH_TO_VAULT_CONFIRM);
    expect(onSwitchToVault).not.toHaveBeenCalled();

    expect(container?.querySelector("details")?.open).toBe(false);

    confirm.mockReturnValue(true);
    await act(async () => button("Switch to vault sync…")?.click());
    expect(onSwitchToVault).toHaveBeenCalledOnce();
    // The vault disclosure stays open so the mapping form is right there.
    expect(container?.querySelector("details")?.open).toBe(true);
  });

  it("says what the confirmation promises about files on disk", () => {
    expect(SWITCH_TO_VAULT_CONFIRM).toContain(
      "Files already in .kodade/knowledge are left on disk.",
    );
    expect(SWITCH_TO_VAULT_CONFIRM).toContain("Obsidian projects vault");
  });

  it("asks for KödMem before offering project knowledge", async () => {
    await render(
      <KnowledgeSurfacePanel
        workspace={null}
        surface={null}
        ipc={projectsVaultIpc()}
      />,
    );

    expect(container?.textContent).toContain("Enable KödMem for this project");
    expect(button("Set up project knowledge")).toBeUndefined();
  });
});
