// KödChat's thread store (Zustand vanilla, headless-testable). Owns transcripts,
// run lifecycle, and per-thread persistence; every dependency is injected so
// tests drive it with the IPC mocks.
//
// One turn = one headless run. The run id is `<threadId>#<turn>` so a late exit
// from a cancelled turn can never be mistaken for the new one.
//
// Privacy boundary (load-bearing): transcript text never leaves this store.
// The `activity` hooks below receive ids and a short reason only — the same
// contract KödMem and the sidebar have always had.

import { createStore, type StoreApi } from "zustand/vanilla";
import {
  AVAILABLE_PROVIDERS,
  type ChatAccessLevel,
  type Provider,
  type ProviderModel,
} from "../providers/catalog";
import type { ChatMessage } from "../inference/backend";
import type { AgentStreamAdapter, AgentStreamEvent } from "../agents/contract";
import { adapterFor } from "../agents/registry";
import type { AgentIpc, StorageIpc, Unlisten } from "../ipc/contract";
import { buildRemoteAgentSpawn } from "../ssh/command";
import type { RemoteTarget } from "../ssh/model";
import {
  MAX_THREAD_ENTRIES,
  chatDocName,
  newThread,
  parsePersistedThread,
  titleFromMessage,
  toPersistedThread,
  type ChatEntry,
  type ChatThread,
} from "./model";
import {
  OLLAMA_UNAVAILABLE_MESSAGE,
  type OllamaChatRuntime,
  type OllamaModel,
} from "./ollama";

// Metadata-only hooks. Nothing here carries message, tool, or output text.
export type ChatActivityHooks = {
  // The thread produced output (drives the "working" pulse).
  streamed?(projectId: string, threadId: string): void;
  // The thread wants the user: a question, an auth failure, or a finished turn.
  attention?(projectId: string, threadId: string, reason: string | null): void;
};

export type ChatDeps = {
  agent: AgentIpc;
  storage: StorageIpc;
  // Resolve a thread's project root at send time (projects are renameable and
  // removable, so this is read fresh rather than copied into the thread).
  projectRoot(projectId: string): string | null;
  // Bounded KödMem context for local projects. Failures are non-fatal: chat
  // still runs without memory when the local index cannot be read.
  memoryContext?(projectRoot: string): Promise<string | null>;
  // A pinned target makes this a remote project. The adapter still constructs
  // the provider argv; this store wraps it in a direct OpenSSH spawn.
  remoteTarget?(projectId: string): RemoteTarget | null;
  adapters?: (providerId: string) => AgentStreamAdapter | null;
  providers?: readonly Provider[];
  // Ollama is a public, local HTTP chat provider. It never enters KödLocal's
  // tool loop and intentionally has no native server-side session.
  ollama?: OllamaChatRuntime;
  newId?: () => string;
  now?: () => number;
  activity?: ChatActivityHooks;
  // Debounce for transcript writes. A streaming turn produces hundreds of
  // deltas; the disk should see one write per pause, not per token.
  persistDebounceMs?: number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  // A plugin-backed model command must never leave the picker loading forever.
  modelDiscoveryTimeoutMs?: number;
  modelDiscoverySetTimeout?: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  modelDiscoveryClearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
};

export type ProviderModelState = {
  status: "idle" | "loading" | "ready" | "unavailable";
  models: ProviderModel[];
  message: string | null;
};

export function providerModelKey(providerId: string, projectId?: string): string {
  return projectId ? `${projectId}::${providerId}` : providerId;
}

