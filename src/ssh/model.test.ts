// isRemoteSession (#121): the explicit marker is authoritative; the `ssh `
// name prefix remains the fallback for pre-marker sessions and docs.

import { describe, expect, it } from "vitest";
import {
  isRemoteSession,
  isRemoteSessionName,
  remoteProjectId,
  remoteTargetForProjectId,
  remoteSessionBase,
} from "./model";

describe("isRemoteSession", () => {
  it("trusts the explicit marker even after a manual rename", () => {
    expect(isRemoteSession({ name: "prod box", remote: true })).toBe(true);
  });

  it("falls back to the `ssh ` name prefix when no marker is present", () => {
    expect(isRemoteSession({ name: "ssh box 1" })).toBe(true);
    expect(isRemoteSession({ name: remoteSessionBase("box") })).toBe(true);
  });

  it("a plain local session is not remote", () => {
    expect(isRemoteSession({ name: "zsh 1" })).toBe(false);
    expect(isRemoteSession({ name: "claude 1", remote: false })).toBe(false);
    // "sshd 1" doesn't match the prefix (which includes the trailing space).
    expect(isRemoteSessionName("sshd 1")).toBe(false);
  });
});

describe("remote project identity", () => {
  const targets = [
    { host: "studio", path: "/srv/kodade" },
    { host: "studio", path: "/srv/other" },
  ];

  it("derives a stable, collision-safe project id from the target", () => {
    expect(remoteProjectId(targets[0])).toBe(
      "remote:studio:%2Fsrv%2Fkodade",
    );
    expect(remoteProjectId(targets[0])).not.toBe(remoteProjectId(targets[1]));
  });

  it("resolves only pinned remote projects", () => {
    const projectId = remoteProjectId(targets[1]);
    expect(remoteTargetForProjectId(targets, projectId)).toEqual(targets[1]);
    expect(remoteTargetForProjectId(targets, "remote:missing:%2Fsrv")).toBeNull();
  });
});
