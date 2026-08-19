// The v2 tabbed shell frame (issue #62, slice a).
//
// Sidebar on the left, a keep-alive tab host on the right. The Code tab holds
// today's full workspace unchanged — the same Group, Panels, and panes the v1
// shell renders — so switching tabs never unmounts a live terminal or editor.
// Agents and Editor are placeholders in this slice: they make the switcher real
// while their content lands later.
//
// This whole component is gated twice: the `shell` release feature must be
// compiled in AND the user must have switched the shell on.

import { useEffect, useMemo, useRef } from "react";
import {
  Group,
  Panel,
  Separator,
  usePanelRef,
  type GroupImperativeHandle,
  type Layout,
} from "react-resizable-panels";
import { useStore } from "zustand";
import { EditorPane } from "../EditorPane";
import { Pane } from "../Pane";
import { ProjectsSidebar } from "../ProjectsSidebar";
import { WorkspaceFilesPane } from "../WorkspaceFilesPane";
import { ChatPane } from "../chat/ChatPane";
import { sizesToRestoredLayout, type PanelId } from "../layout";
import { appStore } from "../../store/appStore";
import { KeepAliveTabs, type KeepAliveTab } from "./KeepAliveTabs";
import { shellTabButtonId, shellTabPanelId } from "./tab-ids";

// Same separator styling as the v1 shell.
const SEP =
  "w-px cursor-col-resize bg-border transition-colors data-[active]:bg-accent hover:bg-accent";

// The panes the Code tab's Group owns. The sidebar is NOT one of them: in v2 it
// lives outside the tab host so it survives tab switches.
const CODE_PANEL_IDS: readonly PanelId[] = ["terminal", "editor", "files"];

export function ShellV2() {
  const shellLayout = useStore(appStore, (s) => s.shellLayout);
  const savedLayout = useStore(appStore, (s) => s.layout);
  const sidebarMode = useStore(appStore, (s) => s.sidebarMode);
  const filesCollapsed = useStore(appStore, (s) => s.filesCollapsed);
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const filesRef = usePanelRef();

  // v1 pane sizes, minus the sidebar, renormalized to the tab area. Read-only
  // in this slice: the v2 shell does not write back to the v1 array, so
  // switching the shell off restores exactly the sizes the user had. v2's own
  // persisted geometry (shellLayout.code / .editor) lands with the pane work.
  const codeLayout = useMemo(
    () => codeGroupLayout(savedLayout, filesCollapsed ? [] : ["files"]),
    [savedLayout, filesCollapsed],
  );

  // Reapply sizes when the files pane leaves its 44px rail — same hazard and
  // same next-frame reassert as the v1 shell (a rail's old fixed constraint is
  // reconciled after this parent effect, which can otherwise strand the pane).
  //
  // activeTab is a dependency because the Code tab mounts LAZILY: booting with
  // Agents or Editor active leaves groupRef null, and without this the effect
  // would never run again to size the Group once Code is first shown.
  useEffect(() => {
    groupRef.current?.setLayout(codeLayout);
    if (filesCollapsed) return;
    const frame = requestAnimationFrame(() => {
      groupRef.current?.setLayout(codeLayout);
      filesRef.current?.resize(`${codeLayout.files}%`);
    });
    return () => cancelAnimationFrame(frame);
  }, [codeLayout, filesCollapsed, shellLayout.activeTab]);

  // Tab SELECTION lives in the title bar (the pill group); this component only
  // renders whatever `shellLayout.activeTab` currently says.
  const tabs: KeepAliveTab[] = [
    {
      id: "agents",
      render: () => (
        <Placeholder
          title="agents"
          line="Agents arrive here in a later update."
        />
      ),
    },
    {
      id: "code",
      render: () => (
        <Group
          groupRef={groupRef}
          className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
          // The saved sizes, not the first-run defaults: a lazily mounted Code
          // tab must come up already correct, not resize on its first frame.
          defaultLayout={codeLayout}
        >
          {/* KödChat is the primary agent surface (issue #163); the terminal
              opens as a split inside this pane, so the session registry keeps
              owning its xterm hosts. The panel id stays "terminal" because
              persisted layouts are keyed by it. */}
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
          {/* Files keeps its rail treatment (issue #8): collapsed is a fixed
              44px rail holding the re-open affordance, never 0. */}
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
      ),
    },
    {
      id: "editor",
      render: () => (
        <Placeholder
          title="editor"
          line="The full-window editor arrives here in a later update."
        />
      ),
    },
  ];

  return (
    <div className="flex min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
      {/* The sidebar sits outside the tab host so its state and scroll position
          survive every tab switch. Rail mode keeps the same fixed 44px width
          the v1 shell gives it. */}
      <div
        className="flex h-full shrink-0 flex-col overflow-hidden border-r border-border"
        style={{
          width:
            sidebarMode === "rail" ? "44px" : `${shellLayout.sidebarPct}%`,
        }}
      >
        <ProjectsSidebar />
      </div>
      <KeepAliveTabs
        tabs={tabs}
        activeId={shellLayout.activeTab}
        className="min-w-0 max-w-full flex-1 overflow-hidden"
        panelId={shellTabPanelId}
        labelledBy={shellTabButtonId}
      />
    </div>
  );
}

// Placeholder tab body. Deliberately plain: it exists so the switcher is real.
function Placeholder({ title, line }: { title: string; line: string }) {
  return (
    <Pane title={title}>
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-text-dim">
        {line}
      </div>
    </Pane>
  );
}

// v1 geometry for the Code tab's Group. The sidebar's share is removed and the
// three remaining panes are renormalized to the tab area they now fill.
function codeGroupLayout(
  sizes: number[] | undefined,
  expandIds: readonly PanelId[],
): Layout {
  const full = sizesToRestoredLayout(sizes, expandIds);
  const total = CODE_PANEL_IDS.reduce((sum, id) => sum + full[id], 0);
  const layout: Layout = {};
  CODE_PANEL_IDS.forEach((id) => {
    layout[id] = total > 0 ? round2((full[id] / total) * 100) : 100 / 3;
  });
  return layout;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
