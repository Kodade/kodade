import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import {
  appStore,
  filesStore,
  remoteFilesStore as defaultRemoteFilesStore,
} from "../store/appStore";
import type { ProjectsState } from "../store/projects";
import type { RemoteFilesState } from "../store/remoteFiles";
import { remoteTargetForProjectId } from "../ssh/model";
import {
  entitlements as defaultEntitlements,
  type Entitlements,
} from "../app/entitlements";
import { FileTreePane } from "./FileTreePane";
import { FilesPaneToggle } from "./FilesPaneToggle";
import { RemoteFilesPane } from "./RemoteFilesPane";
import { RELEASE_MANIFEST } from "../release/manifest";

// The far-right pane always owns file navigation. Local projects use the
// native file manager; pinned remote projects swap in their read-only SSH
// tree. Opening a remote file still previews it in the editor pane.
export function WorkspaceFilesPane({
  projectsStore = appStore,
  remoteFilesStore = defaultRemoteFilesStore,
  entitlements = defaultEntitlements,
  openRemotePreview = (host, path) =>
    filesStore.getState().openRemotePreviewTab(host, path),
}: {
  projectsStore?: StoreApi<ProjectsState>;
  remoteFilesStore?: StoreApi<RemoteFilesState>;
  entitlements?: Entitlements;
  openRemotePreview?: (host: string, path: string) => void;
} = {}) {
  const activeProjectId = useStore(
    projectsStore,
    (state) => state.activeProjectId,
  );
  const remoteTargets = useStore(
    projectsStore,
    (state) => state.remoteTargets,
  );
  const filesCollapsed = useStore(
    projectsStore,
    (state) => state.filesCollapsed,
  );
  const target = RELEASE_MANIFEST.features.ssh && activeProjectId
    ? remoteTargetForProjectId(remoteTargets, activeProjectId)
    : null;

  // Collapsed (issue #8): the pane is a fixed 44px rail — just the re-open
  // affordance at the top, mirroring the projects sidebar's rail mode.
  if (filesCollapsed) {
    return (
      <section
        aria-label="Files sidebar (collapsed)"
        className="flex h-full flex-col items-center bg-surface pt-1.5"
      >
        <FilesPaneToggle collapsed store={projectsStore} />
      </section>
    );
  }

  if (!target) return <FileTreePane />;
  return (
    <RemoteFilesPane
      host={target.host}
      path={target.path}
      store={remoteFilesStore}
      entitlements={entitlements}
      openPreview={openRemotePreview}
    />
  );
}
