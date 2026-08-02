import { describe, expect, it } from "vitest";
import { remoteTargetLabels } from "./labels";

describe("remoteTargetLabels", () => {
  it("uses the path basename as the primary label and the host as secondary text", () => {
    const target = {
      host: "studio",
      path: "~/code/projects/kodade",
    };

    expect(remoteTargetLabels([target]).get("studio\0~/code/projects/kodade")).toEqual({
      primary: "kodade",
      secondary: "studio",
      full: "studio:~/code/projects/kodade",
    });
  });

  it("adds parent segments when same-host targets share a basename", () => {
    const labels = remoteTargetLabels([
      { host: "studio", path: "/work/projects/kodade" },
      { host: "studio", path: "/work/clients/kodade" },
    ]);

    expect(labels.get("studio\0/work/projects/kodade")?.primary).toBe(
      "projects/kodade",
    );
    expect(labels.get("studio\0/work/clients/kodade")?.primary).toBe(
      "clients/kodade",
    );
  });

  it("keeps the basename when the host already disambiguates matching paths", () => {
    const labels = remoteTargetLabels([
      { host: "studio", path: "/work/kodade" },
      { host: "buildbox", path: "/work/kodade" },
    ]);

    expect(labels.get("studio\0/work/kodade")?.primary).toBe("kodade");
    expect(labels.get("buildbox\0/work/kodade")?.primary).toBe("kodade");
  });

  it("labels the remote home root as ~, including a trailing slash", () => {
    const labels = remoteTargetLabels([
      { host: "studio", path: "~" },
      { host: "buildbox", path: "~/" },
    ]);

    expect(labels.get("studio\0~")?.primary).toBe("~");
    expect(labels.get("buildbox\0~/")?.primary).toBe("~");
  });
});
