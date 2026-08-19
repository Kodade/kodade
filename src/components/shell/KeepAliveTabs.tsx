// Keep-alive tab host for the v2 shell (issue #62).
//
// A tab's content mounts on its first activation and is NEVER unmounted while
// it stays in `tabs`; switching tabs only flips CSS visibility. Terminal panes
// host xterm canvases that live outside React in the session registry —
// unmounting OR reparenting them mid-session loses scrollback and risks a
// WKWebView/WebGL crash, so conditional rendering is not an option here.
//
// The invariant is stronger than "same wrapper element": a mounted wrapper also
// keeps its DOM position. Wrappers render in MOUNT order, never in the caller's
// `tabs` order, because reordering `tabs` would make React insertBefore-move a
// live wrapper — a detach/re-insert of the xterm subtree, exactly the hazard
// this component exists to prevent. New tabs always append at the end.
//
// Hiding uses inline `display: none` on a per-tab wrapper, matching what the
// session registry already does to background terminal hosts: the wrapper stays
// in normal flow and in the document, and the element identity of everything
// inside it is preserved. (`visibility: hidden` or off-screen positioning would
// keep xterm measuring a live box while it isn't on screen; display:none gives
// it a clean zero-size state that its fit addon re-measures on the way back.)
//
// Dependency-free and store-agnostic on purpose: callers own tab state.

import { useState, type ReactNode } from "react";

export interface KeepAliveTab {
  id: string;
  render: (active: boolean) => ReactNode;
}

export function KeepAliveTabs({
  tabs,
  activeId,
  className = "",
}: {
  tabs: KeepAliveTab[];
  activeId: string;
  className?: string;
}) {
  // Ids that have ever been active, in the order they first mounted. Lazy
  // mount: a tab nobody visited costs nothing. Ids are pruned when their tab
  // leaves `tabs`, so the list can't grow without bound and a reused id starts
  // fresh instead of resurrecting a stale mount.
  const [seenIds, setSeenIds] = useState<string[]>(() =>
    activeId ? [activeId] : [],
  );

  const tabIds = tabs.map((tab) => tab.id);
  const activeKnown = tabIds.includes(activeId);
  const needsAdd = activeKnown && !seenIds.includes(activeId);
  const needsPrune = seenIds.some((id) => !tabIds.includes(id));
  if (needsAdd || needsPrune) {
    // Render-phase update: React re-renders immediately with the new list
    // before committing, so a newly activated tab mounts in this same pass.
    setSeenIds((prev) => {
      const kept = prev.filter((id) => tabIds.includes(id));
      return activeKnown && !kept.includes(activeId)
        ? [...kept, activeId]
        : kept;
    });
  }

  // Mount order, not caller order — see the header note on DOM position.
  const mounted = seenIds
    .map((id) => tabs.find((tab) => tab.id === id))
    .filter((tab): tab is KeepAliveTab => Boolean(tab));

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {mounted.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            data-tab-id={tab.id}
            data-tab-active={String(active)}
            className="min-h-0 flex-1"
            style={active ? undefined : { display: "none" }}
          >
            {tab.render(active)}
          </div>
        );
      })}
    </div>
  );
}
