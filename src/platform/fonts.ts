import { detectMacPlatform } from "../shortcuts/bindings";

export function monoFontFamily(isMac = detectMacPlatform()): string {
  return isMac
    ? '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Monaco, monospace'
    : '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace';
}
