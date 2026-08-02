// Catalog of known gated feature flags. This is documentation + typo-safety for
// call sites — it does NOT gate anything on its own (entitlements come only from
// a signed token). KödWhisper Pro is the first consumer; other Pro surfaces
// (e.g. KödHarness) add their own flags here as they land.
import type { Feature } from "./types";

export const FEATURES = {
  voxCleanup: "vox.cleanup", // agent-aware prompt cleanup (filler strip, path/identifier fixes)
  voxVocabulary: "vox.vocabulary", // custom project vocabulary / hotword biasing
  voxCommands: "vox.commands", // voice commands ("terminal 2", "send", "new session")
  voxStreaming: "vox.streaming", // streaming partials + large/turbo models
  localAgent: "local.agent", // harness-assembled KödLocal agent loop
  localTools: "local.tools", // confined tool execution from the local agent loop
  localOrchestrate: "local.orchestrate", // MCP delegation into the bounded local agent loop
  localMultiBox: "local.multibox", // manually chosen saved LAN/remote KödLocal backend
  harnessPro: "harness.pro", // full KödHarness CLI matrix and KödSkills updates
  kodprBranch: "kodpr.branch", // KödPR branch review beyond the working tree
  kodprPr: "kodpr.pr", // KödPR GitHub pull-request workflow
  sshPro: "ssh.pro", // KödSSH remote projects, files, previews, multi-session
} as const satisfies Record<string, Feature>;

export type KnownFeature = (typeof FEATURES)[keyof typeof FEATURES];
