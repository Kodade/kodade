import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdvancedSection } from "../components/settings/AdvancedSection";
import {
  availableSettingsSections,
  settingsSection,
} from "../components/settings/registry";
import { activateBrowserForAgent } from "../browser/agent-activation";
import { chatLinkTarget } from "../browser/link-target";
import { browser, externalUrls, local, ssh, vox } from "../ipc/transport";
import { browserPaneAvailable } from "../platform/capabilities";
import { AVAILABLE_PROVIDERS, supportsChat } from "../providers/catalog";
import { BINDINGS } from "../shortcuts/bindings";
import { decodeTab, decodeTabs } from "../store/tabs";
import { RELEASE_MANIFEST } from "./manifest";

describe("compiled public surface", () => {
  it("uses the supported public manifest", () => {
    expect(RELEASE_MANIFEST.profile).toBe("public");
    expect(Object.values(RELEASE_MANIFEST.features)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  it("keeps KödWork while disabling terminal voice, local delegation, and remote state", () => {
    expect(RELEASE_MANIFEST.features.voice).toBe(false);
    expect(RELEASE_MANIFEST.features.local).toBe(false);
    expect(RELEASE_MANIFEST.features.ssh).toBe(false);
    expect(RELEASE_MANIFEST.features.work).toBe(true);
  });

  it("ships the v2 tabbed shell as the supported product (#65)", () => {
    expect(RELEASE_MANIFEST.features.shell).toBe(true);
  });

  it("compiles without the archived embedded browser (#62)", () => {
    expect(RELEASE_MANIFEST.features.browser).toBe(false);
    // No button, no pane, and chat links leave for the OS browser.
    expect(browserPaneAvailable(null)).toBe(false);
    expect(chatLinkTarget(null)).toBe("external");
  });

  it("drops persisted browser tabs without damaging the rest of the layout", () => {
    expect(decodeTab("browser:https://example.com/")).toBeNull();
    expect(decodeTabs(["/work/a.ts", "browser:https://example.com/", "github:"])).toEqual([
      { kind: "file", path: "/work/a.ts" },
      { kind: "github" },
    ]);
  });

  it("fails the KödBrowser agent flows closed", async () => {
    await expect(browser.create("editor", "https://example.com/", {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })).rejects.toThrow("KödBrowser is unavailable");
    await expect(
      activateBrowserForAgent(
        { projectRoot: "/work", url: "https://example.com/" },
        {
          projects: [{ id: "p", path: "/work" }],
          setActiveProject: async () => undefined,
          syncProjectFiles: async () => undefined,
          openBrowserTab: () => undefined,
          setBrowserUrl: () => undefined,
        },
      ),
    ).rejects.toThrow("KödBrowser is unavailable");
  });

  it("restores persisted KödWork task tabs", () => {
    expect(decodeTab("kodwork:some-task")).toEqual({
      kind: "kodwork",
      taskId: "some-task",
    });
  });

  it("omits development settings, providers, and shortcuts", () => {
    // Four sections, and the Advanced page carries the harness alone: no
    // development block renders and there is nothing to restore.
    expect(availableSettingsSections().map((section) => section.id)).toEqual([
      "general",
      "providers",
      "memory",
      "advanced",
    ]);
    expect(settingsSection("advanced").restoreDefaults).toBeUndefined();
    const advanced = renderToStaticMarkup(createElement(AdvancedSection));
    expect(advanced).toContain("ködharness");
    expect(advanced).not.toContain("ködlocal");
    expect(advanced).not.toContain("ködwhisper");
    expect(advanced).not.toContain("ködssh");
    expect(AVAILABLE_PROVIDERS.map((provider) => provider.id)).not.toContain(
      "kodade-local",
    );
    expect(BINDINGS.map((binding) => binding.id)).not.toEqual(
      expect.arrayContaining(["push-to-talk", "push-to-talk-command"]),
    );
  });

  it("keeps supported projects-vault KödMem in the public profile", () => {
    expect(availableSettingsSections().map((section) => section.id)).toContain(
      "memory",
    );
  });

  it("keeps the OpenCode and local Ollama chat providers in the public profile", () => {
    const providers = AVAILABLE_PROVIDERS;
    expect(providers.find((provider) => provider.id === "opencode")).toMatchObject({
      stream: { dialect: "opencode" },
    });
    const ollama = providers.find((provider) => provider.id === "ollama");
    expect(ollama).toMatchObject({ chat: { kind: "ollama" } });
    expect(supportsChat(ollama!)).toBe(true);
  });

  it("keeps both supported Grok Build models in the public profile", () => {
    expect(
      AVAILABLE_PROVIDERS.find((provider) => provider.id === "grok")?.stream?.models,
    ).toEqual([
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
    ]);
  });

  it("rejects every remaining development IPC group before native execution", async () => {
    await expect(local.status()).rejects.toThrow("KödLocal is unavailable");
    await expect(vox.listInputDevices()).rejects.toThrow(
      "KödWhisper is unavailable",
    );
    await expect(
      externalUrls.openMicrophonePrivacySettings(),
    ).rejects.toThrow("KödWhisper is unavailable");
    await expect(ssh.detect()).rejects.toThrow("KödSSH is unavailable");
  });
});
