// Product policy for the free KödLocal model manager. Downloads are verified
// by Rust; this module owns the small, explicit catalog and persisted choices.

export type HardwareSpeedBand = {
  hardware: string;
  tokensPerSecond: string;
  note: string;
};

export type LocalModel = {
  id: "qwen3-4b-q4" | "qwen3-8b-q4" | "qwen3-30b-a3b-q4";
  label: string;
  fileName: string;
  paramsBillions: number;
  quant: "Q4_K_M";
  bytes: number;
  contextLength: number;
  url: string;
  sha256: string;
  ramEstimate: string;
  speed: readonly HardwareSpeedBand[];
  toolUse: "ok" | "unmeasured";
  honesty: string;
};

// SHA-256 and size are Hugging Face LFS metadata checked on 2026-07-19. The
// three URLs are immutable file names on the named model repositories; Rust
// verifies the bytes before atomically installing them.
export const CURATED_LOCAL_MODELS = [
  {
    id: "qwen3-4b-q4",
    label: "Qwen3 4B Instruct 2507",
    fileName: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    paramsBillions: 4,
    quant: "Q4_K_M",
    bytes: 2_497_281_120,
    contextLength: 4096,
    url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
    ramEstimate: "about 3.5–4 GB at 4k context",
    speed: [
      {
        hardware: "Apple Silicon laptop",
        tokensPerSecond: "5–15 tok/s",
        note: "M14b measured 6.8 tok/s on the gate machine.",
      },
      {
        hardware: "desktop GPU / fast unified memory",
        tokensPerSecond: "15–40 tok/s",
        note: "Bandwidth and context dominate.",
      },
    ],
    toolUse: "ok",
    honesty:
      "Tool use: ok in M14b (73.3% end-to-end task success); this free MVP is raw chat only.",
  },
  {
    id: "qwen3-8b-q4",
    label: "Qwen3 8B",
    fileName: "Qwen_Qwen3-8B-Q4_K_M.gguf",
    paramsBillions: 8,
    quant: "Q4_K_M",
    bytes: 5_027_784_224,
    contextLength: 4096,
    url: "https://huggingface.co/bartowski/Qwen_Qwen3-8B-GGUF/resolve/main/Qwen_Qwen3-8B-Q4_K_M.gguf",
    sha256: "54fffa050078e984116639c83dfb64b5aa6d4cd474e018b076777c632bbccccd",
    ramEstimate: "about 7–8 GB at 4k context",
    speed: [
      {
        hardware: "Apple Silicon laptop",
        tokensPerSecond: "3–10 tok/s",
        note: "Expect slower decode than the 4B model.",
      },
      {
        hardware: "desktop GPU / fast unified memory",
        tokensPerSecond: "10–30 tok/s",
        note: "A realistic small-model band, not a cloud-speed promise.",
      },
    ],
    toolUse: "unmeasured",
    honesty:
      "Tool use: unmeasured. Start here for stronger everyday chat if the memory report fits.",
  },
  {
    id: "qwen3-30b-a3b-q4",
    label: "Qwen3 30B-A3B MoE",
    fileName: "Qwen_Qwen3-30B-A3B-Q4_K_M.gguf",
    paramsBillions: 30,
    quant: "Q4_K_M",
    bytes: 18_632_184_480,
    contextLength: 4096,
    url: "https://huggingface.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF/resolve/main/Qwen_Qwen3-30B-A3B-Q4_K_M.gguf",
    sha256: "a015794bfb1d69cb03dbb86b185fb2b9b339f757df5f8f9dd9ebdab8f6ed5d32",
    ramEstimate: "about 22–25 GB at 4k context; for larger-memory machines",
    speed: [
      { hardware: "64–128 GB unified-memory / GPU machine", tokensPerSecond: "10–35 tok/s", note: "MoE active parameters help, but bandwidth still sets decode speed." },
      { hardware: "DGX Spark-class", tokensPerSecond: "45–54 tok/s", note: "Landscape research cites optimized 30B-class MoE reports; treat as a band, not a guarantee." },
    ],
    toolUse: "unmeasured",
    honesty: "Tool use: unmeasured. This is the big-machine option, not a recommendation for ordinary laptops.",
  },
] as const satisfies readonly LocalModel[];

