// The v2 tabbed shell frame (issue #62).
//
// Sidebar on the left, a keep-alive tab host on the right. Code holds the
// chat/terminal split (CodeTab); Editor holds the editor beside the workspace
// files; Agents is still a placeholder. Tab content mounts once and is only
// ever hidden, so switching tabs never unmounts a live terminal or editor.
//
// This whole component is gated twice: the `shell` release feature must be
// compiled in AND the user must have switched the shell on.

import { useEffect, useRef } from "react";
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
import { WorkspaceFilesPane } from "../WorkspaceFilesPane";
import { appStore } from "../../store/appStore";
import { CodeTab } from "./CodeTab";
import { KeepAliveTabs, type KeepAliveTab } from "./KeepAliveTabs";
import { WorkspacesSidebar } from "./WorkspacesSidebar";
import { shellTabButtonId, shellTabPanelId } from "./tab-ids";

// Same separator styling as the v1 shell.
const SEP =
  "w-px cursor-col-resize bg-border transition-colors data-[active]:bg-accent hover:bg-accent";

export function ShellV2() {
  const shellLayout = useStore(appStore, (s) => s.shellLayout);
  const sidebarMode = useStore(appStore, (s) => s.sidebarMode);
  const filesCollapsed = useStore(appStore, (s) => s.filesCollapsed);
  const filesRef = usePanelRef();
  const editorGroupRef = useRef<GroupImperativeHandle | null>(null);

  // Editor geometry is read-only in this slice: the split renders at the saved
  // ratio, and writing it back lands with the Editor tab's own work.
  const filesPct = shellLayout.editor.filesPct;
  const editorLayout: Layout = {
    editor: round2(100 - filesPct),
    files: filesPct,
  };

  // Reapply the editor split when the files pane leaves its 44px rail — the
  // same hazard and the same next-frame reassert the v1 shell documents: the
  // rail's old fixed constraint is reconciled AFTER this parent effect, so the
  // first call is clamped and the pane can stay stranded at 44px.
  //
  // activeTab is a dependency because the Editor tab mounts LAZILY: booting on
  // another tab leaves editorGroupRef null, and without this the effect would
  // never run again to size the Group once Editor is first shown.
  useEffect(() => {
    editorGroupRef.current?.setLayout(editorLayout);
    if (filesCollapsed) return;
    const frame = requestAnimationFrame(() => {
      editorGroupRef.current?.setLayout(editorLayout);
      filesRef.current?.resize(`${filesPct}%`);
    });
    return () => cancelAnimationFrame(frame);
    // editorLayout is derived from filesPct alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesPct, filesCollapsed, shellLayout.activeTab]);

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
      render: (active) => <CodeTab active={active} />,
    },
    {
      id: "editor",
      render: () => (
        <Group
          groupRef={editorGroupRef}
          className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
          defaultLayout={editorLayout}
        >
          <Panel id="editor" minSize="20%" collapsible={false}>
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
  ];

  return (
    <div className="flex min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
      {/* The sidebar sits outside the tab host so its state and scroll position
          survive every tab switch. Rail mode keeps the same fixed 44px width
          the v1 shell gives it, and the same rail the v1 sidebar renders. */}
      <div
        className="flex h-full shrink-0 flex-col overflow-hidden border-r border-border"
        style={{
          width:
            sidebarMode === "rail" ? "44px" : `${shellLayout.sidebarPct}%`,
        }}
      >
        <WorkspacesSidebar />
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
