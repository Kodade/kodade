import { describe, expect, it } from "vitest";
import { availableSettingsSections } from "../components/settings/registry";
import { externalUrls, local, ssh, vox } from "../ipc/transport";
import { AVAILABLE_PROVIDERS, supportsChat } from "../providers/catalog";
import { BINDINGS } from "../shortcuts/bindings";
import { RELEASE_MANIFEST } from "./manifest";

describe("compiled public surface", () => {
  it("uses the closed public manifest", () => {
    expect(RELEASE_MANIFEST.profile).toBe("public");
    expect(Object.values(RELEASE_MANIFEST.features)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("disables terminal voice, local delegation, and remote state", () => {
    expect(RELEASE_MANIFEST.features.voice).toBe(false);
    expect(RELEASE_MANIFEST.features.local).toBe(false);
    expect(RELEASE_MANIFEST.features.ssh).toBe(false);
  });

  it("omits development settings, providers, and shortcuts", () => {
    expect(
      availableSettingsSections().map((section) => section.id),
    ).not.toEqual(expect.arrayContaining(["local", "voice", "ssh"]));
    expect(AVAILABLE_PROVIDERS.map((provider) => provider.id)).not.toContain(
      "kodade-local",
    );
    expect(BINDINGS.map((binding) => binding.id)).not.toEqual(
      expect.arrayContaining(["push-to-talk", "push-to-talk-command"]),
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

  it("rejects every development IPC group before native execution", async () => {
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
