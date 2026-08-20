// launchPersonaRun (#64 slice 2; skills in #65): the run still goes through the
// identical addWorkSession → openTask → setProvider/setOutcome flow, and a
// persona's KödSkills are staged for install through the harness store's own
// prepareKodSkills review path BEFORE the task is opened. A skills problem must
// never block the launch.

import { createStore, type StoreApi } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { AgentsState } from "../../agents/agents-store";
import type { AgentPersona } from "../../agents/persona";
import type { KodworkState } from "../../kodwork/store";
import type { HarnessState } from "../../store/harness";
import type { ProjectsState } from "../../store/projects";
import { launchPersonaRun, personaSkillsOwner } from "./agent-runs";

function persona(skills: string[], providerId = "claude"): AgentPersona {
  return {
    id: "p1",
    name: "Reviewer",
    prompt: "Review the code",
    providerId,
    skills,
    connections: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

// Every store call appends to one shared log, so ordering (skills before the
// task is opened) is assertable.
function seams() {
  const calls: string[] = [];
  const projects = createStore(() => ({
    projects: [{ id: "p1", name: "Kodade", path: "/repo" }],
    activeProjectId: "p1",
    setActiveProject: vi.fn(async () => {}),
    addWorkSession: vi.fn(() => {
      calls.push("addWorkSession");
      return "task-1";
    }),
  })) as unknown as StoreApi<ProjectsState>;
  const work = createStore(() => ({
    tasks: {},
    openTask: vi.fn(async () => {
      calls.push("openTask");
    }),
    setProvider: vi.fn(() => {}),
    setOutcome: vi.fn(() => {}),
  })) as unknown as StoreApi<KodworkState>;
  const agents = createStore(() => ({
    selectRun: vi.fn(() => {}),
  })) as unknown as StoreApi<AgentsState>;
  return { calls, projects, work, agents };
}

function fakeHarness(calls: string[], overrides: Record<string, unknown> = {}) {
  const model = {
    pack: { skills: [{ id: "code-review" }, { id: "release-notes" }] },
    targets: [{ id: "claude", cli: "claude", clis: ["claude"], path: "/home/.claude/skills" }],
    cells: [
      {
        skillId: "code-review",
        targetId: "claude",
        targetPath: "/home/.claude/skills",
        installedPath: "/home/.claude/skills/code-review",
        status: "ready",
      },
      {
        skillId: "release-notes",
        targetId: "claude",
        targetPath: "/home/.claude/skills",
        installedPath: "/home/.claude/skills/release-notes",
        status: "installed",
      },
    ],
  };
  // prepareKodSkills stages an OWNED pending change, the way the real
  // stageBatch does, so the ownership checks are exercised for real.
  const store = createStore(() => ({
    kodSkills: model,
    kodSkillsError: null,
    pendingChange: null,
    applying: false,
    mutationError: null,
    loadKodSkills: vi.fn(async () => {}),
    prepareKodSkills: vi.fn(async (_action, _skills, _targets, projectRoot: string, owner) => {
      calls.push("prepareKodSkills");
      store.setState({ pendingChange: { title: "install skills", owner } } as never);
      void projectRoot;
    }),
    cancelPendingChange: vi.fn(() => {
      calls.push("cancelPendingChange");
      store.setState({ pendingChange: null } as never);
    }),
    ...overrides,
  })) as unknown as StoreApi<HarnessState>;
  return store;
}

describe("launchPersonaRun", () => {
  it("stages the persona's missing skills before the task is opened", async () => {
    const { calls, projects, work, agents } = seams();
    const harness = fakeHarness(calls);

    const result = await launchPersonaRun(projects, work, agents, "p1", persona(["code-review", "release-notes"]), {
      harness,
      projectRoot: "/repo",
    });

    expect(harness.getState().prepareKodSkills).toHaveBeenCalledWith(
      "install",
      ["code-review"], // release-notes is already installed — skipped
      ["claude"],
      "/repo",
      { surface: "skills", scopeId: "/repo" },
    );
    // Staged first, then the untouched work flow.
    expect(calls).toStrictEqual(["prepareKodSkills", "addWorkSession", "openTask"]);
    expect(result.taskId).toBe("task-1");
    expect(work.getState().setProvider).toHaveBeenCalledWith("task-1", "claude");
    expect(work.getState().setOutcome).toHaveBeenCalledWith("task-1", "Review the code");
    expect(agents.getState().selectRun).toHaveBeenCalledWith("task-1");
  });

  it("never touches the install path for a persona with no skills", async () => {
    const { calls, projects, work, agents } = seams();
    const harness = fakeHarness(calls);

    const result = await launchPersonaRun(projects, work, agents, "p1", persona([]), {
      harness,
      projectRoot: "/repo",
    });

    expect(harness.getState().prepareKodSkills).not.toHaveBeenCalled();
    expect(harness.getState().loadKodSkills).not.toHaveBeenCalled();
    expect(result).toStrictEqual({ taskId: "task-1", skillsNotice: null });
  });

  it("launches anyway with a notice when the provider has no skills target", async () => {
    const { calls, projects, work, agents } = seams();
    const harness = fakeHarness(calls);

    const result = await launchPersonaRun(
      projects,
      work,
      agents,
      "p1",
      persona(["code-review"], "grok"),
      { harness, projectRoot: "/repo", providerLabel: "Grok" },
    );

    expect(harness.getState().prepareKodSkills).not.toHaveBeenCalled();
    expect(result.taskId).toBe("task-1");
    expect(result.skillsNotice).toContain("Grok has no managed KödSkills folder");
    expect(calls).toStrictEqual(["addWorkSession", "openTask"]);
  });

  it("reports a staging failure instead of blocking the run", async () => {
    const { calls, projects, work, agents } = seams();
    const harness = fakeHarness(calls, {
      // Staged nothing (e.g. licence gating) and recorded why.
      prepareKodSkills: vi.fn(async () => {}),
      mutationError: "no selected KödSkills are eligible to install",
    });

    const result = await launchPersonaRun(projects, work, agents, "p1", persona(["code-review"]), {
      harness,
      projectRoot: "/repo",
    });

    expect(result.taskId).toBe("task-1");
    expect(result.skillsNotice).toContain("couldn't be staged");
    expect(result.skillsNotice).toContain("still launches");
  });

  it("re-inspects KödSkills on every launch (a cached model goes stale)", async () => {
    const { calls, projects, work, agents } = seams();
    const harness = fakeHarness(calls);

    await launchPersonaRun(projects, work, agents, "p1", persona(["code-review"]), {
      harness,
      projectRoot: "/repo",
    });

    expect(harness.getState().loadKodSkills).toHaveBeenCalledWith("/repo");
  });

  it("never clobbers a foreign staged change", async () => {
    const { calls, projects, work, agents } = seams();
    // Someone staged an MCP server from the Connections manager and left it.
    const foreign = {
      title: "add MCP server fetch",
      owner: { surface: "connections", scopeId: "/repo" },
    };
    const harness = fakeHarness(calls, { pendingChange: foreign });

    const result = await launchPersonaRun(projects, work, agents, "p1", persona(["code-review"]), {
      harness,
      projectRoot: "/repo",
    });

    expect(harness.getState().prepareKodSkills).not.toHaveBeenCalled();
    expect(harness.getState().cancelPendingChange).not.toHaveBeenCalled();
    // The foreign change survives untouched, and the run still launches.
    expect(harness.getState().pendingChange).toBe(foreign);
    expect(result.taskId).toBe("task-1");
    expect(result.skillsNotice).toContain("add MCP server fetch");
    expect(result.skillsNotice).toContain("still launches");
    expect(calls).toStrictEqual(["addWorkSession", "openTask"]);
  });

  it("replaces its own leftover staged change from an earlier launch", async () => {
    const { calls, projects, work, agents } = seams();
    const harness = fakeHarness(calls, {
      pendingChange: { title: "install skills", owner: personaSkillsOwner("/repo") },
    });

    const result = await launchPersonaRun(projects, work, agents, "p1", persona(["code-review"]), {
      harness,
      projectRoot: "/repo",
    });

    expect(harness.getState().cancelPendingChange).toHaveBeenCalledWith({
      surface: "skills",
      scopeId: "/repo",
    });
    expect(harness.getState().prepareKodSkills).toHaveBeenCalled();
    expect(result.taskId).toBe("task-1");
  });
});
