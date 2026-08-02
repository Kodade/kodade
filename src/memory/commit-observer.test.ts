import { describe, expect, it } from "vitest";
import {
  isGitCheckpointEventPath,
  rootsWithGitCheckpointEvents,
} from "./commit-observer";

describe("working-memory commit observer", () => {
  it("accepts only Git metadata that can move HEAD", () => {
    expect(isGitCheckpointEventPath("/repo/.git/HEAD", "/repo")).toBe(true);
    expect(isGitCheckpointEventPath("/repo/.git/refs/heads/main", "/repo")).toBe(true);
    expect(isGitCheckpointEventPath("/repo/.git/packed-refs", "/repo")).toBe(true);
    expect(isGitCheckpointEventPath("/repo/.git/config", "/repo")).toBe(false);
    expect(isGitCheckpointEventPath("/other/.git/HEAD", "/repo")).toBe(false);
  });

  it("returns each affected project root once", () => {
    expect(
      rootsWithGitCheckpointEvents(
        ["/one/.git/HEAD", "/one/.git/refs/heads/main", "/two/src/a.ts"],
        ["/one", "/two"],
      ),
    ).toEqual(["/one"]);
  });
});
