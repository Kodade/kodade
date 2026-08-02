import { afterEach, describe, expect, it } from "vitest";
import {
  BINDINGS,
  bindingsFor,
  labelFor,
  labelForCombo,
  setComboOverrides,
} from "./bindings";
import { releaseManifestFor } from "../release/manifest";

afterEach(() => setComboOverrides({}));

describe("shortcut bindings", () => {
  it("omits KödWhisper shortcuts from the public binding table", () => {
    expect(
      bindingsFor(releaseManifestFor("public")).map((binding) => binding.id),
    ).not.toEqual(
      expect.arrayContaining(["push-to-talk", "push-to-talk-command"]),
    );
  });

  it("declares Cmd+B as the projects sidebar toggle", () => {
    expect(BINDINGS).toContainEqual(
      expect.objectContaining({
        id: "toggle-sidebar",
        combo: "Mod-b",
        description: "Toggle projects sidebar",
      }),
    );
  });

  it("renders native labels from the same combo source", () => {
    expect(labelFor("new-session", true)).toBe("⌘T");
    expect(labelFor("new-session", false)).toBe("Ctrl+T");
    expect(labelFor("next-project", true)).toBe("⌘⌥↓");
    expect(labelFor("next-project", false)).toBe("Ctrl+Alt+Down");
    expect(labelForCombo("Ctrl-Shift-Tab", false)).toBe("Ctrl+Shift+Tab");
  });

  it("declares hold-to-talk with a platform-native Mod+Shift+M label", () => {
    expect(BINDINGS).toContainEqual(
      expect.objectContaining({ id: "push-to-talk", combo: "Mod-Shift-m" }),
    );
    expect(labelFor("push-to-talk", true)).toBe("⌘⇧M");
    expect(labelFor("push-to-talk", false)).toBe("Ctrl+Shift+M");
  });

  it("uses an override in the push-to-talk label and restores the default when cleared", () => {
    setComboOverrides({ "push-to-talk": "Mod-Alt-v" });

    expect(labelFor("push-to-talk", true)).toBe("⌘⌥V");
    expect(labelFor("push-to-talk", false)).toBe("Ctrl+Alt+V");

    setComboOverrides({});
    expect(labelFor("push-to-talk", true)).toBe("⌘⇧M");
  });
});
