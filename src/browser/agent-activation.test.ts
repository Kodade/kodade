import { describe, expect, it, vi } from "vitest";
import { activateBrowserForAgent } from "./agent-activation";

describe("activateBrowserForAgent", () => {
  it("waits for the requesting project files before opening its browser tab", async () => {
    const order: string[] = [];
    const setActiveProject = vi.fn(async () => {
      order.push("project");
    });
    const syncProjectFiles = vi.fn(async () => {
      order.push("files");
    });
    const openBrowserTab = vi.fn(() => order.push("browser"));
    const setBrowserUrl = vi.fn(() => order.push("url"));

    await expect(
      activateBrowserForAgent(
        {
          projectRoot: "/work/app/packages/ui",
          url: "https://example.com/",
        },
        {
          projects: [
            { id: "other", path: "/work/other" },
            { id: "app", path: "/work/app" },
          ],
          setActiveProject,
          syncProjectFiles,
          openBrowserTab,
          setBrowserUrl,
        },
      ),
    ).resolves.toBe(true);

    expect(setActiveProject).toHaveBeenCalledWith("app");
    expect(syncProjectFiles).toHaveBeenCalledWith("/work/app", "app");
    expect(order).toEqual(["project", "files", "browser", "url"]);
  });

  it("does not redirect an unopened project into the active browser", async () => {
    const openBrowserTab = vi.fn();
    await expect(
      activateBrowserForAgent(
        { projectRoot: "/work/missing", url: null },
        {
          projects: [{ id: "app", path: "/work/app" }],
          setActiveProject: vi.fn(),
          syncProjectFiles: vi.fn(),
          openBrowserTab,
          setBrowserUrl: vi.fn(),
        },
      ),
    ).resolves.toBe(false);
    expect(openBrowserTab).not.toHaveBeenCalled();
  });
});
