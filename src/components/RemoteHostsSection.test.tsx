import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentIpc, MockFiles, MockStorage, MockSsh } from "../ipc/mock";
import { createProjectsStore } from "../store/projects";
import { createSshStore } from "../store/ssh";
import { createFilesStore } from "../store/files";
import { createEntitlements } from "../app/entitlements";
import { licenseStore } from "../license";
import { RemoteHostsSection } from "./RemoteHostsSection";
import { createChatStore } from "../chat/store";
import { remoteProjectId } from "../ssh/model";

// Fake registry mirroring src/store/projects.test.ts's own — the component
// exercises the real launchInSession path, so this is what stands in for
// xterm/PTY IPC.
function fakeRegistry() {
  const opens: { id: string; cwd: string }[] = [];
  const writes: { id: string; data: string }[] = [];
  return {
    opens,
    writes,
    registry: {
      open: (id: string, cwd: string) => void opens.push({ id, cwd }),
      close: async () => {},
      write: (id: string, data: string) => void writes.push({ id, data }),
    },
  };
}

function idGen() {
  let n = 0;
  return () => `id-${++n}`;
}

async function setup(opts: { hosts?: string; detectFails?: boolean } = {}) {
  const { opens, writes, registry } = fakeRegistry();
  const projectsStore = createProjectsStore({
    storage: new MockStorage(),
    registry,
    newId: idGen(),
  });
  await projectsStore.getState().hydrate();
  await projectsStore.getState().addProject("/repo");

  const mockSsh = new MockSsh();
  if (opts.detectFails) {
    mockSsh.detectResult = null;
    mockSsh.detectFailure = "ssh: command not found";
  }
  if (opts.hosts !== undefined) mockSsh.configs.set(undefined, opts.hosts);
  const sshStore = createSshStore({ ssh: mockSsh });

  return { projectsStore, sshStore, opens, writes, mockSsh };
}

