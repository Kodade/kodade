// Ollama's public local-chat transport. It deliberately uses the reusable
// OpenAI-compatible HTTP seam, not KödLocal's daemon/settings/tool loop.

import {
  InferenceBackendError,
  OpenAIHttpBackend,
  type ChatDelta,
  type ChatMessage,
  type InferenceBackend,
  type InferenceModel,
} from "../inference/backend";

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
export const OLLAMA_UNAVAILABLE_MESSAGE =
  "Ollama is not running on this Mac. Install Ollama, start it, then pull a model.";

export type OllamaModel = { id: string; label: string };

export type OllamaChatRuntime = {
  listModels(): Promise<OllamaModel[]>;
  chat(input: {
    model: string;
    messages: ChatMessage[];
    signal: AbortSignal;
  }): AsyncIterable<ChatDelta>;
};

export function createOllamaChatRuntime(options: { backend?: InferenceBackend } = {}): OllamaChatRuntime {
  const backend = options.backend ?? new OpenAIHttpBackend({ baseURL: OLLAMA_BASE_URL });
  return {
    async listModels() {
      try {
        const models = await backend.listModels();
        return models.map(modelForPicker);
      } catch (error) {
        throw unavailableError(error);
      }
    },
    async *chat(input) {
      try {
        yield* backend.chat({ model: input.model, messages: input.messages }, { signal: input.signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw unavailableError(error);
      }
    },
  };
}

function modelForPicker(model: InferenceModel): OllamaModel {
  return { id: model.id, label: model.id };
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function unavailableError(error: unknown): Error {
  if (error instanceof InferenceBackendError && error.kind === "transport") {
    return new Error(OLLAMA_UNAVAILABLE_MESSAGE, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