export type LocalModelId = (typeof CURATED_LOCAL_MODELS)[number]["id"];
export const LOCAL_MODEL_BY_ID: Record<LocalModelId, LocalModel> = Object.fromEntries(
  CURATED_LOCAL_MODELS.map((model) => [model.id, model]),
) as unknown as Record<LocalModelId, LocalModel>;

export type ToolCapabilityTier = {
  mode: "normal" | "suggest";
  reliability: "ok" | "weak" | "unmeasured";
  banner: string;
};

function normalizedIdentity(value: string): string {
  return value.toLowerCase().replace(/\.gguf$/i, "");
}

/** Gate-derived tool policy from measured catalog notes and model size class. */
export function toolCapabilityTier(modelId: string): ToolCapabilityTier {
  const identity = normalizedIdentity(modelId);
  const curated = CURATED_LOCAL_MODELS.find((model) => {
    const candidates = [model.id, model.fileName, model.label].map(
      normalizedIdentity,
    );
    return candidates.some(
      (candidate) => identity === candidate || identity.includes(candidate),
    );
  });
  if (curated?.toolUse === "ok") {
    return {
      mode: "normal",
      reliability: "ok",
      banner: "tool reliability: ok (measured on the M14b gate)",
    };
  }

  const size = /(?:^|[-_\s])(\d+(?:\.\d+)?)b(?:$|[-_\s])/i.exec(modelId)?.[1];
  if (size !== undefined && Number(size) < 4) {
    return {
      mode: "suggest",
      reliability: "weak",
      banner:
        "tool reliability is weak for this sub-4B model; every tool requires approval",
    };
  }
  return {
    mode: "normal",
    reliability: "unmeasured",
    banner: "tool reliability unmeasured for this model",
  };
}

export type LocalModelFormat = "gguf" | "mlx";
export type CustomLocalModel = {
  id: string;
  path: string;
  label: string;
  format: LocalModelFormat;
};

// Saved endpoints are deliberately metadata only. Ködade has no cross-platform
// secure-secret store today, so persisting an OpenAI key in the versioned JSON
// settings document would be a regression. A protected endpoint can still use
// its own host-side auth/proxy; adding a key store is a separate security task.
export type SavedLocalEndpoint = {
  id: string;
  label: string;
  baseURL: string;
  notes?: string;
};

export type LocalBackendOption = SavedLocalEndpoint & { local: boolean };

export const DEFAULT_LOCAL_ENDPOINT: LocalBackendOption = {
  id: "local",
  label: "This Mac",
  baseURL: "http://127.0.0.1:4470",
  local: true,
};

export type LocalModelPreferences = {
  downloadedModelIds: LocalModelId[];
  customModels: CustomLocalModel[];
  contextLength: number;
  // M14h manual multi-box: endpoint metadata survives alongside the model
  // catalog in the same versioned projects document. It is entitlement-gated
  // at the UI/launch seam, never by silently deleting a user's saved entries.
  savedEndpoints: SavedLocalEndpoint[];
};

export const DEFAULT_LOCAL_MODEL_PREFERENCES: LocalModelPreferences = {
  downloadedModelIds: [],
  customModels: [],
  contextLength: 4096,
  savedEndpoints: [],
};

const MIN_CONTEXT = 256;
const MAX_CONTEXT = 2_097_152;
const KV_BYTES_PER_PARAM_BILLION_PER_TOKEN = 75_000;

export function isGgufPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    /\.gguf$/i.test(path.trim()) &&
    isAbsolutePath(path.trim())
  );
}

function isAbsolutePath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

// The browser cannot inspect config.json or safetensors. It accepts an
// absolute candidate directory and delegates the actual GGUF/MLX detection to
// Rust's ModelFormat::from_path, the same rule used by /kod/load.
export function isLocalModelPath(path: unknown): path is string {
  return typeof path === "string" && isAbsolutePath(path.trim());
}

export function localModelPlatformMessage(
  format: LocalModelFormat,
  isMac: boolean,
): string | null {
  return format === "mlx" && !isMac
    ? "MLX custom models are available only on macOS; use a GGUF model on this platform."
    : null;
}

function isLocalModelFormat(value: unknown): value is LocalModelFormat {
  return value === "gguf" || value === "mlx";
}

