import { describe, expect, it } from "vitest";
import { MockVoxIpc } from "../ipc/mock";
import {
  MODEL_BY_ID,
  ModelChecksumError,
  VoiceModelManager,
  VOICE_MODELS,
  isProModel,
  normalizeVoicePreferences,
  suggestsSmallEnUpgrade,
} from "./models";

describe("turbo model tier (M9e)", () => {
  it("ships large-v3-turbo as a Pro-gated tier", () => {
    const turbo = MODEL_BY_ID["large-v3-turbo"];
    expect(turbo).toBeDefined();
    expect(turbo.pro).toBe(true);
    expect(turbo.fileName).toBe("ggml-large-v3-turbo.bin");
    expect(turbo.sha256).toHaveLength(64);
  });

  it("marks only the turbo tier as Pro", () => {
    expect(isProModel("large-v3-turbo")).toBe(true);
    expect(isProModel("base.en")).toBe(false);
    expect(isProModel("small.en")).toBe(false);
  });

  it("keeps the free models first so free UIs never surface turbo", () => {
    // The free tiers lead the matrix; turbo is last and pro.
    expect(VOICE_MODELS[0].id).toBe("base.en");
    expect(VOICE_MODELS.filter((m) => m.pro).map((m) => m.id)).toEqual([
      "large-v3-turbo",
    ]);
  });
});

