import { nativeEquals, nativeRelativePath } from "../platform/native-path";

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
