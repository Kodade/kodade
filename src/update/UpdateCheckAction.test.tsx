// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UpdateCheckAction } from "./UpdateCheckAction";
import { UpdateNotice } from "./UpdateNotice";
import { updateStore } from "./updater";

it("keeps restart available and disables checking when an update is ready", async () => {
  const restart = vi.fn();
  const checkForUpdate = vi.fn();
  const original = updateStore.getState();
  updateStore.setState({ status: { phase: "ready", info: { version: "3.0", notes: null } }, restart, checkForUpdate });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<><UpdateCheckAction /><UpdateNotice /></>));
    const buttons = [...container.querySelectorAll("button")];
    const check = buttons.find((button) => button.textContent?.includes("check for updates"))!;
    expect(check.disabled).toBe(true);
    check.click();
    expect(checkForUpdate).not.toHaveBeenCalled();
    const restartButton = buttons.find((button) => button.textContent?.includes("restart to finish"))!;
    await act(async () => restartButton.click());
    expect(restart).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    updateStore.setState(original, true);
  }
});
