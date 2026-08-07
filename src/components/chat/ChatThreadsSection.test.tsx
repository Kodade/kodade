// Sidebar thread-row label rules (issue #6): an empty thread reads "New chat"
// — never the provider-numbered session name — the loaded title takes over
// once the thread has messages, and a locked (renamed) session name always
// wins.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { newThread, type ChatThread } from "../../chat/model";
import type { SessionMeta } from "../../store/projects";
import { ChatThreadRow } from "./ChatThreadsSection";

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id: "t1", projectId: "p1", kind: "chat", name: "claude 1", ...overrides };
}

let mounted: Root | null = null;
afterEach(() => {
  const root = mounted;
  mounted = null;
  if (root) act(() => root.unmount());
  document.body.innerHTML = "";
});

function renderRow(meta: SessionMeta, thread: ChatThread | undefined): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ul>
        <ChatThreadRow
          session={meta}
          thread={thread}
          selected={false}
          onActivate={() => undefined}
          onClose={() => undefined}
        />
      </ul>,
    );
  });
  mounted = root;
  return host;
}

describe("ChatThreadRow label", () => {
  it("shows New chat for a brand-new empty thread, not the session name", () => {
    const host = renderRow(session(), newThread("t1", "p1", "claude", 0));
    expect(host.textContent).toContain("New chat");
    expect(host.textContent).not.toContain("claude 1");
  });

  it("shows New chat before an unrenamed thread's transcript loads", () => {
    const host = renderRow(session(), undefined);
    expect(host.textContent).toContain("New chat");
    expect(host.textContent).not.toContain("claude 1");
  });

  it("shows the thread title once it has messages", () => {
    const thread = {
      ...newThread("t1", "p1", "claude", 0),
      title: "login form validation",
      entries: [{ kind: "message", id: "m1", role: "user", text: "hi" } as const],
    };
    const host = renderRow(session(), thread);
    expect(host.textContent).toContain("login form validation");
  });

  it("a locked (renamed) session name always wins", () => {
    const thread = {
      ...newThread("t1", "p1", "claude", 0),
      title: "login form validation",
      entries: [{ kind: "message", id: "m1", role: "user", text: "hi" } as const],
    };
    const host = renderRow(
      session({ name: "My thread", nameLocked: true }),
      thread,
    );
    expect(host.textContent).toContain("My thread");
    expect(host.textContent).not.toContain("login form validation");
  });
});