export type ChatState = {
  threads: Record<string, ChatThread>;
  // Threads whose transcript document has been read (or created), so opening a
  // thread twice doesn't re-read the disk.
  loaded: Record<string, boolean>;
  ollama: {
    status: "idle" | "loading" | "ready" | "unavailable";
    models: OllamaModel[];
    message: string | null;
  };
  // Dynamic CLI catalogs keyed by local project + provider. Ollama keeps its
  // separate service-health state because HTTP availability also gates send.
  providerModels: Record<string, ProviderModelState>;

  // Begin listening for run events. Idempotent; returns a teardown.
  start(): Promise<Unlisten>;
  // Register a thread the projects store already created, then load its
  // transcript from disk if it has one.
  openThread(threadId: string, projectId: string, providerId: string): Promise<void>;
  setProvider(threadId: string, providerId: string): void;
  // The thread's model pick (null = the CLI's default) and permission posture.
  setModel(threadId: string, model: string | null): void;
  setAccess(threadId: string, access: ChatAccessLevel): void;
  // The thread's thinking level (null = the CLI's default effort).
  setThinking(threadId: string, thinking: string | null): void;
  refreshOllama(): Promise<void>;
  refreshProviderModels(providerId: string, projectId?: string): Promise<void>;
  // Send one user message and run a turn. Resolves once the run has STARTED —
  // the answer arrives through the event stream.
  send(threadId: string, text: string): Promise<void>;
  cancel(threadId: string): Promise<void>;
  // Drop a thread and its transcript document (its session was closed).
  removeThread(threadId: string): Promise<void>;
  // Flush any pending debounced transcript write.
  flush(threadId: string): Promise<void>;
};

const DEFAULT_PERSIST_DEBOUNCE_MS = 400;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_MODEL_DISCOVERY_LINES = 2_048;
const MAX_MODEL_DISCOVERY_LINE_LENGTH = 512;
const MAX_DISCOVERED_MODELS = 512;
const MAX_CHAT_MEMORY_CHARS = 12_000;

function boundedMemory(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length <= MAX_CHAT_MEMORY_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_CHAT_MEMORY_CHARS - 1).trimEnd()}…`;
}

function promptWithMemory(prompt: string, memory: string | null): string {
  return memory
    ? `${memory}\n\n## Current request\n${prompt}`
    : prompt;
}

// OpenCode model output is plugin-influenced. Keep only bounded, plausible
// provider/model ids; logs, terminal decoration, duplicates, and oversized
// entries never become picker options (and therefore never become argv).
export function parseProviderModelLines(lines: readonly string[]): ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of lines.slice(0, MAX_MODEL_DISCOVERY_LINES)) {
    const id = raw
      .slice(0, MAX_MODEL_DISCOVERY_LINE_LENGTH + 1)
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .trim();
    if (
      id.length === 0 ||
      id.length > 255 ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\/[A-Za-z0-9~][A-Za-z0-9._:@+~/-]{0,189}$/.test(id) ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    models.push({ id, label: id });
    if (models.length === MAX_DISCOVERED_MODELS) break;
  }
  return models;
}

// `<threadId>#<turn>` — split back out when an event arrives.
function threadIdOfRun(runId: string): string {
  const hash = runId.lastIndexOf("#");
  return hash === -1 ? runId : runId.slice(0, hash);
}

