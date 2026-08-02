import { describe, expect, it } from "vitest";
import {
  CURATED_LOCAL_MODELS,
  estimateModelMemory,
  isGgufPath,
  isLocalModelPath,
  localBackendOptions,
  localModelPlatformMessage,
  normalizeEndpointBaseURL,
  normalizeLocalModelPreferences,
  toolCapabilityTier,
  type LocalModelPreferences,
} from "./models";

describe("KödLocal model manager policy", () => {
  it("keeps validated GGUF and MLX custom paths when hydrating settings", () => {
    const preferences = normalizeLocalModelPreferences({
      customModels: [
        { id: "one", path: "/models/one.gguf", label: "one" },
        { id: "two", path: "/models/two.GGUF", label: "two" },
        { id: "mlx", path: "/models/qwen-mlx", label: "mlx", format: "mlx" },
        { id: "bad", path: "/models/nope.bin", label: "bad" },
        { id: "relative", path: "models/nope.gguf", label: "relative" },
      ],
      contextLength: 8192,
    });

    expect(preferences.contextLength).toBe(8192);
    expect(preferences.customModels.map((model) => model.path)).toEqual([
      "/models/one.gguf",
      "/models/two.GGUF",
      "/models/qwen-mlx",
    ]);
  });

  it("rejects non-GGUF and relative model paths before a load is attempted", () => {
    expect(isGgufPath("/models/qwen.gguf")).toBe(true);
    expect(isGgufPath("/models/qwen.GGUF")).toBe(true);
    expect(isGgufPath("qwen.gguf")).toBe(false);
    expect(isGgufPath("/models/qwen.bin")).toBe(false);
    expect(isLocalModelPath("/models/qwen-mlx")).toBe(true);
    expect(isLocalModelPath("models/qwen-mlx")).toBe(false);
  });

  it("includes a conservative context KV allowance in the pre-load estimate", () => {
    const model = CURATED_LOCAL_MODELS[0];
    const estimated = estimateModelMemory(model, 4096);

    expect(estimated.weightsBytes).toBe(model.bytes);
    expect(estimated.kvBytes).toBe(1_228_800_000);
    expect(estimated.totalBytes).toBe(model.bytes + 1_228_800_000);
  });

  it("reports MLX custom models as macOS-only", () => {
    expect(localModelPlatformMessage("gguf", false)).toBeNull();
    expect(localModelPlatformMessage("mlx", true)).toBeNull();
    expect(localModelPlatformMessage("mlx", false)).toBe(
      "MLX custom models are available only on macOS; use a GGUF model on this platform.",
    );
  });

  it("falls back to the free raw-chat defaults for malformed stored settings", () => {
    const preferences: LocalModelPreferences = normalizeLocalModelPreferences({
      contextLength: -1,
      customModels: "not an array",
      downloadedModelIds: ["qwen3-4b-q4", "unknown"],
    });

    expect(preferences.contextLength).toBe(4096);
    expect(preferences.customModels).toEqual([]);
    expect(preferences.downloadedModelIds).toEqual(["qwen3-4b-q4"]);
  });

  it("keeps only safe saved HTTP endpoints and exposes them only with multi-box", () => {
    const preferences = normalizeLocalModelPreferences({
      savedEndpoints: [
        {
          id: "studio",
          label: "Studio Mac",
          baseURL: " https://studio.example.test/openai/v1/ ",
          notes: "Weekend GPU box",
        },
        { id: "bad-scheme", label: "bad", baseURL: "file:///models" },
        {
          id: "credentials",
          label: "bad",
          baseURL: "https://key:secret@box.test/v1",
        },
        {
          id: "query-secret",
          label: "bad",
          baseURL: "https://box.test/v1?api_key=secret",
        },
        {
          id: "fragment",
          label: "bad",
          baseURL: "https://box.test/v1#private",
        },
        { id: "duplicate", label: "first", baseURL: "http://one.test" },
        { id: "duplicate", label: "second", baseURL: "https://two.test" },
      ],
    });

    // API keys intentionally never hydrate from the plain settings document.
    expect(preferences.savedEndpoints).toEqual([
      {
        id: "studio",
        label: "Studio Mac",
        baseURL: "https://studio.example.test/openai/v1",
        notes: "Weekend GPU box",
      },
      { id: "duplicate", label: "first", baseURL: "http://one.test" },
    ]);
    expect(localBackendOptions(preferences, false)).toEqual([
      {
        id: "local",
        label: "This Mac",
        baseURL: "http://127.0.0.1:4470",
        local: true,
      },
    ]);
    expect(
      localBackendOptions(preferences, true).map((endpoint) => endpoint.id),
    ).toEqual(["local", "studio", "duplicate"]);
  });

  it("rejects query strings, fragments, and embedded credentials in endpoint URLs", () => {
    expect(normalizeEndpointBaseURL("https://box.test/v1?api_key=secret")).toBeNull();
    expect(normalizeEndpointBaseURL("https://box.test/v1#private")).toBeNull();
    expect(normalizeEndpointBaseURL("https://user:pass@box.test/v1")).toBeNull();
    expect(normalizeEndpointBaseURL("https://box.test/openai/v1/")).toBe(
      "https://box.test/openai/v1",
    );
  });

  it("applies measured and size-class tool tiers honestly", () => {
    expect(
      toolCapabilityTier("Qwen3-4B-Instruct-2507-Q4_K_M.gguf"),
    ).toMatchObject({
      mode: "normal",
      reliability: "ok",
    });
    for (const weak of [
      "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
      "qwen2.5-0.5b-instruct-q8_0.gguf",
    ]) {
      expect(toolCapabilityTier(weak)).toMatchObject({
        mode: "suggest",
        reliability: "weak",
      });
    }
    expect(toolCapabilityTier("qwen3-8b-q4")).toMatchObject({
      mode: "normal",
      reliability: "unmeasured",
    });
    expect(toolCapabilityTier("private-custom-model")).toEqual({
      mode: "normal",
      reliability: "unmeasured",
      banner: "tool reliability unmeasured for this model",
    });
  });
});
