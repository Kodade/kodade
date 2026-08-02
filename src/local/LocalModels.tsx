import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { local } from "../ipc/transport";
import { licenseStore } from "../license";
import { FEATURES } from "../license/features";
import { appStore } from "../store/appStore";
import { OpenAIHttpBackend, type MemoryReport } from "./backend";
import { detectMacPlatform } from "../shortcuts/bindings";
import {
  bytesLabel,
  CURATED_LOCAL_MODELS,
  estimateModelMemory,
  isLocalModelPath,
  localBackendOptions,
  localModelPlatformMessage,
  normalizeEndpointBaseURL,
  type CustomLocalModel,
  type LocalModel,
} from "./models";

type DownloadState = {
  id: string;
  downloaded: number;
  total: number | null;
} | null;

function modelBackend(port: number) {
  return new OpenAIHttpBackend({ baseURL: `http://127.0.0.1:${port}` });
}

function customEstimate(bytes: number, contextLength: number) {
  // A filename cannot reveal architecture, so reserve an 8B-class KV cache
  // rather than pretending custom GGUFs have a precise estimate.
  return {
    weightsBytes: bytes,
    kvBytes: contextLength * 600_000,
    totalBytes: bytes + contextLength * 600_000,
  };
}

export function LocalModelsSection() {
  const isMac = detectMacPlatform();
  const preferences = useStore(
    appStore,
    (state) => state.localModelPreferences,
  );
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Awaited<
    ReturnType<typeof local.status>
  > | null>(null);
  const [memory, setMemory] = useState<MemoryReport | null>(null);
  const [download, setDownload] = useState<DownloadState>(null);
  const [customPath, setCustomPath] = useState("");
  const [endpointLabel, setEndpointLabel] = useState("");
  const [endpointURL, setEndpointURL] = useState("");
  const [endpointNotes, setEndpointNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasMultiBox = useStore(licenseStore, (state) =>
    state.hasFeature(FEATURES.localMultiBox),
  );

  async function refresh(start = true) {
    setMessage(null);
    try {
      const next = start ? await local.start() : await local.status();
      setStatus(next);
      if (next.running) setMemory(await modelBackend(next.port).memoryReport());
      else setMemory(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  function updatePreferences(next: Partial<typeof preferences>) {
    appStore.getState().setLocalModelPreferences({ ...preferences, ...next });
  }

  async function downloadModel(model: LocalModel) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await local.downloadModel(
        {
          url: model.url,
          fileName: model.fileName,
          expectedSha256: model.sha256,
        },
        (progress) => setDownload({ id: model.id, ...progress }),
      );
      updatePreferences({
        downloadedModelIds: [
          ...new Set([...preferences.downloadedModelIds, model.id]),
        ],
      });
      setMessage(
        `${model.label} verified and saved (${bytesLabel(result.bytes)}).`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDownload(null);
      setBusy(false);
    }
  }

  async function loadModel(
    path: string,
    bytes: number,
    estimate:
      | ReturnType<typeof estimateModelMemory>
      | ReturnType<typeof customEstimate>,
  ) {
    setBusy(true);
    setMessage(null);
    try {
      const daemon = status?.running ? status : await local.start();
      setStatus(daemon);
      const report = await modelBackend(daemon.port).memoryReport();
      setMemory(report);
      if (
        report.ramBudgetBytes !== undefined &&
        estimate.totalBytes > report.ramBudgetBytes
      ) {
        setMessage(
          `Not loading: this needs about ${bytesLabel(estimate.totalBytes)} (weights ${bytesLabel(bytes)} + context allowance ${bytesLabel(estimate.kvBytes)}), but the daemon budget is ${bytesLabel(report.ramBudgetBytes)}.`,
        );
        return;
      }
      await modelBackend(daemon.port).loadModel({
        path,
        ctx: preferences.contextLength,
      });
      setMemory(await modelBackend(daemon.port).memoryReport());
      setMessage(
        "Model loaded. KödLocal prints measured tok/s after each terminal reply when the engine reports token usage.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadCurated(model: LocalModel) {
    const path = await local.modelPath(model.fileName);
    await loadModel(
      path,
      model.bytes,
      estimateModelMemory(model, preferences.contextLength),
    );
  }

  async function loadCustom(model: CustomLocalModel) {
    const unavailable = localModelPlatformMessage(model.format, isMac);
    if (unavailable) {
      setMessage(unavailable);
      return;
    }
    try {
      const info = await local.validateModel(model.path);
      await loadModel(
        info.path,
        info.bytes,
        customEstimate(info.bytes, preferences.contextLength),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function unload() {
    const loaded = memory?.loadedModels[0];
    if (!loaded || !status) return;
    setBusy(true);
    try {
      await modelBackend(status.port).unloadModel(loaded.id);
      await refresh(false);
      setMessage("Model unloaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function addCustom() {
    if (!isLocalModelPath(customPath)) {
      setMessage("Enter an absolute .gguf file path or MLX model directory.");
      return;
    }
    try {
      const info = await local.validateModel(customPath.trim());
      const model: CustomLocalModel = {
        id: info.path,
        path: info.path,
        format: info.format,
        label:
          info.path.split(/[\\/]/).at(-1) ??
          `Custom ${info.format.toUpperCase()}`,
      };
      if (!preferences.customModels.some((item) => item.path === model.path)) {
        updatePreferences({
          customModels: [...preferences.customModels, model],
        });
      }
      setCustomPath("");
      setMessage(
        `Added ${model.label} (${model.format.toUpperCase()}, ${bytesLabel(info.bytes)}).`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function addEndpoint() {
    const baseURL = normalizeEndpointBaseURL(endpointURL);
    const label = endpointLabel.trim();
    if (!label || !baseURL) {
      setMessage(
        "Enter a label and an http(s) OpenAI-compatible URL. URLs cannot include credentials.",
      );
      return;
    }
    if (
      preferences.savedEndpoints.some(
        (endpoint) => endpoint.baseURL === baseURL,
      )
    ) {
      setMessage("That backend URL is already saved.");
      return;
    }
    const id = crypto.randomUUID().replace(/-/g, "");
    updatePreferences({
      savedEndpoints: [
        ...preferences.savedEndpoints,
        {
          id,
          label: label.slice(0, 120),
          baseURL,
          ...(endpointNotes.trim()
            ? { notes: endpointNotes.trim().slice(0, 1000) }
            : {}),
        },
      ],
    });
    setEndpointLabel("");
    setEndpointURL("");
    setEndpointNotes("");
    setMessage(`Saved ${label} as a per-session backend option.`);
  }

  return (
    <section
      className="mt-4 border-t border-border pt-3"
      aria-labelledby="local-models-heading"
    >
      <div className="flex items-center justify-between">
        <h2
          id="local-models-heading"
          className="font-semibold tracking-[0.12em] text-text"
        >
          KödLocal
        </h2>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded px-1.5 py-1 text-[10px] text-accent hover:bg-surface-hover"
        >
          {open ? "close" : "models…"}
        </button>
      </div>
      {!open && (
        <p className="mt-1 text-[10px] text-text-dim">
          Download, load, and chat with your own GGUF{isMac ? " or MLX" : ""}{" "}
          models.
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          <div className="rounded border border-border bg-bg p-2 text-[10px] text-text-dim">
            <div className="flex items-center justify-between gap-2">
              <span>daemon: {status?.running ? "running" : "stopped"}</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={busy}
                  className="text-accent hover:underline disabled:opacity-50"
                >
                  start / refresh
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void local
                      .stop()
                      .then(() => refresh(false))
                      .catch((error: unknown) =>
                        setMessage(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        ),
                      )
                  }
                  disabled={!status?.running || busy}
                  className="text-text-dim hover:text-text disabled:opacity-50"
                >
                  stop
                </button>
              </div>
            </div>
            {memory?.ramBudgetBytes !== undefined && (
              <p className="mt-1">
                Memory budget: {bytesLabel(memory.ramBudgetBytes)} · loaded:{" "}
                {bytesLabel(memory.loadedBytes)}
              </p>
            )}
            {status?.message && <p className="mt-1">{status.message}</p>}
          </div>

          <div className="rounded border border-border bg-bg p-2 text-[10px] text-text-dim">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-text">Saved backends</span>
              <span>
                {hasMultiBox
                  ? `${preferences.savedEndpoints.length} saved`
                  : "KödLocal Pro"}
              </span>
            </div>
            {!hasMultiBox ? (
              <p className="mt-1">
                Manual LAN/remote backend selection is a KödLocal Pro feature.
                This Mac&apos;s daemon remains available on the free tier.
              </p>
            ) : (
              <>
                <p className="mt-1">
                  Pick one when starting KödLocal. A non-local backend receives
                  your prompts, project context, and any enabled agent requests.
                </p>
                <div className="mt-2 space-y-1">
                  <input
                    aria-label="Backend label"
                    value={endpointLabel}
                    onChange={(event) => setEndpointLabel(event.target.value)}
                    placeholder="Studio Mac"
                    className="w-full rounded border border-border bg-surface px-1.5 py-1 text-text"
                  />
                  <input
                    aria-label="Backend URL"
                    value={endpointURL}
                    onChange={(event) => setEndpointURL(event.target.value)}
                    placeholder="https://lan-box.example/v1"
                    className="w-full rounded border border-border bg-surface px-1.5 py-1 text-text"
                  />
                  <input
                    aria-label="Backend notes"
                    value={endpointNotes}
                    onChange={(event) => setEndpointNotes(event.target.value)}
                    placeholder="Optional note"
                    className="w-full rounded border border-border bg-surface px-1.5 py-1 text-text"
                  />
                  <button
                    type="button"
                    onClick={addEndpoint}
                    className="text-accent hover:underline"
                  >
                    save backend
                  </button>
                </div>
                <p className="mt-1">
                  API keys are not stored here: Ködade has no secure secret
                  store yet, so endpoint credentials are intentionally excluded
                  from plaintext settings.
                </p>
                {localBackendOptions(preferences, true)
                  .filter((endpoint) => !endpoint.local)
                  .map((endpoint) => (
                    <div
                      key={endpoint.id}
                      className="mt-1 flex items-center gap-1"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {endpoint.label} · {endpoint.baseURL}
                        {endpoint.notes ? ` · ${endpoint.notes}` : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          updatePreferences({
                            savedEndpoints: preferences.savedEndpoints.filter(
                              (item) => item.id !== endpoint.id,
                            ),
                          })
                        }
                        className="hover:text-text"
                      >
                        remove
                      </button>
                    </div>
                  ))}
              </>
            )}
          </div>

          <label className="block text-[10px] text-text-dim">
            Context length
            <input
              type="number"
              min="256"
              max="2097152"
              value={preferences.contextLength}
              onChange={(event) =>
                updatePreferences({
                  contextLength: Number(event.target.value) || 4096,
                })
              }
              className="mt-1 w-full rounded border border-border bg-bg px-1.5 py-1 text-text"
            />
          </label>

          {CURATED_LOCAL_MODELS.map((model) => {
            const downloaded = preferences.downloadedModelIds.includes(
              model.id,
            );
            const estimate = estimateModelMemory(
              model,
              preferences.contextLength,
            );
            return (
              <div
                key={model.id}
                className="rounded border border-border p-2 text-[10px]"
              >
                <p className="font-semibold text-text">
                  {model.label} ·{" "}
                  <span className="rounded border border-border px-1 text-[9px]">
                    GGUF
                  </span>{" "}
                  · {model.paramsBillions}B · {model.quant}
                </p>
                <p className="mt-0.5 text-text-dim">
                  Catalog context: {model.contextLength.toLocaleString()} tokens
                </p>
                <p className="mt-0.5 text-text-dim">
                  {bytesLabel(model.bytes)} · {model.ramEstimate}
                </p>
                <p className="mt-0.5 text-text-dim">
                  At this context: about {bytesLabel(estimate.totalBytes)}.{" "}
                  {model.honesty}
                </p>
                {model.speed.map((band) => (
                  <p key={band.hardware} className="mt-0.5 text-text-dim">
                    {band.hardware}: {band.tokensPerSecond}. {band.note}
                  </p>
                ))}
                <div className="mt-1 flex gap-2">
                  {!downloaded ? (
                    <button
                      type="button"
                      onClick={() => void downloadModel(model)}
                      disabled={busy}
                      className="text-accent hover:underline disabled:opacity-50"
                    >
                      {download?.id === model.id
                        ? `downloading ${download.total ? `${Math.round((download.downloaded / download.total) * 100)}%` : "…"}`
                        : "download + verify"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void loadCurated(model)}
                      disabled={busy}
                      className="text-accent hover:underline disabled:opacity-50"
                    >
                      load
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <div className="rounded border border-border p-2 text-[10px]">
            <p className="font-semibold text-text">Add your own model</p>
            <div className="mt-1 flex gap-1">
              <input
                value={customPath}
                onChange={(event) => setCustomPath(event.target.value)}
                placeholder={
                  isMac
                    ? "/path/model.gguf or /path/mlx-model"
                    : "C:\\path\\model.gguf"
                }
                className="min-w-0 flex-1 rounded border border-border bg-bg px-1.5 py-1 text-text"
              />
              <button
                type="button"
                onClick={() => void addCustom()}
                className="text-accent hover:underline"
              >
                add
              </button>
            </div>
            {isMac ? (
              <p className="mt-1 text-text-dim">
                MLX directories need <code>mlx-lm</code>. If it is not
                installed, run <code>pip install mlx-lm</code>; Ködade never
                installs Python packages automatically.
              </p>
            ) : (
              <p className="mt-1 text-text-dim">
                MLX custom models are available only on macOS. Use a GGUF model
                on this platform.
              </p>
            )}
            {preferences.customModels.map((model) => (
              <div
                key={model.id}
                className="mt-1 flex items-center gap-1 text-text-dim"
              >
                <span className="min-w-0 flex-1 truncate">
                  {model.label}{" "}
                  <span className="rounded border border-border px-1 text-[9px]">
                    {model.format.toUpperCase()}
                  </span>
                  {model.format === "mlx" &&
                    " · no constrained tool-calling (chat + Pro loop degraded mode)"}
                </span>
                <button
                  type="button"
                  onClick={() => void loadCustom(model)}
                  disabled={
                    busy ||
                    localModelPlatformMessage(model.format, isMac) !== null
                  }
                  className="text-accent hover:underline disabled:opacity-50"
                >
                  load
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updatePreferences({
                      customModels: preferences.customModels.filter(
                        (item) => item.id !== model.id,
                      ),
                    })
                  }
                  disabled={busy}
                  className="hover:text-text disabled:opacity-50"
                >
                  remove
                </button>
              </div>
            ))}
          </div>

          {memory?.loadedModels[0] && (
            <div className="flex items-center justify-between rounded border border-border px-2 py-1 text-[10px] text-text-dim">
              <span className="truncate">
                loaded:{" "}
                {memory.loadedModels[0].name ?? memory.loadedModels[0].id}
              </span>
              <button
                type="button"
                onClick={() => void unload()}
                disabled={busy}
                className="text-accent hover:underline disabled:opacity-50"
              >
                unload
              </button>
            </div>
          )}
          {message && (
            <p
              role="status"
              className="rounded border border-border bg-bg px-2 py-1.5 text-[10px] text-text-dim"
            >
              {message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
