// The v1 sidebar: KödChat's project/thread tree, KödWork's task inbox, the
// remote project tree, and Settings in the footer.
//
// The frame (Pane, collapse toggle, compact rail, color menu, store-backed
// actions) now lives in sidebar/chrome.tsx and the full-mode projection lives
// in workspace/projection.tsx — both extracted from this file in issue #62 and
// re-exported below so existing importers and tests are unaffected.

import { SettingsEntry } from "./settings/SettingsEntry";
import { ChatThreadsSection } from "./chat/ChatThreadsSection";
import { KodworkSection } from "./kodwork/KodworkSection";
import { RELEASE_MANIFEST } from "../release/manifest";
import { SidebarChrome, SidebarRemoteSection } from "./sidebar/chrome";
import { FullWorkspaceSidebar } from "./workspace/projection";

export {
  FullWorkspaceProjection,
  FullWorkspaceSidebar,
  projectWorkspaceView,
} from "./workspace/projection";
export { ProjectRail } from "./ProjectRail";

export function ProjectsSidebar() {
  return (
    <SidebarChrome
      renderFull={({ projects, appearance, activeProjectId, actions }) => (
        <FullWorkspaceSidebar
          view={{ reducedMotion: false, groups: [] }}
          projects={projects}
          appearance={appearance}
          activeProjectId={activeProjectId}
          actions={actions}
          showTerminalShelf={false}
          // KödChat is the sidebar's primary local project list; KödWork's
          // task inbox renders beneath it (dev builds only).
          lead={<ChatThreadsSection />}
          supplemental={
            <>
              {RELEASE_MANIFEST.features.work && <KodworkSection />}
              {RELEASE_MANIFEST.features.ssh ? <SidebarRemoteSection /> : null}
            </>
          }
          // Settings lives at the bottom-left of the sidebar, not the title bar.
          footer={<SettingsEntry />}
        />
      )}
    />
  );
}
