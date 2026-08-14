import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { KodworkPresencePlatform } from "./presence";

export const tauriKodworkPresencePlatform: KodworkPresencePlatform = {
  isFocused: () => getCurrentWindow().isFocused(),
  async notify(input) {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    sendNotification({
      title: input.title,
      body: input.body,
      group: "kodwork",
      autoCancel: true,
      extra: { taskId: input.taskId },
    });
  },
  setBadgeCount: (count) => getCurrentWindow().setBadgeCount(count || undefined),
  async onNotificationClick(handler) {
    const listener = await onAction((notification) => {
      const taskId = notification.extra?.taskId;
      if (typeof taskId !== "string") return;
      const window = getCurrentWindow();
      void window.show().then(() => window.setFocus()).then(() => handler(taskId));
    });
    return () => listener.unregister();
  },
};
