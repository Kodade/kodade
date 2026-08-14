import type { KodSkillsModel } from "../harness/kodskills";

export type KodworkTemplate = {
  id: string;
  name: string;
  description: string;
};

const INSTALLED_STATUSES = new Set(["installed", "update", "modified", "external"]);

// A template is only offered when the selected provider can see an installed
// copy of that skill. The pack is already hash-verified by KödHarness.
export function templatesFromKodSkills(
  model: KodSkillsModel,
  providerId: string,
): KodworkTemplate[] {
  return model.pack.skills
    .filter((skill) =>
      model.cells.some((cell) => {
        if (cell.skillId !== skill.id || !INSTALLED_STATUSES.has(cell.status)) return false;
        const target = model.targets.find((candidate) => candidate.id === cell.targetId);
        return target?.clis.includes(providerId) ?? false;
      }),
    )
    .map((skill) => ({
      id: skill.id,
      name: skill.id,
      description: skill.description,
    }));
}

export function templatePrompt(template: KodworkTemplate, folder: string): string {
  return `Run the \`${template.id}\` skill against \`${folder}\`.\n\nOutcome:\n`;
}
