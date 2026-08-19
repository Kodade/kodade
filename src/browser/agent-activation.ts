import { nativeEquals, nativeRelativePath } from "../platform/native-path";
import { unavailableFeatureError } from "../release/guard";
import { developmentFeatureEnabled } from "../release/manifest";

export type BrowserAgentActivationEvent = {
  projectRoot: string;
  url: string | null;
};

type BrowserProject = {
  id: string;
  path: string;
};

export async function activateBrowserForAgent(
  event: BrowserAgentActivationEvent,
  deps: {
    projects: BrowserProject[];
    setActiveProject(id: string): Promise<void>;
    syncProjectFiles(path: string, id: string): Promise<void>;
    openBrowserTab(): void;
    setBrowserUrl(url: string): void;
  },
): Promise<boolean> {
  // Archived embedded browser (#62): fail closed with the same message the
  // other disabled development features use, rather than half-routing an
  // agent request to a pane that cannot render.
  if (!developmentFeatureEnabled("browser")) {
    throw unavailableFeatureError("browser");
  }
  const project = deps.projects
    .filter(
      (candidate) =>
        nativeEquals(candidate.path, event.projectRoot) ||
        nativeRelativePath(event.projectRoot, candidate.path) !== null,
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!project) return false;

  await deps.setActiveProject(project.id);
  await deps.syncProjectFiles(project.path, project.id);
  deps.openBrowserTab();
  if (event.url) deps.setBrowserUrl(event.url);
  return true;
}
