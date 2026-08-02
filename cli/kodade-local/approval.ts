import { escapeTerminalControls } from "../../src/local/tools";

/** Keep the trusted approval chrome distinct from an entirely untrusted preview. */
export function approvalBanner(preview: string): string {
  return `\n[tool approval]\n${escapeTerminalControls(preview)}\n`;
}
