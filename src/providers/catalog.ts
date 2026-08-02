// The provider registry: the agent CLIs kodade knows how to detect and launch.
// This is product data, so it lives in TypeScript (Rust stays thin). Adding a
// provider is a one-line edit here — detection and launch are generic.

import type { HarnessLocations } from "../harness/locations";
import {
  RELEASE_MANIFEST,
  type ReleaseManifest,
} from "../release/manifest";

// KödChat's headless-run recipe for a CLI: how to make it emit a structured
// stream instead of a terminal UI. Its presence IS the "works in KödChat"
// capability flag — a provider without one is launchable in a terminal but has
// no chat adapter yet, and the pane says so.
//
// `{session}` and `{model}` are substituted at spawn time. The prompt is NEVER
// an argument: it goes to the process's stdin, which Rust then closes.
//
// Permission posture: chosen PER THREAD by the user (composer select), never
// silently. Headless `-p` runs cannot answer a permission prompt, so any tool
// the posture doesn't pre-approve is auto-denied — the original single
// "acceptEdits" posture made every Bash call and out-of-project Read fail.
// Each level maps to the CLI's own real flags in `accessArgs`.
export type ChatAccessLevel = "plan" | "standard" | "full";

export type ProviderStream = {
  // Which parser in src/agents/ reads this CLI's output.
  dialect: "claude" | "codex";
  // Base argv for a fresh turn.
  args: readonly string[];
  // Per-access-level argv, appended right after `args`.
  accessArgs: Record<ChatAccessLevel, readonly string[]>;
  // Appended to resume a prior thread. Order matters for subcommand CLIs:
  // these land AFTER the base and model args (see engine.buildAgentArgs).
  resumeArgs?: readonly string[];
  // Appended when the user picked a model.
  modelArgs?: readonly string[];
  // Models the composer offers. Omit when the CLI's current model names
  // aren't verified — the picker then shows only "Default".
  models?: readonly { id: string; label: string }[];
};

export const DEFAULT_ACCESS_LEVEL: ChatAccessLevel = "standard";

// Composer labels for the access select, in display order.
export const ACCESS_LEVELS: readonly {
  id: ChatAccessLevel;
  label: string;
  description: string;
}[] = [
  {
    id: "plan",
    label: "Plan only",
    description: "Read the project and propose changes — touches nothing.",
  },
  {
    id: "standard",
    label: "Standard",
    description: "Read files, edit the project, and run commands.",
  },
  {
    id: "full",
    label: "Full access",
    description: "Skip all permission prompts. The agent acts without asking.",
  },
];

export type Provider = {
  id: string; // stable key, also the session base name ("claude 1")
  name: string; // display label on the chip
  bin: string; // executable probed with `<bin> --version` and launched
  launch: string; // command typed into the terminal to start it
  install: string; // where to get it, shown when it's missing
  // KödChat (issue #163): omit for a CLI with no structured headless mode.
  stream?: ProviderStream;
  // KödHarness (M10): where this CLI keeps its instruction files, skills,
  // subagents, and MCP registrations. Optional — a CLI kodade can launch but
  // doesn't yet inspect simply omits it. Stored as separator-free templates
  // (see harness/locations.ts) resolved at scan time.
  harness?: HarnessLocations;
  // KödSSH executes in the remote host shell rather than the desktop bundle.
  // Most CLIs use the same PATH binary, while bundled KödLocal must be
  // installed on the remote host as `kodade-local` to launch there.
  remote?: { bin: string; launch: string };
};

// Codex, OpenCode's project file, and KödLocal all treat AGENTS.md as the
// project instruction artifact. KödLocal intentionally follows Codex's global
// file + skills locations exactly, so the matrix and headless prompt cannot
// drift onto a second set of conventions.
const CODEX_AGENTS_HARNESS: HarnessLocations = {
  instruction: {
    global: { base: "home", segments: [".codex", "AGENTS.md"] },
    project: { base: "projectRoot", segments: ["AGENTS.md"] },
  },
  skills: {
    // `.agents/skills` is the current cross-agent standard. Keep the historic
    // ~/.codex/skills location in discovery so existing installs remain visible.
    global: [
      { base: "home", segments: [".agents", "skills"] },
      { base: "home", segments: [".codex", "skills"] },
    ],
    project: [{ base: "projectRoot", segments: [".agents", "skills"] }],
    install: {
      global: { base: "home", segments: [".agents", "skills"] },
      project: { base: "projectRoot", segments: [".agents", "skills"] },
    },
  },
  mcp: [
    {
      scope: "global",
      template: { base: "home", segments: [".codex", "config.toml"] },
      format: "toml",
      keyPath: "mcp_servers",
    },
  ],
};

