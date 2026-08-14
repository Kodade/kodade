import { describe, expect, it, vi } from "vitest";
import { newTask } from "./model";
import { createKodworkPresence, type KodworkPresencePlatform } from "./presence";

describe("KödWork presence", () => {
  it("notifies only on background transitions, badges needs-user, and routes clicks", async () => {
    let click: ((taskId: string) => void) | null = null;
    const platform: KodworkPresencePlatform = {
      isFocused: vi.fn().mockResolvedValue(false),
      notify: vi.fn().mockResolvedValue(undefined),
      setBadgeCount: vi.fn().mockResolvedValue(undefined),
      onNotificationClick: vi.fn(async (handler) => {
        click = handler;
        return () => {};
      }),
    };
    const openTask = vi.fn();
    const presence = createKodworkPresence({ platform, enabled: () => true, openTask });
    await presence.start();
    const draft = newTask("task-1", "project-1", "/repo", "claude", 1);
    await presence.observe({ "task-1": draft });
    expect(platform.notify).not.toHaveBeenCalled();

    const collecting = {
      ...draft,
      state: "done" as const,
      review: { ...draft.review, status: "collecting" as const },
    };
    await presence.observe({ "task-1": collecting });
    expect(platform.notify).not.toHaveBeenCalled();

    const needs = { ...draft, state: "needs-user" as const };
    await presence.observe({ "task-1": needs });
    expect(platform.notify).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", title: "KödWork needs you" }));
    expect(platform.setBadgeCount).toHaveBeenLastCalledWith(1);
    click!("task-1");
    expect(openTask).toHaveBeenCalledWith("task-1");

    const done = { ...needs, state: "done" as const, review: { ...needs.review, status: "accepted" as const } };
    await presence.observe({ "task-1": done });
    expect(platform.notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: "KödWork task finished" }));
    expect(platform.setBadgeCount).toHaveBeenLastCalledWith(0);
  });
});
