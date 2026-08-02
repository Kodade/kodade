// Renderer selection: try the WebGL addon (fast, the goal in WKWebView), and
// fall back to xterm's default canvas/DOM renderer if it fails to load or the
// GPU context is lost at runtime. This fallback keeps terminals usable when
// WKWebView cannot maintain a WebGL context.

import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

export type RendererKind = "webgl" | "fallback";

// Attach WebGL if we can; otherwise leave xterm on its built-in renderer.
// Returns which renderer ended up active so the UI can surface it if wanted.
export function attachRenderer(term: Terminal): RendererKind {
  try {
    const addon = new WebglAddon();
    // If the GPU context is lost later, drop WebGL and revert to the default
    // renderer so the terminal keeps working instead of going blank.
    addon.onContextLoss(() => {
      addon.dispose();
    });
    term.loadAddon(addon);
    return "webgl";
  } catch {
    // WebGL unavailable in this webview — xterm's default renderer stays active.
    return "fallback";
  }
}
