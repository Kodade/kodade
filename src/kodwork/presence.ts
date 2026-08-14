import type { KodworkTask } from "./model";

export type KodworkPresencePlatform = {
  isFocused(): Promise<boolean>;
  notify(input: { taskId: string; title: string; body: string }): Promise<void>;
  setBadgeCount(count: number): Promise<void>;
  onNotificationClick(handler: (taskId: string) => void): Promise<() => void>;
};

export function createKodworkPresence({
  platform,
  enabled,
  openTask,
}: {
  platform: KodworkPresencePlatform;
  enabled(): boolean;
  openTask(taskId: string): void;
}) {
  let previous = new Map<string, string>();
  let observationChain = Promise.resolve();
  const observeNow = async (tasks: Record<string, KodworkTask>): Promise<void> => {
    if (!enabled()) return;
    const values = Object.values(tasks);
    await platform.setBadgeCount(values.filter((task) => task.state === "needs-user").length);
    const focused = await platform.isFocused();
    const next = new Map<string, string>();
    for (const task of values) {
      const marker = `${task.state}:${task.review.status}:${task.permissionRequest?.requestId ?? ""}`;
      next.set(task.id, marker);
      const before = previous.get(task.id);
      if (!before || before === marker || focused) continue;
      if (task.state === "needs-user") {
        await platform.notify({
          taskId: task.id,
          title: "KödWork needs you",
          body: task.permissionRequest?.title ?? "Review or respond to this task.",
        });
      } else if (
        task.state === "done" &&
        task.review.status !== "collecting" &&
        (task.review.status === "accepted" || task.review.files.length === 0)
      ) {
        await platform.notify({
          taskId: task.id,
          title: "KödWork task finished",
          body: task.title,
        });
      }
    }
    previous = next;
  };
  return {
    start: () => platform.onNotificationClick((taskId) => {
      if (enabled()) openTask(taskId);
    }),
    observe(tasks: Record<string, KodworkTask>): Promise<void> {
      observationChain = observationChain.then(
        () => observeNow(tasks),
        () => observeNow(tasks),
      );
      return observationChain;
    },
  };
}
