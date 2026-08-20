// Persona skills → KödSkills install plan (#65, Phase 5). A persona stores
// KödSkills ids; launching a run makes sure those skills actually exist in the
// managed skills folder the persona's provider reads.
//
// This module is pure: it projects the already-inspected KödSkills model (the
// same model the KödHarness picker renders) onto "what would this persona need
// installed". Nothing here writes — the caller stages the install through the
// existing prepareKodSkills → ChangeConfirmDialog review flow, so a CLI config
// or skills folder is still only ever touched by a confirmed change.

import type { KodSkillsModel } from "../harness/kodskills";
import type { AgentPersona } from "./persona";

export type PersonaSkillPlan = {
  // Skill ids that are eligible to install for this provider (status "ready").
  skillIds: string[];
  // Physical KödSkills target ids the provider reads from.
  targetIds: string[];
  // A non-blocking notice for the run UI, or null when nothing needs saying.
  // A notice never means "the run stopped" — it always launches.
  notice: string | null;
};

const EMPTY: PersonaSkillPlan = { skillIds: [], targetIds: [], notice: null };

// Statuses that mean the skill is present and usable: nothing to install.
// "update" counts as present — a persona run installs, it never upgrades a
// pack version behind the user's back.
const PRESENT = new Set(["installed", "update"]);

export function planPersonaSkills(
  persona: AgentPersona,
  model: KodSkillsModel | null,
  providerLabel: string = persona.providerId,
): PersonaSkillPlan {
  if (persona.skills.length === 0) return EMPTY;
  if (!model) {
    return {
      ...EMPTY,
      notice: `Couldn't check installed KödSkills, so this agent's skills weren't installed for ${providerLabel}. The run still launches.`,
    };
  }

  // A physical target serves the provider when that provider owns it or is one
  // of its consumers (several CLIs can read one skills folder).
  const targets = model.targets.filter(
    (target) => target.cli === persona.providerId || target.clis.includes(persona.providerId),
  );
  if (targets.length === 0) {
    return {
      ...EMPTY,
      notice: `${providerLabel} has no managed KödSkills folder, so this agent's skills weren't installed. The run still launches.`,
    };
  }

  const targetIds = new Set(targets.map((target) => target.id));
  const known = new Set(model.pack.skills.map((skill) => skill.id));
  const unknown = persona.skills.filter((id) => !known.has(id));

  const install: string[] = [];
  const blocked: string[] = [];
  for (const skillId of persona.skills) {
    if (!known.has(skillId)) continue;
    const cells = model.cells.filter(
      (cell) => cell.skillId === skillId && targetIds.has(cell.targetId),
    );
    if (cells.length === 0) continue;
    if (cells.some((cell) => cell.status === "ready")) {
      install.push(skillId);
      continue;
    }
    if (!cells.some((cell) => PRESENT.has(cell.status))) blocked.push(skillId);
  }

  const problems: string[] = [];
  if (unknown.length > 0) {
    problems.push(`${unknown.join(", ")} ${plural(unknown, "is", "are")} no longer in the KödSkills pack`);
  }
  if (blocked.length > 0) {
    problems.push(`${blocked.join(", ")} can't be installed automatically (conflicting or externally managed files)`);
  }

  return {
    skillIds: install,
    targetIds: [...targetIds],
    notice:
      problems.length === 0
        ? null
        // Skill ids are identifiers, so the sentence never starts with one.
        : `Some skills weren't installed: ${problems.join("; ")}. The run still launches.`,
  };
}

function plural(list: readonly unknown[], one: string, many: string): string {
  return list.length === 1 ? one : many;
}
