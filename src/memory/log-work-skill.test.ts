import { describe, expect, it } from "vitest";
import { parseProjectSkillBundle } from "../harness/project-skills";
import { KODMEM_LOG_WORK_SKILL } from "./log-work-skill";

describe("bundled KödMem project skill", () => {
  it("is a portable project skill with the required memory workflow", () => {
    const skill = parseProjectSkillBundle(KODMEM_LOG_WORK_SKILL);
    const instructions = skill.files.find((file) => file.path === "SKILL.md")?.contents ?? "";

    expect(skill.id).toBe("kodmem-project");
    expect(instructions).toContain("get_context");
    expect(instructions).toContain("remember");
    expect(instructions).toContain("checkpoint");
    expect(instructions).toContain("expectedStateHash");
    expect(instructions).toContain("read-only");
    expect(instructions).not.toMatch(/\.kodade\/memory|bridgememory|projects\/worklog|WORKLOG\.md/i);
    expect(instructions).not.toMatch(/\/Users\/|[A-Z]:\\/);
  });
});
