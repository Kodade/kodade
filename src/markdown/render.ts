import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { nativeBasename } from "../platform/native-path";

const markdown = new MarkdownIt("commonmark", {
  // Markdown is content, not an HTML escape hatch. Raw tags stay text.
  html: false,
  linkify: true,
}).enable(["table", "strikethrough"]);

// Images in project Markdown are untrusted network-capable content. Render a
// link chip instead of an <img> so merely opening a file never fetches a remote
// URL (including a service bound to localhost). The shared link-click path only
// opens absolute http/https URLs after an explicit click.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet("src") ?? "";
  const alt = token.content.trim() || imageName(src);
  const href = markdown.utils.escapeHtml(src);
  const label = markdown.utils.escapeHtml(alt);
  return `<a class="markdown-image-link" href="${href}">${label}</a>`;
};

function imageName(src: string): string {
  try {
    const path = new URL(src).pathname;
    return path.split("/").filter(Boolean).at(-1) || "image";
  } catch {
    const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
    return nativeBasename(withoutQuery) || "image";
  }
}

// markdown-it is the CommonMark/table renderer; DOMPurify is the final safety
// boundary before its output reaches React's HTML insertion point.
export function renderMarkdown(source: string): string {
  // Keep a stable block wrapper: browsers (and happy-dom in tests) otherwise
  // repair a top-level table by dropping its table element during sanitization.
  return DOMPurify.sanitize(`<div>${markdown.render(source)}</div>`, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script"],
  });
}
