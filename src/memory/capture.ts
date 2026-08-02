import type { ActivityKind, MemoryWorkspace } from "../ipc/contract";
import { memory as tauriMemory } from "../ipc/transport";
import type { WorkspaceActivityFact } from "../activity/adapters";

type ProjectIdentity = {
  path: string;
};

type PersistedProjectIdentity = ProjectIdentity & {
  id: string;
};

type ActivityDetails = {
  sessionId?: string | null;
  relativePath?: string | null;
  provider?: string | null;
};

type TauriCloseEvent = {
  preventDefault(): void;
};

type TauriCloseWindow = {
  onCloseRequested(
    handler: (event: TauriCloseEvent) => void | Promise<void>,
  ): Promise<() => void>;
  destroy(): Promise<void>;
};

type CloseCaptureBridge = {
  closeActiveProject(project: PersistedProjectIdentity | null): Promise<void>;
};

const registrations = new Map<string, Promise<MemoryWorkspace | null>>();

export function rememberWorkspaceRegistration(
  workspace: MemoryWorkspace,
  previousRoot?: string,
): void {
  if (previousRoot) registrations.delete(previousRoot);
  registrations.set(workspace.canonicalRoot, Promise.resolve(workspace));
}

// Conservative default capture adapter. The type cannot carry terminal text,
// keystrokes, file bodies, environment, clipboard, or credentials.
export async function captureProjectActivity(
  project: ProjectIdentity,
  kind: ActivityKind,
  details: ActivityDetails = {},
): Promise<boolean> {
  let registration = registrations.get(project.path);
  if (!registration) {
    registration = tauriMemory.resolveWorkspace(project.path).then((workspace) => {
      if (!workspace) registrations.delete(project.path);
      return workspace;
    });
    registrations.set(project.path, registration);
  }
  try {
    const workspace = await registration;
    if (!workspace) return false;
    const recorded = await tauriMemory.recordActivity({
      workspaceId: workspace.id,
      kind,
      source: "kodade-ui",
      sessionId: details.sessionId ?? null,
      relativePath: details.relativePath ?? null,
      provider: details.provider ?? null,
      occurredAt: null,
    });
    return recorded !== null;
  } catch (error) {
    registrations.delete(project.path);
    console.error("kodade: local activity metadata capture failed", error);
    return false;
  }
}

// The sidebar projection still consumes the full foreground fact. This bridge
// separately persists only the low-sensitivity state transition and session ID.
export function createActivityPersistenceBridge(
  capture: typeof captureProjectActivity = captureProjectActivity,
) {
  let openedProjectId: string | null = null;
  let requestedProjectId: string | null = null;
  let activityTail: Promise<void> = Promise.resolve();

  const enqueueActivity = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = activityTail.then(operation, operation);
    activityTail = run.then(
      () => undefined,
      (error) => {
      console.error("kodade: local project lifecycle capture failed", error);
      },
    );
    return run;
  };
  const recordActivity = (
    project: PersistedProjectIdentity,
    kind: ActivityKind,
    details: ActivityDetails = {},
  ) => enqueueActivity(() => capture(project, kind, details));

  return {
    projectSelectionChanged(
      previous: PersistedProjectIdentity | null,
      current: PersistedProjectIdentity | null,
    ): Promise<void> {
      if (
        requestedProjectId === current?.id &&
        (!current || openedProjectId === current.id)
      ) {
        return activityTail;
      }
      requestedProjectId = current?.id ?? null;
      return enqueueActivity(async () => {
        if (previous && openedProjectId === previous.id) {
          if (await capture(previous, "projectClosed")) openedProjectId = null;
        }
        if (current && openedProjectId !== current.id) {
          if (await capture(current, "projectOpened")) openedProjectId = current.id;
        }
      });
    },

    ensureInitialProjectOpened(project: PersistedProjectIdentity): Promise<void> {
      if (requestedProjectId === project.id && openedProjectId === project.id) {
        return activityTail;
      }
      requestedProjectId = project.id;
      return enqueueActivity(async () => {
        if (openedProjectId === project.id) return;
        if (await capture(project, "projectOpened")) openedProjectId = project.id;
      });
    },

    closeActiveProject(project: PersistedProjectIdentity | null): Promise<void> {
      if (!project) return activityTail;
      requestedProjectId = null;
      return enqueueActivity(async () => {
        if (openedProjectId !== project.id) return;
        if (await capture(project, "projectClosed")) openedProjectId = null;
      });
    },

    recordActivity,

    async workspaceFact(
      project: PersistedProjectIdentity,
      fact: WorkspaceActivityFact,
    ): Promise<void> {
      if (fact.type !== "terminal-foreground") return;
      await recordActivity(project, fact.process ? "active" : "idle", {
        sessionId: fact.sessionId,
      });
    },
  };
}

