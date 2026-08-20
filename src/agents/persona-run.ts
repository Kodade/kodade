// Map a persona onto the inputs a KödWork draft needs (#64, slice 2). The run
// engine is untouched: a persona only pre-fills a normal task draft, which then
// runs through the existing spawn path with all its scoped-permission behavior.
//
// A persona carries a "who and how" (prompt + provider); it deliberately does
// NOT carry an access level, so a launched run keeps whatever default the task
// model already gives a fresh draft. Skills and connections are not draft
// fields: they are made available to the run by installing them into the
// provider's own config/skills folder (see persona-skills.ts and
// connection-install.ts), not by widening the draft.

import type { AgentPersona } from "./persona";

// The subset of a draft a persona fills in. `outcome` is the draft's prompt
// field; `providerId` selects the CLI. Both go through the store's own
// setOutcome/setProvider so titling and resume-id invalidation stay consistent.
export type PersonaDraftInput = {
  outcome: string;
  providerId: string;
};

export function personaDraftInput(persona: AgentPersona): PersonaDraftInput {
  return { outcome: persona.prompt, providerId: persona.providerId };
}
