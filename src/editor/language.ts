// Language detection by file extension for the read-only editor. Uses
// @codemirror/language-data's lazy `.load()` so only the grammars a user
// actually opens get pulled into memory (keeps the initial bundle sane).

import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import { nativeBasename } from "../platform/native-path";

// Extension -> language-data name. Covers the common languages the ticket lists.
// (language-data resolves its own aliases too, but an explicit map keeps the
// set we support obvious and predictable.)
const EXT_TO_LANG: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  jsx: "JSX",
  mjs: "JavaScript",
  cjs: "JavaScript",
  json: "JSON",
  rs: "Rust",
  py: "Python",
  css: "CSS",
  html: "HTML",
  htm: "HTML",
  md: "Markdown",
  markdown: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
};

function extensionOf(path: string): string {
  const base = nativeBasename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export type ViewerKind = "image" | "pdf";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

// Image and PDF files are rendered by native document viewers, never CodeMirror.
// Kept next to language routing so all extension decisions have one home.
export function viewerKind(path: string): ViewerKind | null {
  const ext = extensionOf(path);
  if (IMAGE_EXTS.has(ext)) return "image";
  return ext === "pdf" ? "pdf" : null;
}

// Load the CodeMirror language extension for a file path, or null if we have no
// grammar for it (the editor then shows plain text — still readable, no crash).
export async function loadLanguage(path: string): Promise<Extension | null> {
  const name = EXT_TO_LANG[extensionOf(path)];
  if (!name) return null;
  const desc = languages.find((l) => l.name === name);
  if (!desc) return null;
  try {
    const support = await desc.load();
    return support.extension;
  } catch {
    return null; // grammar failed to load: fall back to plain text
  }
}