// Order here is the order chips render in. `launch` is usually just the bin,
// but stays explicit so a provider that needs flags (or a different entry
// command than its version bin) can override it without special-casing.
export const PROVIDERS: Provider[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    launch: "claude",
    install: "https://docs.anthropic.com/en/docs/claude-code",
    // Verified against the shipped CLI: `--output-format stream-json` requires
    // `--print` and `--verbose`; `--include-partial-messages` adds the token
    // deltas that make streaming text possible. `--resume <id>` continues the
    // session id the stream's `system/init` frame reported.
    stream: {
      dialect: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
      ],
      // Headless runs can't answer permission prompts, so each level must
      // pre-approve everything it promises. Standard pairs acceptEdits with
      // allowedTools so commands and out-of-project reads (dropped files)
      // actually run; plain acceptEdits alone denies both.
      accessArgs: {
        plan: ["--permission-mode", "plan"],
        standard: [
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          "Bash",
          "Read",
          "WebFetch",
          "WebSearch",
        ],
        full: ["--dangerously-skip-permissions"],
      },
      resumeArgs: ["--resume", "{session}"],
      modelArgs: ["--model", "{model}"],
      models: [
        { id: "claude-fable-5", label: "Fable 5" },
        { id: "claude-opus-5", label: "Opus 5" },
        { id: "claude-sonnet-5", label: "Sonnet 5" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      ],
    },
    // Claude Code: global config under ~/.claude, project config under
    // <project>/.claude, project instructions at <project>/CLAUDE.md, project
    // MCP servers in <project>/.mcp.json, and user-scope MCP servers at the
    // root of ~/.claude.json. All well-documented and stable.
    harness: {
      instruction: {
        global: { base: "home", segments: [".claude", "CLAUDE.md"] },
        project: { base: "projectRoot", segments: ["CLAUDE.md"] },
      },
      skills: {
        global: [{ base: "home", segments: [".claude", "skills"] }],
        project: [{ base: "projectRoot", segments: [".claude", "skills"] }],
        install: {
          global: { base: "home", segments: [".claude", "skills"] },
          project: { base: "projectRoot", segments: [".claude", "skills"] },
        },
      },
      subagents: {
        global: { base: "home", segments: [".claude", "agents"] },
        project: { base: "projectRoot", segments: [".claude", "agents"] },
      },
      mcp: [
        {
          scope: "global",
          template: { base: "home", segments: [".claude.json"] },
          format: "json",
          keyPath: "mcpServers",
        },
        {
          scope: "project",
          template: { base: "projectRoot", segments: [".mcp.json"] },
          format: "json",
          keyPath: "mcpServers",
        },
      ],
    },
  },
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    launch: "codex",
    install: "https://github.com/openai/codex",
    // Verified against the shipped CLI. `codex exec` reads its prompt from
    // stdin when none is given as an argument; the resume subcommand needs an
    // explicit `-` to do the same. Exec options must precede `resume`, which is
    // why resumeArgs are appended last. `--skip-git-repo-check` keeps chat
    // working in a project that isn't a git repository.
    stream: {
      dialect: "codex",
      args: ["exec", "--json", "--skip-git-repo-check"],
      // codex's sandbox IS its access story, so the levels map to sandbox
      // choices; full is the documented bypass flag.
      accessArgs: {
        plan: ["--sandbox", "read-only"],
        standard: ["--sandbox", "workspace-write"],
        full: ["--dangerously-bypass-approvals-and-sandbox"],
      },
      resumeArgs: ["resume", "{session}", "-"],
      modelArgs: ["--model", "{model}"],
      // Verified against the installed CLI's own model registry
      // (~/.codex/models_cache.json, codex 0.145.0, fetched 2026-07-26) —
      // slugs and display names verbatim, in the CLI's priority order.
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
        { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
        { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
      ],
    },
    // Codex: instructions live in AGENTS.md (global ~/.codex/AGENTS.md, project
    // <project>/AGENTS.md), and MCP servers under [mcp_servers.*] in the global
    // ~/.codex/config.toml. Both are documented and stable.
    harness: CODEX_AGENTS_HARNESS,
  },
  {
    id: "grok",
    name: "Grok Build",
    bin: "grok",
    launch: "grok",
    install: "https://docs.x.ai/build",
    // Grok Build reads project AGENTS.md and retains GROK.md compatibility.
    // Its native skills root is `.grok/skills`; Claude-compatible roots and
    // the global `.agents/skills` standard are also documented discovery paths.
    // User-scope MCP servers remain under `mcp_servers` in ~/.grok/config.toml.
    harness: {
      instruction: {
        global: { base: "home", segments: [".grok", "GROK.md"] },
        project: [
          { base: "projectRoot", segments: ["AGENTS.md"] },
          { base: "projectRoot", segments: ["GROK.md"] },
        ],
      },
      skills: {
        global: [
          { base: "home", segments: [".grok", "skills"] },
          { base: "home", segments: [".claude", "skills"] },
          { base: "home", segments: [".agents", "skills"] },
        ],
        project: [
          { base: "projectRoot", segments: [".grok", "skills"] },
          { base: "projectRoot", segments: [".claude", "skills"] },
        ],
      },
      mcp: [
        {
          scope: "global",
          template: { base: "home", segments: [".grok", "config.toml"] },
          format: "toml",
          keyPath: "mcp_servers",
        },
      ],
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    launch: "opencode",
    install: "https://opencode.ai",
    // OpenCode: instructions in AGENTS.md (global ~/.config/opencode/AGENTS.md,
    // project <project>/AGENTS.md — the same file codex reads, so a shared
    // project AGENTS.md row is expected in the matrix) and MCP servers under
    // the "mcp" key in opencode.json (global ~/.config/opencode/opencode.json,
    // project <project>/opencode.json). Both documented in OpenCode's config
    // reference. OpenCode also discovers native `.opencode/skills` plus the
    // Claude-compatible `.claude/skills` and shared `.agents/skills` roots.
    // M10g note: opencode's global config root is `~/.config/opencode` on
    // EVERY platform, Windows included — verified against its source, which
    // resolves the path via `xdg-basedir@5.1.0`'s `xdgConfig`
    // (`XDG_CONFIG_HOME || os.homedir()/.config`). That package has no win32
    // branch, and `os.homedir()` on Windows is `%USERPROFILE%`, so the config
    // lands at `%USERPROFILE%\.config\opencode` — home-relative, NOT
    // `%APPDATA%`. The home-relative template below is therefore correct on
    // Windows as-is and needs no `windows` override.
    harness: {
      instruction: {
        global: {
          base: "home",
          segments: [".config", "opencode", "AGENTS.md"],
        },
        project: { base: "projectRoot", segments: ["AGENTS.md"] },
      },
      skills: {
        global: [
          { base: "home", segments: [".config", "opencode", "skills"] },
          { base: "home", segments: [".claude", "skills"] },
          { base: "home", segments: [".agents", "skills"] },
        ],
        project: [
          { base: "projectRoot", segments: [".opencode", "skills"] },
          { base: "projectRoot", segments: [".claude", "skills"] },
          { base: "projectRoot", segments: [".agents", "skills"] },
        ],
      },
      mcp: [
        {
          scope: "global",
          template: {
            base: "home",
            segments: [".config", "opencode", "opencode.json"],
          },
          format: "json",
          keyPath: "mcp",
        },
        {
          scope: "project",
          template: { base: "projectRoot", segments: ["opencode.json"] },
          format: "json",
          keyPath: "mcp",
        },
      ],
    },
  },
  {
    id: "ollama",
    name: "Ollama",
    bin: "ollama",
    // `ollama` with no args prints help; `run` starts an interactive model.
    // Bare `ollama` is the safe launch — the user picks a model themselves.
    launch: "ollama",
    install: "https://ollama.com/download",
  },
  {
    id: "kodade-local",
    name: "KödLocal",
    // The raw-chat CLI is a small bundled TypeScript program launched by the
    // user's login-shell Node. Rust owns the daemon binary separately.
    bin: "node",
    launch: "node",
    install:
      "KödLocal needs Node.js for the desktop chat CLI — the model daemon runs without it.",
    remote: { bin: "kodade-local", launch: "kodade-local" },
    // Same instruction/skills artifacts as Codex. This is a read-only adapter:
    // KödLocal consumes the harness but adds no mutation paths.
    harness: CODEX_AGENTS_HARNESS,
  },
];

