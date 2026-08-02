import { describe, expect, it } from "vitest";
import { skillCanonicalGroupId } from "./skill-identity";

describe("skillCanonicalGroupId", () => {
  it("identifies copies from the same KödSkills provenance", () => {
    const marker = JSON.stringify({
      schemaVersion: 1,
      pack: "kodskills-engineering",
      packVersion: "1.0.0",
      skillId: "code-review",
      files: [
        { path: "scripts/review.ts", sha256: "bbb" },
        { path: "SKILL.md", sha256: "aaa" },
      ],
    });

    expect(skillCanonicalGroupId(".kodskills.json", marker)).toBe(
      "kodskills:kodskills-engineering:code-review:SKILL.md=aaa|scripts/review.ts=bbb",
    );
  });

  it("identifies project copies from the same imported source hash", () => {
    const marker = JSON.stringify({
      schemaVersion: 1,
      managedBy: "kodade",
      skillId: "code-review",
      sourceHash: "abc123",
      files: [{ path: "SKILL.md", sha256: "aaa" }],
    });

    expect(skillCanonicalGroupId(".kodade-skill.json", marker)).toBe(
      "project-skill:code-review:abc123",
    );
  });

  it("does not merge malformed or unknown marker content", () => {
    expect(skillCanonicalGroupId(".kodskills.json", "{")).toBeNull();
    expect(skillCanonicalGroupId("other.json", "{}")).toBeNull();
    expect(
      skillCanonicalGroupId(
        ".kodade-skill.json",
        JSON.stringify({ schemaVersion: 1, managedBy: "someone-else" }),
      ),
    ).toBeNull();
  });
});