export function createChatStore(deps: ChatDeps): StoreApi<ChatState> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  const adapters = deps.adapters ?? adapterFor;
  const providers = deps.providers ?? AVAILABLE_PROVIDERS;
  const setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle));
  const debounceMs = deps.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  const modelDiscoveryTimeoutMs =
    deps.modelDiscoveryTimeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
  const setModelDiscoveryTimer =
    deps.modelDiscoverySetTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearModelDiscoveryTimer =
    deps.modelDiscoveryClearTimeout ?? ((handle) => clearTimeout(handle));

  // Live run bookkeeping, outside React state: the current run id per thread,
  // its parser, and the id of the assistant entry deltas are appending to.
  type Run = {
    runId: string;
    parser?: ReturnType<AgentStreamAdapter["createParser"]>;
    abort?: () => void;
    // Adapter messageId → transcript entry id, so a multi-message turn renders
    // as separate bubbles and a `message-complete` replaces the right one.
    messageEntries: Map<string, string>;
    thinkingEntries: Map<string, string>;
    toolEntries: Map<string, string>;
    conversationId: number;
    turn: number;
  };
  const runs = new Map<string, Run>();
  const runByRunId = new Map<string, string>(); // runId → threadId
  const turns = new Map<string, number>();
  type ModelDiscoveryRun = {
    providerId: string;
    catalogKey: string;
    token: number;
    lines: string[];
    timeout: ReturnType<typeof setTimeout>;
    resolve(): void;
  };
  const modelDiscoveryRuns = new Map<string, ModelDiscoveryRun>();
  const modelDiscoveryTokens = new Map<string, number>();
  const modelRefreshes = new Map<string, Promise<void>>();
  let modelDiscoverySequence = 0;
  let ollamaRefreshToken = 0;

  // Per-thread debounced write handles, plus a chain so two writes for one
  // thread can never land out of order.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let writeChain: Promise<void> = Promise.resolve();

  const store = createStore<ChatState>((set, get) => {
    const persistNow = (threadId: string): Promise<void> => {
      const thread = get().threads[threadId];
      if (!thread) return Promise.resolve();
      const doc = JSON.stringify(toPersistedThread(thread));
      const run = async () => {
        try {
          await deps.storage.writeDoc(chatDocName(threadId), doc);
        } catch (error) {
          console.error(`kodade: KödChat transcript write failed (${threadId}):`, error);
        }
      };
      writeChain = writeChain.then(run);
      return writeChain;
    };

    const persistDebounced = (threadId: string) => {
      const existing = pending.get(threadId);
      if (existing) clearTimer(existing);
      pending.set(
        threadId,
        setTimer(() => {
          pending.delete(threadId);
          void persistNow(threadId);
        }, debounceMs),
      );
    };

    // Mutate one thread, stamping updatedAt. Missing threads are ignored — a
    // late event for a removed thread must not resurrect it.
    const patch = (threadId: string, change: (thread: ChatThread) => ChatThread) => {
      set((state) => {
        const thread = state.threads[threadId];
        if (!thread) return state;
        const next = change(thread);
        if (next === thread) return state;
        return {
          threads: {
            ...state.threads,
            [threadId]: { ...next, updatedAt: now() },
          },
        };
      });
    };

    const appendEntry = (threadId: string, entry: ChatEntry) => {
      patch(threadId, (thread) => ({
        ...thread,
        entries: [...thread.entries, entry].slice(-MAX_THREAD_ENTRIES),
      }));
    };

    const replaceEntry = (
      threadId: string,
      entryId: string,
      change: (entry: ChatEntry) => ChatEntry,
    ) => {
      patch(threadId, (thread) => ({
        ...thread,
        entries: thread.entries.map((entry) =>
          entry.id === entryId ? change(entry) : entry,
        ),
      }));
    };

    // Route one normalized adapter event into the transcript.
    const applyEvent = (threadId: string, run: Run, event: AgentStreamEvent) => {
      const thread = get().threads[threadId];
      if (!thread) return;
      switch (event.type) {
        case "session":
          patch(threadId, (current) => ({ ...current, resumeId: event.sessionId }));
          return;
        case "message-delta": {
          const existing = run.messageEntries.get(event.messageId);
          if (existing) {
            replaceEntry(threadId, existing, (entry) =>
              entry.kind === "message"
                ? { ...entry, text: entry.text + event.text }
                : entry,
            );
          } else {
            const id = newId();
            run.messageEntries.set(event.messageId, id);
            appendEntry(threadId, {
              kind: "message",
              id,
              role: "assistant",
              text: event.text,
              conversationId: run.conversationId,
              streaming: true,
            });
          }
          deps.activity?.streamed?.(thread.projectId, threadId);
          return;
        }
        case "message-complete": {
          const existing = run.messageEntries.get(event.messageId);
          if (existing) {
            replaceEntry(threadId, existing, (entry) =>
              entry.kind === "message"
                ? {
                    kind: "message",
                    id: entry.id,
                    role: "assistant",
                    text: event.message.content,
                    conversationId: entry.conversationId ?? run.conversationId,
                  }
                : entry,
            );
          } else {
            const id = newId();
            run.messageEntries.set(event.messageId, id);
            appendEntry(threadId, {
              kind: "message",
              id,
              role: "assistant",
              text: event.message.content,
              conversationId: run.conversationId,
            });
          }
          deps.activity?.streamed?.(thread.projectId, threadId);
          return;
        }
        case "thinking-delta": {
          const existing = run.thinkingEntries.get(event.messageId);
          if (existing) {
            replaceEntry(threadId, existing, (entry) =>
              entry.kind === "thinking" ? { ...entry, text: entry.text + event.text } : entry,
            );
          } else {
            const id = newId();
            run.thinkingEntries.set(event.messageId, id);
            appendEntry(threadId, { kind: "thinking", id, text: event.text });
          }
          return;
        }
        case "thinking-complete": {
          const existing = run.thinkingEntries.get(event.messageId);
          if (existing) {
            replaceEntry(threadId, existing, (entry) =>
              entry.kind === "thinking" ? { ...entry, text: event.text } : entry,
            );
          } else {
            const id = newId();
            run.thinkingEntries.set(event.messageId, id);
            appendEntry(threadId, { kind: "thinking", id, text: event.text });
          }
          return;
        }
        case "plan":
          appendEntry(threadId, { kind: "plan", id: newId(), items: event.items });
          return;
        case "tool-call-started": {
          const id = newId();
          run.toolEntries.set(event.callId, id);
          appendEntry(threadId, { kind: "tool", id, call: event.call, outcome: null });
          deps.activity?.streamed?.(thread.projectId, threadId);
          return;
        }
        case "tool-call-completed": {
          const entryId = run.toolEntries.get(event.callId);
          if (!entryId) return;
          replaceEntry(threadId, entryId, (entry) =>
            entry.kind === "tool" ? { ...entry, outcome: event.outcome } : entry,
          );
          return;
        }
        case "auth-error":
          appendEntry(threadId, {
            kind: "error",
            id: newId(),
            message: event.message,
            auth: true,
          });
          patch(threadId, (current) => ({ ...current, needsLogin: true }));
          deps.activity?.attention?.(thread.projectId, threadId, "needs login");
          return;
        case "error":
          appendEntry(threadId, { kind: "error", id: newId(), message: event.message });
          patch(threadId, (current) => ({ ...current, status: "error" }));
          deps.activity?.attention?.(thread.projectId, threadId, "the agent failed");
          return;
        case "done":
          settle(threadId, run);
          return;
      }
    };

    // Close out a run: freeze streaming entries, clear the run, persist.
    const settle = (threadId: string, run: Run) => {
      if (runs.get(threadId)?.runId !== run.runId) return;
      runs.delete(threadId);
      runByRunId.delete(run.runId);
      patch(threadId, (thread) => ({
        ...thread,
        status: thread.status === "error" ? "error" : "idle",
        entries: thread.entries.map((entry) =>
          entry.kind === "message" && entry.streaming
            ? {
                kind: "message",
                id: entry.id,
                role: entry.role,
                text: entry.text,
                conversationId: entry.conversationId,
              }
            : entry,
        ),
      }));
      const thread = get().threads[threadId];
      if (thread) {
        deps.activity?.attention?.(
          thread.projectId,
          threadId,
          thread.needsLogin ? "needs login" : null,
        );
      }
      void persistNow(threadId);
    };

    const onLine = (runId: string, line: string) => {
      const discovery = modelDiscoveryRuns.get(runId);
      if (discovery) {
        if (discovery.lines.length < MAX_MODEL_DISCOVERY_LINES) {
          discovery.lines.push(line.slice(0, MAX_MODEL_DISCOVERY_LINE_LENGTH + 1));
        }
        return;
      }
      const threadId = runByRunId.get(runId) ?? threadIdOfRun(runId);
      const run = runs.get(threadId);
      if (!run || run.runId !== runId) return; // a stale/cancelled turn
      if (!run.parser) return;
      for (const event of run.parser.line(line)) applyEvent(threadId, run, event);
      persistDebounced(threadId);
    };

    const onExit = (runId: string, code: number | null, stderr: string) => {
      const discovery = modelDiscoveryRuns.get(runId);
      if (discovery) {
        modelDiscoveryRuns.delete(runId);
        clearModelDiscoveryTimer(discovery.timeout);
        if (modelDiscoveryTokens.get(discovery.catalogKey) === discovery.token) {
          const provider = providers.find((entry) => entry.id === discovery.providerId);
          const models = code === 0 ? parseProviderModelLines(discovery.lines) : [];
          set((state) => ({
            providerModels: {
              ...state.providerModels,
              [discovery.catalogKey]: {
                status: code === 0 ? "ready" : "unavailable",
                models,
                message:
                  code === 0
                    ? models.length
                      ? null
                      : `${provider?.name ?? discovery.providerId} returned no models. Default still uses its configured model.`
                    : `Could not load ${provider?.name ?? discovery.providerId} models. Default still uses its configured model.`,
              },
            },
          }));
        }
        discovery.resolve();
        return;
      }
      const threadId = runByRunId.get(runId) ?? threadIdOfRun(runId);
      const run = runs.get(threadId);
      if (!run || run.runId !== runId) return;
      if (run.parser) {
        for (const event of run.parser.end(code, stderr)) applyEvent(threadId, run, event);
      }
      // `end` always yields a `done`, but settle defensively in case a future
      // adapter forgets: a thread must never be stuck "working".
      settle(threadId, run);
    };

    return {
      threads: {},
      loaded: {},
      ollama: { status: "idle", models: [], message: null },
      providerModels: {},

      async start(): Promise<Unlisten> {
        const offEvent = await deps.agent.onEvent((event) => onLine(event.id, event.line));
        const offExit = await deps.agent.onExit((event) =>
          onExit(event.id, event.code, event.stderr),
        );
        return () => {
          offEvent();
          offExit();
        };
      },

      async openThread(threadId: string, projectId: string, providerId: string) {
        if (!get().threads[threadId]) {
          set((state) => ({
            threads: {
              ...state.threads,
              [threadId]: newThread(threadId, projectId, providerId, now()),
            },
          }));
        }
        const remote = deps.remoteTarget?.(projectId) ?? null;
        if (providerId === "ollama") void get().refreshOllama();
        else if (providerFor(providerId)?.stream?.modelDiscovery)
          void get().refreshProviderModels(providerId, projectId);
        if (get().loaded[threadId]) return;
        set((state) => ({ loaded: { ...state.loaded, [threadId]: true } }));
        let raw: string | null = null;
        try {
          raw = await deps.storage.readDoc(chatDocName(threadId));
        } catch (error) {
          console.error(`kodade: KödChat transcript read failed (${threadId}):`, error);
          return;
        }
        if (!raw) return;
        const doc = parsePersistedThread(raw);
        if (!doc) return;
        const remoteDynamicModels =
          !!remote && !!providerFor(doc.providerId)?.stream?.modelDiscovery;
        patch(threadId, (thread) => ({
          ...thread,
          providerId: doc.providerId,
          title: doc.title,
          resumeId: doc.resumeId,
          conversationId: doc.conversationId,
          model: remoteDynamicModels ? null : doc.model,
          access: doc.access,
          thinking: doc.thinking,
          entries: doc.entries,
        }));
        if (doc.providerId === "ollama") void get().refreshOllama();
        else if (providerFor(doc.providerId)?.stream?.modelDiscovery)
          void get().refreshProviderModels(doc.providerId, projectId);
      },

      setProvider(threadId: string, providerId: string) {
        if (runs.has(threadId)) return;
        const projectId = get().threads[threadId]?.projectId;
        patch(threadId, (thread) =>
          thread.providerId === providerId
            ? thread
            : // A different CLI cannot resume the previous one's session (or
              // run its models or thinking levels), so switching provider
              // starts a fresh conversation on that CLI while keeping the
              // readable transcript.
              {
                ...thread,
                providerId,
                resumeId: null,
                conversationId: thread.conversationId + 1,
                model: null,
                thinking: null,
              },
        );
        if (providerId === "ollama") void get().refreshOllama();
        else if (providerFor(providerId)?.stream?.modelDiscovery)
          void get().refreshProviderModels(providerId, projectId);
        persistDebounced(threadId);
      },

      setModel(threadId: string, model: string | null) {
        if (runs.has(threadId)) return;
        patch(threadId, (thread) => {
          if (thread.model === model) return thread;
          return {
            ...thread,
            model,
            // Ollama has no native session id. A new model therefore starts
            // a fresh client-side conversation while the transcript remains.
            conversationId:
              thread.providerId === "ollama"
                ? thread.conversationId + 1
                : thread.conversationId,
          };
        });
        persistDebounced(threadId);
      },

      setAccess(threadId: string, access: ChatAccessLevel) {
        if (runs.has(threadId)) return;
        patch(threadId, (thread) =>
          thread.access === access ? thread : { ...thread, access },
        );
        persistDebounced(threadId);
      },

      setThinking(threadId: string, thinking: string | null) {
        if (runs.has(threadId)) return;
        patch(threadId, (thread) =>
          thread.thinking === thinking ? thread : { ...thread, thinking },
        );
        persistDebounced(threadId);
      },

      async refreshOllama() {
        if (!deps.ollama) return;
        const refreshToken = ++ollamaRefreshToken;
        set((state) => ({ ollama: { ...state.ollama, status: "loading", message: null } }));
        try {
          const models = await deps.ollama.listModels();
          if (refreshToken !== ollamaRefreshToken) return;
          const available = new Set(models.map((model) => model.id));
          const staleThreadIds = Object.values(get().threads)
            .filter(
              (thread) =>
                thread.providerId === "ollama" &&
                thread.status !== "working" &&
                thread.model !== null &&
                !available.has(thread.model),
            )
            .map((thread) => thread.id);
          set((state) => ({
            ollama: {
              status: "ready",
              models,
              message: models.length ? null : "Ollama is running, but no local models are installed yet.",
            },
            threads: Object.fromEntries(
              Object.entries(state.threads).map(([id, thread]) => [
                id,
                staleThreadIds.includes(id)
                  ? {
                      ...thread,
                      model: null,
                      conversationId: thread.conversationId + 1,
                      updatedAt: now(),
                    }
                  : thread,
              ]),
            ),
          }));
          for (const threadId of staleThreadIds) persistDebounced(threadId);
        } catch (error) {
          if (refreshToken !== ollamaRefreshToken) return;
          set({
            ollama: {
              status: "unavailable",
              models: [],
              message:
                error instanceof Error && error.message
                  ? error.message
                  : OLLAMA_UNAVAILABLE_MESSAGE,
            },
          });
        }
      },

      async refreshProviderModels(providerId: string, projectId?: string) {
        // Model ids are host-specific. Local discovery must never populate a
        // remote thread's picker; remote OpenCode stays Default-only.
        if (projectId && deps.remoteTarget?.(projectId)) return;
        const provider = providerFor(providerId);
        const discovery = provider?.stream?.modelDiscovery;
        if (!provider || !discovery) return;
        const catalogKey = providerModelKey(providerId, projectId);
        const inFlight = modelRefreshes.get(catalogKey);
        if (inFlight) return inFlight;

        const token = (modelDiscoveryTokens.get(catalogKey) ?? 0) + 1;
        modelDiscoveryTokens.set(catalogKey, token);
        const runId = `provider-models:${providerId}#${++modelDiscoverySequence}`;
        set((state) => ({
          providerModels: {
            ...state.providerModels,
            [catalogKey]: {
              status: "loading",
              models: state.providerModels[catalogKey]?.models ?? [],
              message: null,
            },
          },
        }));

        const refresh = new Promise<void>((resolve) => {
          const timeout = setModelDiscoveryTimer(() => {
            const active = modelDiscoveryRuns.get(runId);
            if (!active) return;
            modelDiscoveryRuns.delete(runId);
            if (modelDiscoveryTokens.get(catalogKey) === token) {
              set((state) => ({
                providerModels: {
                  ...state.providerModels,
                  [catalogKey]: {
                    status: "unavailable",
                    models: [],
                    message: `Could not load ${provider.name} models. Default still uses its configured model.`,
                  },
                },
              }));
            }
            void deps.agent.cancel({ id: runId }).catch(() => undefined);
            resolve();
          }, modelDiscoveryTimeoutMs);
          modelDiscoveryRuns.set(runId, {
            providerId,
            catalogKey,
            token,
            lines: [],
            timeout,
            resolve,
          });
          void deps.agent
            .start({
              id: runId,
              cwd: projectId ? (deps.projectRoot(projectId) ?? "") : "",
              bin: provider.bin,
              args: [...discovery.args],
              // This is a bounded read-only command, not an interactive run.
              // Explicit empty stdin makes Rust close the pipe immediately.
              stdin: "",
            })
            .catch(() => {
              const active = modelDiscoveryRuns.get(runId);
              if (active) clearModelDiscoveryTimer(active.timeout);
              modelDiscoveryRuns.delete(runId);
              if (modelDiscoveryTokens.get(catalogKey) === token) {
                set((state) => ({
                  providerModels: {
                    ...state.providerModels,
                    [catalogKey]: {
                      status: "unavailable",
                      models: [],
                      message: `Could not load ${provider.name} models. Default still uses its configured model.`,
                    },
                  },
                }));
              }
              resolve();
            });
        });
        modelRefreshes.set(catalogKey, refresh);
        try {
          await refresh;
        } finally {
          if (modelRefreshes.get(catalogKey) === refresh)
            modelRefreshes.delete(catalogKey);
        }
      },

      async send(threadId: string, text: string) {
        const prompt = text.trim();
        if (!prompt) return;
        const thread = get().threads[threadId];
        if (!thread || runs.has(threadId)) return;
        let projectMemory: string | null = null;
        const localRoot = deps.projectRoot(thread.projectId);
        if (localRoot && deps.memoryContext) {
          try {
            projectMemory = boundedMemory(await deps.memoryContext(localRoot));
          } catch {
            projectMemory = null;
          }
          if (!get().threads[threadId] || runs.has(threadId)) return;
        }

        if (thread.providerId === "ollama") {
          const runtime = deps.ollama;
          if (!runtime) {
            appendEntry(threadId, { kind: "error", id: newId(), message: OLLAMA_UNAVAILABLE_MESSAGE });
            void persistNow(threadId);
            return;
          }
          if (get().ollama.status !== "ready") await get().refreshOllama();
          const current = get().threads[threadId];
          if (!current) return;
          const availableModels = get().ollama.models;
          const selectedModelAvailable =
            current.model !== null &&
            availableModels.some((candidate) => candidate.id === current.model);
          const model = selectedModelAvailable
            ? current.model!
            : availableModels[0]?.id;
          if (!model) {
            appendEntry(threadId, {
              kind: "error",
              id: newId(),
              message: get().ollama.message ?? "Choose or install an Ollama model, then try again.",
            });
            void persistNow(threadId);
            return;
          }
          const conversationId =
            current.model !== null && current.model !== model
              ? current.conversationId + 1
              : current.conversationId;
          if (current.model !== model) {
            patch(threadId, (entry) => ({ ...entry, model, conversationId }));
          }
          const turn = (turns.get(threadId) ?? 0) + 1;
          turns.set(threadId, turn);
          const runId = `${threadId}#${turn}`;
          const controller = new AbortController();
          const run: Run = {
            runId,
            abort: () => controller.abort(),
            messageEntries: new Map(),
            thinkingEntries: new Map(),
            toolEntries: new Map(),
            conversationId,
            turn,
          };
          runs.set(threadId, run);
          runByRunId.set(runId, threadId);
          const firstMessage = !current.entries.some((entry) => entry.kind === "message");
          appendEntry(threadId, {
            kind: "message",
            id: newId(),
            role: "user",
            text: prompt,
            conversationId,
          });
          patch(threadId, (entry) => ({
            ...entry,
            status: "working",
            needsLogin: false,
            title: firstMessage ? titleFromMessage(prompt) : entry.title,
          }));
          deps.activity?.attention?.(current.projectId, threadId, null);
          deps.activity?.streamed?.(current.projectId, threadId);
          void persistNow(threadId);
          void streamOllama({
            threadId,
            run,
            runtime,
            model,
            controller,
            memoryContext: projectMemory,
          });
          return;
        }

        const adapter = adapters(thread.providerId);
        if (!adapter) {
          appendEntry(threadId, {
            kind: "error",
            id: newId(),
            message: `${thread.providerId} is not yet supported in KödChat. Open a terminal to use it.`,
          });
          void persistNow(threadId);
          return;
        }
        const remoteTarget = deps.remoteTarget?.(thread.projectId) ?? null;
        const projectRoot = localRoot;
        if (projectRoot === null && remoteTarget === null) return;
        const cwd = remoteTarget ? "" : projectRoot!;

        const turn = (turns.get(threadId) ?? 0) + 1;
        turns.set(threadId, turn);
        const runId = `${threadId}#${turn}`;
        const run: Run = {
          runId,
          parser: adapter.createParser(),
          messageEntries: new Map(),
          thinkingEntries: new Map(),
          toolEntries: new Map(),
          conversationId: thread.conversationId,
          turn,
        };
        runs.set(threadId, run);
        runByRunId.set(runId, threadId);

        // The first message names the thread; read that BEFORE appending it.
        const firstMessage = !thread.entries.some((entry) => entry.kind === "message");
        appendEntry(threadId, {
          kind: "message",
          id: newId(),
          role: "user",
          text: prompt,
          conversationId: thread.conversationId,
        });
        patch(threadId, (current) => ({
          ...current,
          status: "working",
          needsLogin: false,
          title: firstMessage ? titleFromMessage(prompt) : current.title,
        }));
        deps.activity?.attention?.(thread.projectId, threadId, null);
        deps.activity?.streamed?.(thread.projectId, threadId);
        void persistNow(threadId);

        const spawn = adapter.spawn({
          prompt: promptWithMemory(prompt, projectMemory),
          cwd: remoteTarget?.path ?? projectRoot!,
          resumeId: thread.resumeId,
          model: thread.model,
          access: thread.access,
          thinking: thread.thinking,
        });
        const process = remoteTarget
          ? buildRemoteAgentSpawn(remoteTarget, spawn.bin, spawn.args)
          : spawn;
        try {
          await deps.agent.start({
            id: runId,
            cwd,
            bin: process.bin,
            args: process.args,
            ...(spawn.stdin === undefined ? {} : { stdin: spawn.stdin }),
          });
        } catch (error) {
          // The CLI is missing, or the run id collided. Report it in the
          // transcript and settle so the composer becomes usable again.
          applyEvent(threadId, run, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          settle(threadId, run);
        }
      },

      async cancel(threadId: string) {
        const run = runs.get(threadId);
        if (!run) return;
        if (run.abort) {
          run.abort();
        } else {
          try {
            await deps.agent.cancel({ id: run.runId });
          } catch (error) {
            console.error(`kodade: KödChat cancel failed (${threadId}):`, error);
          }
        }
        // The exit event still arrives and settles the thread; note the stop so
        // a cancelled turn doesn't look like it simply produced nothing.
        appendEntry(threadId, { kind: "error", id: newId(), message: "Stopped." });
        if (run.abort) settle(threadId, run);
      },

      async removeThread(threadId: string) {
        const handle = pending.get(threadId);
        if (handle) {
          clearTimer(handle);
          pending.delete(threadId);
        }
        const run = runs.get(threadId);
        if (run) {
          runs.delete(threadId);
          runByRunId.delete(run.runId);
          if (run.abort) {
            run.abort();
          } else {
            try {
              await deps.agent.cancel({ id: run.runId });
            } catch {
              // Already gone: removal must still complete.
            }
          }
        }
        turns.delete(threadId);
        set((state) => {
          const threads = { ...state.threads };
          const loaded = { ...state.loaded };
          delete threads[threadId];
          delete loaded[threadId];
          return { threads, loaded };
        });
        try {
          await deps.storage.deleteDoc(chatDocName(threadId));
        } catch (error) {
          console.error(`kodade: KödChat transcript delete failed (${threadId}):`, error);
        }
      },

      async flush(threadId: string) {
        const handle = pending.get(threadId);
        if (handle) {
          clearTimer(handle);
          pending.delete(threadId);
        }
        await persistNow(threadId);
      },
    };

    async function streamOllama(input: {
      threadId: string;
      run: Run;
      runtime: OllamaChatRuntime;
      model: string;
      controller: AbortController;
      memoryContext: string | null;
    }) {
      const thread = get().threads[input.threadId];
      if (!thread) return;
      const history: ChatMessage[] = thread.entries
        .filter((entry): entry is Extract<ChatEntry, { kind: "message" }> => entry.kind === "message")
        .filter((entry) => (entry.conversationId ?? 0) === thread.conversationId)
        .filter((entry) => entry.role === "user" || entry.role === "assistant")
        .map((entry) => ({ role: entry.role, content: entry.text }));
      const messages: ChatMessage[] = input.memoryContext
        ? [{ role: "system", content: input.memoryContext }, ...history]
        : history;
      try {
        for await (const delta of input.runtime.chat({
          model: input.model,
          messages,
          signal: input.controller.signal,
        })) {
          if (runs.get(input.threadId)?.runId !== input.run.runId) return;
          if (delta.reasoning) {
            applyEvent(input.threadId, input.run, {
              type: "thinking-delta",
              messageId: `ollama-thinking-${input.run.runId}`,
              text: delta.reasoning,
            });
          }
          if (delta.content) {
            applyEvent(input.threadId, input.run, {
              type: "message-delta",
              messageId: `ollama-message-${input.run.runId}`,
              text: delta.content,
            });
          }
        }
      } catch (error) {
        if (!input.controller.signal.aborted && runs.get(input.threadId)?.runId === input.run.runId) {
          applyEvent(input.threadId, input.run, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (runs.get(input.threadId)?.runId === input.run.runId) settle(input.threadId, input.run);
      }
    }

    function providerFor(providerId: string): Provider | undefined {
      return providers.find((provider) => provider.id === providerId);
    }
  });

  return store;
}