// Minimal event-target seam shared by the window and document lifecycle hooks.
type LifecycleTarget = {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
};

// The browser has no cancellable close event. Web mode instead flushes the
// final low-sensitivity project-close record on the reliable lifecycle signals
// — visibilitychange→hidden and pagehide (the mobile-safe close proxies) — plus
// a periodic timer while hidden, as a safety net for browsers that throttle or
// drop those events. Backgrounding the tab therefore records a projectClosed;
// the daemon keeps the session alive regardless (daemon-outlives-clients).
export function installWebCloseCapture({
  activeProject,
  bridge,
  flushIntervalMs = 30_000,
  win = typeof window !== "undefined" ? window : undefined,
  doc = typeof document !== "undefined" ? document : undefined,
}: {
  activeProject(): PersistedProjectIdentity | null;
  bridge: CloseCaptureBridge;
  flushIntervalMs?: number;
  // Minimal structural seams so tests can inject a lifecycle double; the real
  // window/document satisfy them.
  win?: LifecycleTarget;
  doc?: LifecycleTarget & { visibilityState: DocumentVisibilityState };
}): () => void {
  let flushing = false;
  const flush = () => {
    if (flushing) return;
    flushing = true;
    Promise.resolve(bridge.closeActiveProject(activeProject()))
      .catch((error) =>
        console.error("kodade: final local activity capture failed", error),
      )
      .finally(() => {
        flushing = false;
      });
  };
  const onVisibility = () => {
    if (doc && doc.visibilityState === "hidden") flush();
  };
  const onPageHide = () => flush();

  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", onPageHide);
  // Only flush while hidden so a long working session is never false-closed.
  const timer = setInterval(() => {
    if (doc && doc.visibilityState === "hidden") flush();
  }, Math.max(0, flushIntervalMs));

  return () => {
    clearInterval(timer);
    doc?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pagehide", onPageHide);
  };
}

// Tauri gives close-request handlers a cancellable event. Capture the final
// low-sensitivity project-close record before destroying the window; a timeout
// keeps a broken local database from holding the desktop window indefinitely.
export async function installTauriCloseCapture({
  appWindow,
  activeProject,
  bridge,
  timeoutMs = 1_500,
}: {
  appWindow: TauriCloseWindow;
  activeProject(): PersistedProjectIdentity | null;
  bridge: CloseCaptureBridge;
  timeoutMs?: number;
}): Promise<() => void> {
  let closeStarted = false;
  return appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closeStarted) return;
    closeStarted = true;
    try {
      await Promise.race([
        bridge.closeActiveProject(activeProject()),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
      ]);
    } catch (error) {
      console.error("kodade: final local activity capture failed", error);
    } finally {
      try {
        // Tauri destroy force-closes without emitting another close request.
        // Window.close would recurse into this handler and can be serialized
        // behind the original native close request on Windows.
        await appWindow.destroy();
      } catch (error) {
        // The window is still alive, so let a later native close request retry
        // instead of permanently swallowing every subsequent close attempt.
        closeStarted = false;
        console.error("kodade: window destruction after activity capture failed", error);
      }
    }
  });
}
