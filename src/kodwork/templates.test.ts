import { describe, expect, it } from "vitest";
import type { KodSkillsModel } from "../harness/kodskills";
import { newTask, projectedCadenceTokens } from "./model";
import { templatesFromKodSkills } from "./templates";

describe("KödWork templates", () => {
  it("offers only skills installed where the selected provider reads them", () => {
    const model = {
      pack: {
        skills: [
          { id: "review", description: "Review changes." },
          { id: "ship", description: "Ship changes." },
        ],
      },
      targets: [
        { id: "shared", clis: ["claude", "codex"] },
        { id: "grok", clis: ["grok"] },
      ],
      cells: [
        { skillId: "review", targetId: "shared", status: "installed" },
        { skillId: "ship", targetId: "grok", status: "installed" },
      ],
    } as unknown as KodSkillsModel;

    expect(templatesFromKodSkills(model, "codex").map((template) => template.id)).toEqual([
      "review",
    ]);
  });

  it("projects cadence cost from the source and its scheduled run history", () => {
    const source = {
      ...newTask("source", "p1", "/repo", "claude", 1),
      usage: { promptTokens: 40, completionTokens: 60, totalTokens: 100 },
    };
    const run = {
      ...newTask("run", "p1", "/repo", "claude", 2),
      scheduledFromTaskId: "source",
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
    };

    expect(projectedCadenceTokens(
      { source, run },
      "source",
      { kind: "daily", hour: 9, minute: 0, nextRunAt: 3 },
    )).toEqual({ averagePerRun: 200, runsPer30Days: 30, totalTokens: 6_000 });
  });
});