describe("VoiceModelManager", () => {
  it("drops inherited or unknown model ids from persisted preferences", () => {
    expect(
      normalizeVoicePreferences({
        modelId: "toString",
        installedModelIds: ["base.en", "toString", "small.en"],
        reviewBeforeInsert: false,
      }),
    ).toEqual({
      modelId: "base.en",
      installedModelIds: ["base.en", "small.en"],
      reviewBeforeInsert: false,
      reviewBeforeInsertConfigured: false,
      modelsDir: null,
      inputDeviceId: null,
      commandAutoConfirm: false,
      pushToTalkCombo: null,
      pushToTalkCommandCombo: null,
    });
  });

  it("migrates the old review-by-default preference to automatic insertion", () => {
    expect(
      normalizeVoicePreferences({
        modelId: "base.en",
        installedModelIds: ["base.en"],
        reviewBeforeInsert: true,
      }),
    ).toMatchObject({
      reviewBeforeInsert: false,
      reviewBeforeInsertConfigured: false,
    });

    expect(
      normalizeVoicePreferences({
        reviewBeforeInsert: true,
        reviewBeforeInsertConfigured: true,
      }),
    ).toMatchObject({
      reviewBeforeInsert: true,
      reviewBeforeInsertConfigured: true,
    });
  });

  it("keeps a valid storage-location override and input device from persisted preferences", () => {
    expect(
      normalizeVoicePreferences({
        modelId: "base.en",
        installedModelIds: [],
        reviewBeforeInsert: true,
        modelsDir: "/custom/models",
        inputDeviceId: "USB headset",
      }),
    ).toMatchObject({
      modelsDir: "/custom/models",
      inputDeviceId: "USB headset",
    });
  });

  it("falls back to defaults for a blank or non-string storage location and device", () => {
    expect(
      normalizeVoicePreferences({
        modelId: "base.en",
        installedModelIds: [],
        reviewBeforeInsert: true,
        modelsDir: "   ",
        inputDeviceId: 42,
      }),
    ).toMatchObject({ modelsDir: null, inputDeviceId: null });
  });

  it("keeps only valid Mod-based KödWhisper shortcut overrides", () => {
    expect(
      normalizeVoicePreferences({
        pushToTalkCombo: "not a combo",
        pushToTalkCommandCombo: "Shift-k",
      }),
    ).toMatchObject({ pushToTalkCombo: null, pushToTalkCommandCombo: null });

    expect(
      normalizeVoicePreferences({
        pushToTalkCombo: "Mod-Alt-v",
        pushToTalkCommandCombo: "Mod-Shift-k",
      }),
    ).toMatchObject({
      pushToTalkCombo: "Mod-Alt-v",
      pushToTalkCommandCombo: "Mod-Shift-k",
    });

    expect(
      normalizeVoicePreferences({
        pushToTalkCombo: null,
        pushToTalkCommandCombo: null,
      }),
    ).toMatchObject({ pushToTalkCombo: null, pushToTalkCommandCombo: null });
  });

  it("drops colliding shortcut overrides while preserving distinct ones", () => {
    expect(normalizeVoicePreferences({ pushToTalkCombo: "Mod-b" })).toMatchObject({
      pushToTalkCombo: null,
    });

    expect(
      normalizeVoicePreferences({
        pushToTalkCombo: "Mod-Alt-v",
        pushToTalkCommandCombo: "Mod-Alt-v",
      }),
    ).toMatchObject({
      pushToTalkCombo: "Mod-Alt-v",
      pushToTalkCommandCombo: null,
    });

    expect(
      normalizeVoicePreferences({
        pushToTalkCombo: "Mod-Alt-v",
        pushToTalkCommandCombo: "Mod-Shift-k",
      }),
    ).toMatchObject({
      pushToTalkCombo: "Mod-Alt-v",
      pushToTalkCommandCombo: "Mod-Shift-k",
    });
  });

  it("suggests the small.en upgrade only on capable hardware without it installed", () => {
    expect(suggestsSmallEnUpgrade(8, "base.en", [])).toBe(true);
    expect(suggestsSmallEnUpgrade(4, "base.en", [])).toBe(false);
    expect(suggestsSmallEnUpgrade(8, "small.en", [])).toBe(false);
    expect(suggestsSmallEnUpgrade(8, "base.en", ["small.en"])).toBe(false);
  });

  it("downloads the selected model, reports progress, and pins the LFS checksum", async () => {
    const vox = new MockVoxIpc();
    const model = MODEL_BY_ID["base.en"];
    vox.nextDownload = { sha256: model.sha256, bytes: model.bytes };
    vox.downloadProgress = [
      { downloaded: 50, total: model.bytes },
      { downloaded: model.bytes, total: model.bytes },
    ];
    const progress: number[] = [];

    const result = await new VoiceModelManager(vox).download("base.en", (update) =>
      progress.push(update.downloaded),
    );

    expect(result).toEqual({ model, path: "/app/models/ggml-base.en.bin" });
    expect(vox.downloads).toEqual([
      { url: model.url, destPath: result.path, expectedSha256: model.sha256 },
    ]);
    expect(progress).toEqual([50, model.bytes]);
    expect(vox.deletedModels).toEqual([]);
  });

  it("deletes a corrupt download when Rust returns a mismatched checksum", async () => {
    const vox = new MockVoxIpc();
    vox.nextDownload = { sha256: "not-the-model", bytes: 1 };
    const manager = new VoiceModelManager(vox);

    await expect(manager.download("small.en", () => undefined)).rejects.toBeInstanceOf(
      ModelChecksumError,
    );
    expect(vox.deletedModels).toEqual(["/app/models/ggml-small.en.bin"]);
  });

  it("reports when corrupt-download cleanup also fails", async () => {
    const vox = new MockVoxIpc();
    vox.nextDownload = { sha256: "not-the-model", bytes: 1 };
    vox.failDeleteModelWith = new Error("file is locked");

    await expect(new VoiceModelManager(vox).download("small.en", () => undefined)).rejects.toMatchObject({
      name: "ModelChecksumError",
      cleanupError: expect.any(Error),
    });
  });

  it("passes native resumed-download progress through unchanged", async () => {
    const vox = new MockVoxIpc();
    const model = VOICE_MODELS[1];
    vox.nextDownload = { sha256: model.sha256, bytes: model.bytes };
    vox.downloadProgress = [{ downloaded: 200_000_000, total: model.bytes }];
    const updates: { downloaded: number; total: number | null }[] = [];

    await new VoiceModelManager(vox).download(model.id, (update) => updates.push(update));

    expect(updates).toEqual([{ downloaded: 200_000_000, total: model.bytes }]);
  });

  it("resolves paths, downloads, and deletes under a storage-location override", async () => {
    const vox = new MockVoxIpc();
    const model = MODEL_BY_ID["base.en"];
    vox.nextDownload = { sha256: model.sha256, bytes: model.bytes };
    const manager = new VoiceModelManager(vox);

    const result = await manager.download(
      "base.en",
      () => undefined,
      "/custom/models",
    );

    expect(result.path).toBe("/custom/models/ggml-base.en.bin");
    expect(vox.downloads).toEqual([
      {
        url: model.url,
        destPath: result.path,
        expectedSha256: model.sha256,
        modelRoot: "/custom/models",
      },
    ]);

    await manager.delete("base.en", "/custom/models");
    expect(vox.deletedModels).toEqual(["/custom/models/ggml-base.en.bin"]);
    expect(vox.deleteModelCalls.at(-1)).toEqual({
      path: "/custom/models/ggml-base.en.bin",
      modelsDir: "/custom/models",
    });
  });
});