// Flush the init()/connect() microtask chains.
async function flush() {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

// happy-dom + React 18: setting .value directly doesn't route through
// React's tracked setter, so onChange never fires from a raw
// dispatchEvent("input"). Go through the native prototype setter first
// (same trick MemoryPane.test.tsx uses).
function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("RemoteHostsSection", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("renders hosts parsed from ssh config", async () => {
    const { projectsStore, sshStore } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
        />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain("box");
    expect(container!.textContent).toContain("1.2.3.4");
  });

  it("shows only the ad-hoc input when there are no hosts", async () => {
    const { projectsStore, sshStore } = await setup({ hosts: "" });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
        />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain("no hosts in ~/.ssh/config");
    expect(
      container!.querySelector('input[aria-label="Ad-hoc remote host"]'),
    ).toBeTruthy();
  });

  it("manually refreshes hosts after ~/.ssh/config changes", async () => {
    const { projectsStore, sshStore, mockSsh } = await setup({ hosts: "" });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
        />,
      ),
    );
    await flush();
    expect(container!.textContent).toContain("no hosts in ~/.ssh/config");

    mockSsh.configs.set(
      undefined,
      "Host studio\n  HostName 100.98.189.17\n",
    );
    const refresh = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh SSH hosts"]',
    );
    expect(refresh).toBeTruthy();
    await act(async () => refresh?.click());
    await flush();

    expect(container!.textContent).toContain("studio");
    expect(container!.textContent).toContain("100.98.189.17");
  });

  it("shows a quiet message when ssh is missing", async () => {
    const { projectsStore, sshStore } = await setup({ detectFails: true });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
        />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain("ssh not found on PATH");
    expect(
      container!.querySelector('input[aria-label="Ad-hoc remote host"]'),
    ).toBeNull();
  });

  it("connecting a host dispatches launchInSession: opens a session and types ssh -t <alias>", async () => {
    const { projectsStore, sshStore, opens, writes } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
        />,
      ),
    );
    await flush();

    const opensBefore = opens.length; // addProject already auto-opens a shell session
    const hostButton = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("box"),
    )!;
    await act(async () => hostButton.click());
    await flush();

    expect(opens).toHaveLength(opensBefore + 1);
    expect(opens.at(-1)!.cwd).toBe("/repo");
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toBe("ssh -t box\r");

    // Session is badged with the host name via the ordinary naming convention.
    const session = projectsStore
      .getState()
      .sessions.find((s) => s.name.startsWith("ssh "))!;
    expect(session.name).toBe("ssh box 1");
  });

  it("validates ad-hoc input and rejects hostile hosts before connecting", async () => {
    const { projectsStore, sshStore, opens } = await setup({ hosts: "" });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
        />,
      ),
    );
    await flush();

    const input = container!.querySelector<HTMLInputElement>(
      'input[aria-label="Ad-hoc remote host"]',
    )!;
    const submit = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Connect ad-hoc host"]',
    )!;

    const opensBefore = opens.length; // addProject already auto-opens a shell session

    // Hostile input: the submit button stays disabled, nothing launches.
    await act(async () => typeInto(input, "keith@host; rm -rf /"));
    await flush();
    expect(submit.disabled).toBe(true);
    expect(container!.textContent).toContain("invalid host");

    // Valid ad-hoc target connects.
    await act(async () => typeInto(input, "keith@buildbox"));
    await flush();
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await flush();

    expect(opens).toHaveLength(opensBefore + 1);
    const session = projectsStore
      .getState()
      .sessions.find((s) => s.name.startsWith("ssh "))!;
    expect(session.name).toBe("ssh keith@buildbox 1");
  });

  it("free tier: a second remote session shows the honest lock row instead of connecting", async () => {
    const { projectsStore, sshStore, opens } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\nHost other\n  HostName 5.6.7.8\n",
    });
    const entitlements = createEntitlements({ "ssh.pro": false });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    const clickHost = async (name: string) => {
      const button = Array.from(container!.querySelectorAll("button")).find(
        (b) => b.textContent?.includes(name),
      )!;
      await act(async () => button.click());
      await flush();
    };

    const opensBefore = opens.length; // addProject already auto-opens a shell session

    await clickHost("box");
    expect(opens).toHaveLength(opensBefore + 1);
    expect(container!.textContent).not.toContain(
      "Pro unlocks unlimited remote sessions",
    );

    await clickHost("other");
    expect(opens).toHaveLength(opensBefore + 1); // second connect blocked
    expect(container!.textContent).toContain(
      "Pro unlocks unlimited remote sessions",
    );
  });

  it("free tier: two same-frame rapid connects open exactly one session (no closure race)", async () => {
    const { projectsStore, sshStore, opens } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\nHost other\n  HostName 5.6.7.8\n",
    });
    const entitlements = createEntitlements({ "ssh.pro": false });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    const opensBefore = opens.length; // addProject already auto-opens a shell session
    const findHost = (name: string) =>
      Array.from(container!.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(name),
      )!;

    // Both clicks land in the same frame — before any re-render can refresh
    // the render-closure `limited` flag. connect() must re-check the store.
    await act(async () => {
      findHost("box").click();
      findHost("other").click();
    });
    await flush();

    expect(opens).toHaveLength(opensBefore + 1);
    const remote = projectsStore
      .getState()
      .sessions.filter((s) => s.name.startsWith("ssh "));
    expect(remote).toHaveLength(1);
    expect(container!.textContent).toContain(
      "Pro unlocks unlimited remote sessions",
    );
  });

  it("pro tier: unlimited remote sessions connect without a lock row", async () => {
    const { projectsStore, sshStore, opens } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\nHost other\n  HostName 5.6.7.8\n",
    });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    const clickHost = async (name: string) => {
      const button = Array.from(container!.querySelectorAll("button")).find(
        (b) => b.textContent?.includes(name),
      )!;
      await act(async () => button.click());
      await flush();
    };

    const opensBefore = opens.length; // addProject already auto-opens a shell session
    await clickHost("box");
    await clickHost("other");

    expect(opens).toHaveLength(opensBefore + 2);
    expect(container!.textContent).not.toContain(
      "Pro unlocks unlimited remote sessions",
    );
  });

  it("free tier: shows the honest remote-project lock row and no pin affordance", async () => {
    const { projectsStore, sshStore } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    const entitlements = createEntitlements({ "ssh.pro": false });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain("make box a project");
    expect(container!.textContent).toContain("detect its agent CLIs");
    // No pin button is offered to free users.
    expect(
      container!.querySelector(
        'button[aria-label="Pin box as a remote project"]',
      ),
    ).toBeNull();
  });

  it("pro tier: pinning a host from the sidebar persists a remote target", async () => {
    const { projectsStore, sshStore } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    expect(container!.textContent).not.toContain("📌");
    const pinToggle = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for box"]',
    )!;
    await act(async () => pinToggle.click());
    await flush();

    const pathInput = container!.querySelector<HTMLInputElement>(
      'input[aria-label="Remote path on box"]',
    )!;
    await act(async () => typeInto(pathInput, "/home/keith/app"));
    await flush();
    const confirm = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Confirm pin box"]',
    )!;
    await act(async () => confirm.click());
    await flush();

    expect(projectsStore.getState().remoteTargets).toEqual([
      { host: "box", path: "/home/keith/app" },
    ]);

    const remove = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove saved remote box:/home/keith/app"]',
    );
    expect(remove).toBeTruthy();
    await act(async () => remove?.click());
    await flush();
    expect(projectsStore.getState().remoteTargets).toEqual([]);
  });

  it("pro tier: a detected provider launches into a remote project session", async () => {
    const { projectsStore, sshStore, writes, mockSsh } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    // claude is present on the remote; the other probes default to not-found.
    mockSsh.execScript.set("claude", {
      status: 0,
      stdout: "/usr/bin/claude",
      stderr: "",
      truncated: false,
    });
    // Pre-pin so detection runs on mount.
    projectsStore.getState().pinRemoteTarget({ host: "box", path: "/srv/app" });

    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    // The claude launch button appears once detection settles.
    const launchClaude = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "claude",
    )!;
    expect(launchClaude).toBeTruthy();

    const writesBefore = writes.length;
    await act(async () => launchClaude.click());
    await flush();

    expect(writes).toHaveLength(writesBefore + 1);
    // The remote command (cd && exec claude) travels as ONE quoted local
    // argument, so `&&` and the exec run on the REMOTE shell. happy-dom's
    // navigator reports a non-Mac platform (see src/ssh/command.ts's
    // defaultLocalShell), so buildSshProjectLaunch's default here resolves to
    // PowerShell's outer quoting (doubled `'`, not POSIX's '"'"') — this test
    // exercises that Windows-safe path end to end through the real component.
    expect(writes.at(-1)!.data).toBe(
      `ssh -t box 'cd ''/srv/app'' && exec ''claude'''\r`,
    );
    // Named as a remote provider session ("ssh claude 1").
    const session = projectsStore
      .getState()
      .sessions.find((s) => s.name === "ssh claude 1")!;
    expect(session).toBeTruthy();
  });

  it("sidebar mode renders a remote project with new chats nested beneath it", async () => {
    const { projectsStore, sshStore } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    const target = { host: "box", path: "/srv/app" };
    projectsStore.getState().pinRemoteTarget(target);
    const chatThreadsStore = createChatStore({
      agent: new MockAgentIpc(),
      storage: new MockStorage(),
      projectRoot: () => null,
      remoteTarget: () => target,
    });

    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          chatThreadsStore={chatThreadsStore}
          entitlements={createEntitlements({ "ssh.pro": true })}
          projectTree
        />,
      ),
    );
    await flush();

    const projectId = remoteProjectId(target);
    expect(container!.querySelector(`[data-remote-project="${projectId}"]`)).toBeTruthy();
    const newChat = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="New chat in app"]',
    );
    expect(newChat).toBeTruthy();
    await act(async () => newChat?.click());
    await flush();

    const thread = projectsStore
      .getState()
      .sessions.find(
        (session) => session.projectId === projectId && session.kind === "chat",
      );
    expect(thread).toMatchObject({
      name: "claude 1",
      remote: true,
    });
    expect(projectsStore.getState().activeProjectId).toBe(projectId);
    expect(container!.textContent).toContain("claude 1");
  });

  it("sidebar mode keeps project actions project-like and opens a clean nested terminal", async () => {
    const { projectsStore, sshStore, writes, mockSsh } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    mockSsh.execScript.set("claude", {
      status: 0,
      stdout: "/usr/bin/claude",
      stderr: "",
      truncated: false,
    });
    const target = { host: "box", path: "/srv/app" };
    projectsStore.getState().pinRemoteTarget(target);
    await projectsStore.getState().setActiveProject(remoteProjectId(target));

    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={createEntitlements({ "ssh.pro": true })}
          projectTree
        />,
      ),
    );
    await flush();

    expect(
      container!.querySelector('input[aria-label="Ad-hoc remote host"]'),
    ).toBeNull();
    expect(
      container!.querySelector('button[aria-label^="Browse files on"]'),
    ).toBeNull();
    expect(
      container!.querySelector('button[aria-label="Refresh SSH hosts"]'),
    ).toBeNull();
    expect(
      Array.from(container!.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "claude",
      ),
    ).toBe(false);

    const terminal = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="New terminal in app"]',
    );
    expect(terminal).toBeTruthy();
    await act(async () => terminal?.click());
    await flush();

    expect(writes.at(-1)?.data).toBe(
      `ssh -t box 'cd ''/srv/app'' && exec "$SHELL" -l'\r`,
    );
    expect(
      projectsStore
        .getState()
        .sessions.find(
          (session) =>
            session.projectId === remoteProjectId(target) &&
            session.kind !== "chat",
        ),
    ).toMatchObject({
      name: "ssh box 1",
      remote: true,
    });
    expect(container!.textContent).toContain("ssh box 1");
    expect(
      container!
        .querySelector('button[aria-label="Open app remote project"]')
        ?.querySelector(".tabular-nums")?.textContent,
    ).toBe("");
  });

  it("KödLocal uses its remote PATH CLI and the selected backend when launching through KödSSH", async () => {
    const { projectsStore, sshStore, writes, mockSsh } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    mockSsh.execScript.set("kodade-local", {
      status: 0,
      stdout: "/usr/local/bin/kodade-local",
      stderr: "",
      truncated: false,
    });
    projectsStore.getState().pinRemoteTarget({ host: "box", path: "/srv/app" });
    projectsStore.getState().setLocalModelPreferences({
      ...projectsStore.getState().localModelPreferences,
      savedEndpoints: [
        {
          id: "studio",
          label: "Studio GPU",
          baseURL: "https://gpu.example.test/v1",
        },
      ],
    });

    const originalHasFeature = licenseStore.getState().hasFeature;
    licenseStore.setState({
      hasFeature: (feature) =>
        feature === "local.multibox" || originalHasFeature(feature),
    });
    try {
      await act(async () =>
        root?.render(
          <RemoteHostsSection
            sshStore={sshStore}
            projectsStore={projectsStore}
            entitlements={createEntitlements({ "ssh.pro": true })}
          />,
        ),
      );
      await flush();

      const picker = container!.querySelector<HTMLSelectElement>(
        'select[aria-label="KödLocal backend for box"]',
      );
      expect(picker).toBeTruthy();
      expect(Array.from(picker!.options).map((option) => option.text)).toEqual([
        "This Mac",
        "Studio GPU",
      ]);
      await act(async () => {
        picker!.value = "studio";
        picker!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();

      const launch = Array.from(container!.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "kodade-local",
      );
      expect(launch).toBeTruthy();
      await act(async () => launch?.click());
      await flush();

      expect(writes.at(-1)?.data).toBe(
        `ssh -t box 'cd ''/srv/app'' && exec ''kodade-local'' ''--base-url'' ''https://gpu.example.test/v1'''\r`,
      );
    } finally {
      licenseStore.setState({ hasFeature: originalHasFeature });
    }
  });

  it("pro tier: a probe error (not a clean not-found) shows its own reason per provider (M11e)", async () => {
    const { projectsStore, sshStore, mockSsh } = await setup({
      hosts: "Host box\n  HostName 1.2.3.4\n",
    });
    // codex's probe rejects (e.g. a dead/slow remote) rather than resolving
    // "not found" — this must render as a distinct, visible failure reason,
    // not be swallowed into the generic "no agent CLIs detected" line.
    mockSsh.execScript.set("codex", "reject");
    mockSsh.execRejectReason = "ssh_exec timed out after 8000ms";
    projectsStore.getState().pinRemoteTarget({ host: "box", path: "/srv/app" });

    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain(
      "codex: ssh_exec timed out after 8000ms",
    );
    // Providers that cleanly report "not found" don't get their own noisy
    // line — only real anomalies do.
    expect(container!.textContent).not.toContain("not found");
  });

  it("pro tier: opening a pinned target starts a remote project shell", async () => {
    const { projectsStore, sshStore, writes } = await setup({ hosts: "" });
    projectsStore.getState().pinRemoteTarget({ host: "box", path: "/srv/app" });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    const openBtn = container!.querySelector<HTMLButtonElement>(
      'button[title="open a terminal in box:/srv/app"]',
    )!;
    expect(openBtn.textContent).toContain("app");
    expect(openBtn.textContent).toContain("box");
    expect(openBtn.textContent).not.toContain("/srv/app");
    const writesBefore = writes.length;
    await act(async () => openBtn.click());
    await flush();

    expect(writes).toHaveLength(writesBefore + 1);
    // Same one-argument rule: the local shell must pass cd/&&/$SHELL through
    // to ssh untouched, inside the single outer-quoted remote command. See
    // the comment on the provider-launch test above for why this expects
    // PowerShell's doubled-`'` outer quoting rather than POSIX's '"'"'.
    expect(writes.at(-1)!.data).toBe(
      `ssh -t box 'cd ''/srv/app'' && exec "$SHELL" -l'\r`,
    );
  });

  it("pro tier: unpinning clears the target's detections so a repin re-probes", async () => {
    const { projectsStore, sshStore, mockSsh } = await setup({ hosts: "" });
    mockSsh.execScript.set("claude", {
      status: 0,
      stdout: "/usr/bin/claude",
      stderr: "",
      truncated: false,
    });
    projectsStore.getState().pinRemoteTarget({ host: "box", path: "/srv/app" });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();
    const probesAfterFirstDetect = mockSsh.execCalls.length;
    expect(probesAfterFirstDetect).toBeGreaterThan(0);

    const unpin = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove saved remote box:/srv/app"]',
    )!;
    await act(async () => unpin.click());
    await flush();
    expect(projectsStore.getState().remoteTargets).toEqual([]);
    expect(sshStore.getState().detections["box\0/srv/app"]).toBeUndefined();

    // Repin: the mount effect sees no cached detections and probes again.
    await act(async () => {
      projectsStore
        .getState()
        .pinRemoteTarget({ host: "box", path: "/srv/app" });
    });
    await flush();
    expect(mockSsh.execCalls.length).toBeGreaterThan(probesAfterFirstDetect);
  });

  it("pro tier: browse files activates the remote project for the right files pane", async () => {
    const { projectsStore, sshStore } = await setup({ hosts: "" });
    projectsStore.getState().pinRemoteTarget({ host: "box", path: "/srv/app" });
    const filesStore = createFilesStore({ files: new MockFiles() });
    await filesStore.getState().setRoot("/repo");
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          filesStore={filesStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    const browseBtn = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Browse files on box:/srv/app"]',
    )!;
    expect(browseBtn).toBeTruthy();
    await act(async () => browseBtn.click());

    expect(projectsStore.getState().activeProjectId).toBe(
      remoteProjectId({ host: "box", path: "/srv/app" }),
    );
    expect(filesStore.getState().rootPath).toBeNull();
    expect(filesStore.getState().activeTab).toBeNull();
  });

  it("free tier: the browse-files affordance never renders (pinned rows are Pro-only)", async () => {
    const { projectsStore, sshStore } = await setup({ hosts: "" });
    projectsStore.getState().pinRemoteTarget({ host: "box", path: "/srv/app" });
    const entitlements = createEntitlements({ "ssh.pro": false });
    await act(async () =>
      root?.render(
        <RemoteHostsSection
          sshStore={sshStore}
          projectsStore={projectsStore}
          entitlements={entitlements}
        />,
      ),
    );
    await flush();

    expect(
      container!.querySelector('button[aria-label^="Browse files"]'),
    ).toBeNull();
  });
});