function isLocalModelId(value: unknown): value is LocalModelId {
  return typeof value === "string" && Object.hasOwn(LOCAL_MODEL_BY_ID, value);
}

function contextLength(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_CONTEXT &&
    value <= MAX_CONTEXT
    ? value
    : DEFAULT_LOCAL_MODEL_PREFERENCES.contextLength;
}

const MAX_ENDPOINTS = 32;
const MAX_ENDPOINT_LABEL_LENGTH = 120;
const MAX_ENDPOINT_NOTES_LENGTH = 1_000;

export function normalizeEndpointBaseURL(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    // Only HTTP transports are meaningful to the OpenAI backend. Rejecting
    // embedded credentials also keeps accidental API-key persistence out of
    // the settings document and avoids rendering a secret in the picker.
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const normalized = url.toString().replace(/\/$/, "");
    return normalized || null;
  } catch {
    return null;
  }
}

function normalizeSavedEndpoints(value: unknown): SavedLocalEndpoint[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const endpoints: SavedLocalEndpoint[] = [];
  for (const candidate of value) {
    if (
      endpoints.length >= MAX_ENDPOINTS ||
      !candidate ||
      typeof candidate !== "object"
    )
      continue;
    const raw = candidate as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(raw.id) ||
      seen.has(raw.id)
    )
      continue;
    const baseURL = normalizeEndpointBaseURL(raw.baseURL);
    if (!baseURL) continue;
    const label =
      typeof raw.label === "string"
        ? raw.label.trim().slice(0, MAX_ENDPOINT_LABEL_LENGTH)
        : "";
    if (!label) continue;
    const notes =
      typeof raw.notes === "string"
        ? raw.notes.trim().slice(0, MAX_ENDPOINT_NOTES_LENGTH)
        : "";
    endpoints.push({
      id: raw.id,
      label,
      baseURL,
      ...(notes ? { notes } : {}),
    });
    seen.add(raw.id);
  }
  return endpoints;
}

export function localBackendOptions(
  preferences: Pick<LocalModelPreferences, "savedEndpoints">,
  hasMultiBox: boolean,
): LocalBackendOption[] {
  return [
    DEFAULT_LOCAL_ENDPOINT,
    ...(hasMultiBox
      ? preferences.savedEndpoints.map((endpoint) => ({
          ...endpoint,
          local: false,
        }))
      : []),
  ];
}

export function normalizeLocalModelPreferences(
  value: unknown,
): LocalModelPreferences {
  if (!value || typeof value !== "object")
    return DEFAULT_LOCAL_MODEL_PREFERENCES;
  const raw = value as Record<string, unknown>;
  const downloadedModelIds = Array.isArray(raw.downloadedModelIds)
    ? [...new Set(raw.downloadedModelIds.filter(isLocalModelId))]
    : [];
  const customModels = Array.isArray(raw.customModels)
    ? raw.customModels.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const model = candidate as Record<string, unknown>;
        if (typeof model.id !== "string" || typeof model.path !== "string") return [];
        // Existing M14c preferences have no format and are necessarily GGUF.
        // New MLX entries persist their validated format with the path.
        const format = isLocalModelFormat(model.format)
          ? model.format
          : isGgufPath(model.path) ? "gguf" : null;
        if (!format || !isLocalModelPath(model.path)) return [];
        const path = model.path.trim();
        return [{
          id: model.id,
          path,
          format,
          label:
            typeof model.label === "string" && model.label.trim()
              ? model.label.trim().slice(0, 120)
              : path.split(/[\\/]/).at(-1) ?? `Custom ${format.toUpperCase()}`,
        }];
      })
    : [];
  return {
    downloadedModelIds,
    customModels,
    contextLength: contextLength(raw.contextLength),
    savedEndpoints: normalizeSavedEndpoints(raw.savedEndpoints),
  };
}

export function estimateModelMemory(model: Pick<LocalModel, "bytes" | "paramsBillions">, context: number) {
  const kvBytes = Math.ceil(model.paramsBillions * context * KV_BYTES_PER_PARAM_BILLION_PER_TOKEN);
  return { weightsBytes: model.bytes, kvBytes, totalBytes: model.bytes + kvBytes };
}

export function bytesLabel(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}
