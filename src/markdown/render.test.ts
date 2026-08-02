import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render";

describe("renderMarkdown", () => {
  it("renders CommonMark tables and strikethrough", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | ~~2~~ |");

    expect(html).toContain("<table>");
    expect(html).toContain("<s>2</s>");
  });

  it("never produces executable HTML from raw markdown HTML", () => {
    const html = renderMarkdown(
      '<script>window.pwned = true</script>\n<img src=x onerror="window.pwned = true">',
    );

    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<img\b[^>]*onerror/i);
  });

  it("renders remote images as a click-to-open chip without a fetch source", () => {
    const html = renderMarkdown("![tracking pixel](https://evil/px.gif)");

    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).toContain('class="markdown-image-link"');
    expect(html).toContain('href="https://evil/px.gif"');
    expect(html).toContain(">tracking pixel<");
  });
});
