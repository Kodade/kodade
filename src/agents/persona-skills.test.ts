// planPersonaSkills (#65): project a persona's stored KödSkills ids onto the
// inspected KödSkills model — what needs installing for this persona's provider,
// and what only deserves a non-blocking notice.

import { describe, expect, it } from "vitest";
import type { KodSkillsCellStatus, KodSkillsModel } from "../harness/kodskills";
import type { AgentPersona } from "./persona";
import { planPersonaSkills } from "./persona-skills";

function persona(skills: string[], providerId = "claude"): AgentPersona {
  return {
    id: "p1",
    name: "Reviewer",
    prompt: "review",
    providerId,
    skills,
    connections: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

// A model with one claude-owned target and per-skill cell statuses.
function model(
  statuses: Record<string, KodSkillsCellStatus>,
  targets = [{ id: "claude", cli: "claude", clis: ["claude"], path: "/home/.claude/skills" }],
): KodSkillsModel {
  const ids = Object.keys(statuses);
  return {
    pack: {
      id: "kodskills",
      name: "KödSkills",
      version: "1.0.0",
      description: "",
      source: "",
      tag: "",
      sha: "",
      skills: ids.map((id) => ({ id, dir: id, description: "", files: [] })),
    },
    targets,
    cells: targets.flatMap((target) =>
      ids.map((id) => ({
        skillId: id,
        targetId: target.id,
        targetPath: target.path,
        installedPath: `${target.path}/${id}`,
        status: statuses[id],
        eligible: statuses[id] === "ready",
        reason: "",
      })),
    ),
  } as KodSkillsModel;
}

describe("planPersonaSkills", () => {
  it("plans nothing for a persona with no skills", () => {
    expect(planPersonaSkills(persona([]), model({ "code-review": "ready" })))
      .toStrictEqual({ skillIds: [], targetIds: [], notice: null });
  });

  it("selects only the skills that are ready to install", () => {
    const plan = planPersonaSkills(
      persona(["code-review", "release-notes"]),
      model({ "code-review": "ready", "release-notes": "installed" }),
    );
    expect(plan.skillIds).toStrictEqual(["code-review"]);
    expect(plan.targetIds).toStrictEqual(["claude"]);
    expect(plan.notice).toBeNull();
  });

  it("plans nothing and stays quiet when every skill is already installed", () => {
    const plan = planPersonaSkills(
      persona(["code-review"]),
      model({ "code-review": "installed" }),
    );
    expect(plan.skillIds).toStrictEqual([]);
    expect(plan.notice).toBeNull();
  });

  it("matches a target the provider only consumes", () => {
    const plan = planPersonaSkills(
      persona(["code-review"], "codex"),
      model({ "code-review": "ready" }, [
        { id: "claude", cli: "claude", clis: ["claude", "codex"], path: "/home/.claude/skills" },
      ]),
    );
    expect(plan.skillIds).toStrictEqual(["code-review"]);
    expect(plan.targetIds).toStrictEqual(["claude"]);
  });

  it("notices a provider with no managed skills folder", () => {
    const plan = planPersonaSkills(persona(["code-review"], "grok"), model({ "code-review": "ready" }));
    expect(plan.skillIds).toStrictEqual([]);
    expect(plan.notice).toContain("no managed KödSkills folder");
    expect(plan.notice).toContain("still launches");
  });

  it("notices a model that could not be inspected", () => {
    const plan = planPersonaSkills(persona(["code-review"]), null);
    expect(plan.skillIds).toStrictEqual([]);
    expect(plan.notice).toContain("Couldn't check installed KödSkills");
  });

  it("notices skill ids that no longer resolve, and blocked cells", () => {
    const plan = planPersonaSkills(
      persona(["code-review", "gone", "tangled"]),
      model({ "code-review": "ready", tangled: "conflict" }),
    );
    expect(plan.skillIds).toStrictEqual(["code-review"]);
    expect(plan.notice).toContain("gone");
    expect(plan.notice).toContain("tangled");
    expect(plan.notice).toContain("still launches");
  });
});
