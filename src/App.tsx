import { useEffect, useRef } from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type Layout,
  type LayoutChangedMeta,
  usePanelRef,
} from "react-resizable-panels";
import { useStore } from "zustand";
import { EditorPane } from "./components/EditorPane";
import { ProjectsSidebar } from "./components/ProjectsSidebar";
import { ChatPane } from "./components/chat/ChatPane";
import { TitleBar } from "./components/TitleBar";
import { WorkspaceFilesPane } from "./components/WorkspaceFilesPane";
import {
  layoutToSizes,
  shouldPersistLayout,
  sizesToRestoredLayout,
  type PanelId,
} from "./components/layout";
import { SettingsPage } from "./components/settings/SettingsPage";
import { ShellV2 } from "./components/shell/ShellV2";
import { appStore, initApp, sshStore } from "./store/appStore";
import { settingsViewStore } from "./store/settingsView";
import { listenForSshFocusRefresh } from "./ssh/refresh";
import { RELEASE_MANIFEST } from "./release/manifest";

// Panels whose saved-zero width has to be restored. A rail (sidebar) or a
// collapsed files pane keeps its fixed width instead.
function expandedPanels(
  sidebarMode: "full" | "rail",
  filesCollapsed: boolean,
): PanelId[] {
  const expand: PanelId[] = [];
  if (sidebarMode === "full") expand.push("sidebar");
  if (!filesCollapsed) expand.push("files");
  return expand;
}

// Shared separator styling for the three pane boundaries.
const SEP =
  "w-px cursor-col-resize bg-border transition-colors data-[active]:bg-accent hover:bg-accent";

