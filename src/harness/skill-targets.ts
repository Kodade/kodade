import { AVAILABLE_PROVIDERS } from "../providers/catalog";
import { resolveTemplate } from "./locations";
import type { HarnessScope, ScanContext } from "./model";

export type ManagedSkillTarget = {
  id: string;
  cli: string;
  clis: string[];
  path: string;
};

export function skillConsumers(
  scope: HarnessScope,
  path: string,
  ctx: ScanContext,
): string[] {
  const consumers: string[] = [];
  for (const provider of AVAILABLE_PROVIDERS) {
    const readsPath = (provider.harness?.skills?.[scope] ?? []).some(
      (template) => resolveTemplate(template, ctx) === path,
    );
    if (readsPath) consumers.push(provider.id);
  }
  return consumers;
}

// Resolve the preferred writable skill roots for selected provider owners.
// Consumers are derived separately because one physical root can serve several
// agents even though exactly one adapter owns its mutations.
export function resolveSkillInstallTargets(
  scope: HarnessScope,
  ctx: ScanContext,
  ownerIds: readonly string[],
): ManagedSkillTarget[] {
  const owners = new Set(ownerIds);
  const targets: ManagedSkillTarget[] = [];
  for (const provider of AVAILABLE_PROVIDERS) {
    if (!owners.has(provider.id)) continue;
    const template = provider.harness?.skills?.install?.[scope];
    if (!template) continue;
    const path = resolveTemplate(template, ctx);
    if (targets.some((target) => target.path === path)) continue;
    targets.push({
      id: template.segments.at(-2)?.replace(/^\./, "") || provider.id,
      cli: provider.id,
      clis: skillConsumers(scope, path, ctx),
      path,
    });
  }
  return targets;
}