export function availableProviders(
  providers: Provider[] = PROVIDERS,
  manifest: ReleaseManifest = RELEASE_MANIFEST,
): Provider[] {
  return manifest.features.local
    ? providers
    : providers.filter((provider) => provider.id !== "kodade-local");
}

export const AVAILABLE_PROVIDERS = availableProviders();

// True when KödChat can drive this provider headlessly. Grok Build, OpenCode,
// Ollama, and KödLocal are launchable in a terminal today but expose no
// verified structured stream, so chat says so instead of guessing at flags.
export function supportsChat(provider: Provider): boolean {
  return provider.stream !== undefined;
}

// Trim raw `--version` stdout to a short token for the chip. CLIs print wildly
// different shapes ("claude 1.2.3", "codex-cli 0.9 (abc123)", "ollama version
// is 0.1.2") — grab the first dotted-number run, else the first line. All
// parsing lives here in TypeScript, never in Rust.
export function versionToken(raw: string): string {
  const cleaned = raw.trim();
  const semver = cleaned.match(/\d+\.\d+(\.\d+)?([-+][\w.]+)?/);
  if (semver) return semver[0];
  // No dotted number — fall back to the first non-empty line, capped short.
  const firstLine = cleaned.split(/\r?\n/)[0]?.trim() ?? "";
  return firstLine.slice(0, 24) || "installed";
}