// Composes the four-pane workspace shell and bootstraps the app once.
export default function App() {
  // Hydrate persisted projects + register drag-and-drop (guarded internally
  // against StrictMode's double effect).
  useEffect(() => {
    void initApp();
  }, []);

  // ~/.ssh/config is user-owned and may change while Kodade is open. A single
  // app-level listener avoids duplicate scans because Settings overlays (and
  // does not unmount) the workspace/sidebar.
  useEffect(
    () =>
      RELEASE_MANIFEST.features.ssh
        ? listenForSshFocusRefresh(sshStore)
        : undefined,
    [],
  );

  const savedLayout = useStore(appStore, (s) => s.layout);
  const sidebarMode = useStore(appStore, (s) => s.sidebarMode);
  const filesCollapsed = useStore(appStore, (s) => s.filesCollapsed);
  const settingsOpen = useStore(settingsViewStore, (s) => s.section !== null);
  // The tabbed shell is the default since v2.0.0 (#65); the classic shell
  // below is the escape hatch, kept for one release. Switching DOES reparent
  // the terminal hosts (the registry re-adopts them into the new tree), which
  // is why this is a deliberate title-bar choice rather than something the app
  // does on its own — and why the tab host itself never unmounts a tab.
  const shellV2Enabled = useStore(appStore, (s) => s.shellV2Enabled);
  const shellV2 = RELEASE_MANIFEST.features.shell && shellV2Enabled;
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const sidebarRef = usePanelRef();
  const filesRef = usePanelRef();

  // Apply the app-level saved sizes imperatively after hydration and on
  // rail-mode changes (sidebar and files pane). In rail mode a panel's 44px
  // constraints win; the saved full layout is reapplied untouched when those
  // constraints lift. Deliberately NOT a keyed remount: the terminal hosts
  // live outside React in the session registry, and remounting the group
  // would reparent live xterm canvases mid-session (a WKWebView/WebGL hazard).
  //
  // `shellV2` is a dependency because this Group is UNMOUNTED while the tabbed
  // shell renders: coming back through the escape hatch mounts a fresh group,
  // and without this the user would land on factory pane widths and overwrite
  // their saved layout with the first drag. `defaultLayout` below carries the
  // same saved sizes so the mount itself is already correct.
  useEffect(() => {
    const target = sizesToRestoredLayout(
      savedLayout,
      expandedPanels(sidebarMode, filesCollapsed),
    );
    groupRef.current?.setLayout(target);

    // react-resizable-panels reconciles a rail's old fixed 44px constraint
    // after this parent effect. Reassert the full size on the next frame, once
    // the constraint is gone, or a saved/collapsed panel can remain at 0.
    if (sidebarMode !== "full" && filesCollapsed) return;
    const frame = requestAnimationFrame(() => {
      groupRef.current?.setLayout(target);
      if (sidebarMode === "full") sidebarRef.current?.resize(`${target.sidebar}%`);
      if (!filesCollapsed) filesRef.current?.resize(`${target.files}%`);
    });
    return () => cancelAnimationFrame(frame);
  }, [savedLayout, sidebarMode, filesCollapsed, shellV2]);

  // Persist only user-driven changes (drag/keyboard). Programmatic setLayout
  // (the effect above) and initial mount report isUserInteraction=false, so
  // restoring a layout never re-persists it.
  const onLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!shouldPersistLayout(meta.isUserInteraction, sidebarMode, filesCollapsed))
      return;
    appStore.getState().setLayout(layoutToSizes(layout));
  };

  return (
    <main className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col overflow-hidden bg-bg text-text">
      <TitleBar />
      {/* Settings covers the workspace rather than replacing it in the tree:
          terminal hosts live outside React in the session registry, so
          unmounting the group would detach live xterm canvases and lose the
          restored pane sizes and split layout. `inert` takes the covered
          workspace out of focus and the accessibility tree meanwhile. */}
      <div className="relative flex min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
        <div
          className="flex min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
          inert={settingsOpen}
        >
          {shellV2 ? (
            <ShellV2 />
          ) : (
          <Group
            groupRef={groupRef}
            className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
            // Mount with the user's saved sizes, not the factory ones: this
            // group remounts whenever the escape hatch flips.
            defaultLayout={sizesToRestoredLayout(
              savedLayout,
              expandedPanels(sidebarMode, filesCollapsed),
            )}
            onLayoutChanged={onLayoutChanged}
          >
            {/* Left/right visibility is controlled only by their buttons. Drag
                handles resize panes but cannot strand one at 0px. minSize must
                be a percentage STRING — bare numbers are pixels. */}
            <Panel
              panelRef={sidebarRef}
              id="sidebar"
              minSize={sidebarMode === "rail" ? 44 : "10%"}
              maxSize={sidebarMode === "rail" ? 44 : undefined}
              disabled={sidebarMode === "rail"}
              collapsible={false}
            >
              <ProjectsSidebar />
            </Panel>
            <Separator
              className={SEP}
              disabled={sidebarMode === "rail"}
              disableDoubleClick={sidebarMode === "rail"}
            />
            {/* KödChat is the primary agent surface (issue #163). The terminal
                is still here — a header toggle opens it as a split inside this
                pane, so the registry keeps owning its xterm hosts. The panel id
                stays "terminal" because persisted layouts are keyed by it. */}
            <Panel id="terminal" minSize="20%">
              <ChatPane />
            </Panel>
            <Separator className={SEP} />
            <Panel id="editor" minSize="12%" collapsible={false}>
              <EditorPane />
            </Panel>
            <Separator
              className={SEP}
              disabled={filesCollapsed}
              disableDoubleClick={filesCollapsed}
            />
            {/* Files mirrors the sidebar's rail treatment (issue #8): collapsed
                is a fixed 44px rail holding the re-open affordance, never 0. */}
            <Panel
              panelRef={filesRef}
              id="files"
              minSize={filesCollapsed ? 44 : "10%"}
              maxSize={filesCollapsed ? 44 : undefined}
              disabled={filesCollapsed}
              collapsible={false}
            >
              <WorkspaceFilesPane />
            </Panel>
          </Group>
          )}
        </div>
        {settingsOpen && <SettingsPage className="absolute inset-0 z-20" />}
      </div>
    </main>
  );
}
