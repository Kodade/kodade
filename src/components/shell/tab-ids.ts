// DOM ids that tie the v2 shell's tab buttons (in the title bar) to their
// panels (in the shell body). They live in their own tiny module so the title
// bar can pair itself with the shell without importing the shell's component
// tree — the pills render in builds where ShellV2 is never mounted.

export function shellTabButtonId(tabId: string): string {
  return `shell-tab-${tabId}`;
}

export function shellTabPanelId(tabId: string): string {
  return `shell-panel-${tabId}`;
}
