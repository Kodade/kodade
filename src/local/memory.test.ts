import { describe, expect, it } from "vitest";
import {
  boundProviderMemory,
  formatProjectMemory,
  type ProjectMemoryContext,
} from "./memory";

function mappedContext(content: string): ProjectMemoryContext {
  return {
    workspace: { canonicalRoot: "/repo", displayName: "Kodade" },
    projectKnowledge: {
      projectId: "kodade",
      projectDisplayName: "Ködade",
      origin: "/projects-vault/10-Projects/kodade",
      sync: {
        status: "current",
        refreshedAt: 1,
        indexedDocuments: 4,
        indexHash: "f".repeat(64),
        truncated: false,
        error: null,
      },
      sources: [
        {
          kind: "state",
          relativePath: "STATE.md",
          title: "Current state",
          content,
          sha256: "a".repeat(64),
          modifiedAt: 1,
          truncated: false,
        },
      ],
    },
  };
}

describe("formatProjectMemory", () => {
  it("includes bounded mapped Markdown provenance without the local origin", () => {
    const formatted = formatProjectMemory(mappedContext("The mapped state is ready."));

    expect(formatted).toContain("Mapped project · Ködade (kodade)");
    expect(formatted).not.toContain("/projects-vault/10-Projects/kodade");
    expect(formatted).toContain("STATE.md · sha256:aaaaaaaaaaaa");
    expect(formatted).toContain("The mapped state is ready.");
  });

  it("uses one Unicode-character budget for every provider path", () => {
    const bounded = boundProviderMemory("🧠".repeat(20_000));

    expect(bounded).not.toBeNull();
    expect(Array.from(bounded ?? "")).toHaveLength(12_000);
    expect(bounded?.endsWith("…")).toBe(true);
  });

  it("keeps the complete agent context within the 12k boundary", () => {
    const formatted = formatProjectMemory(mappedContext("z".repeat(40_000)));

    expect(formatted.length).toBeLessThanOrEqual(12_000);
    expect(formatted.endsWith("…")).toBe(true);
  });

  it("surfaces mapped sync failures without inventing source content", () => {
    const context = mappedContext("must not appear");
    context.projectKnowledge = {
      ...context.projectKnowledge!,
      sync: {
        ...context.projectKnowledge!.sync,
        status: "error",
        error: "STATE.md is missing. Repair the mapped project folder and retry.",
      },
      sources: [],
    };

    const formatted = formatProjectMemory(context);
    expect(formatted).toContain("Mapped project sync error");
    expect(formatted).toContain("Repair the mapped project in the local Memory pane");
    expect(formatted).not.toContain("STATE.md is missing");
    expect(formatted).not.toContain("/projects-vault/10-Projects/kodade");
    expect(formatted).not.toContain("must not appear");
  });
});
