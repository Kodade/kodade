import { describe, expect, it } from "vitest";
import {
  OLLAMA_UNAVAILABLE_MESSAGE,
  createOllamaChatRuntime,
} from "./ollama";
import { InferenceBackendError, type InferenceBackend } from "../local/backend";

const messages = [{ role: "user" as const, content: "hello" }];

describe("Ollama local chat runtime", () => {
  it("discovers models dynamically and forwards a streaming chat with AbortSignal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const backend: InferenceBackend = {
      async listModels() {
        return [{ id: "qwen3:8b", object: "model" }];
      },
      async *chat(_request, options) {
        receivedSignal = options?.signal;
        yield { reasoning: "checking" };
        yield { content: "hello" };
      },
      async chatOnce() {
        throw new Error("not used");
      },
    };
    const runtime = createOllamaChatRuntime({ backend });
    await expect(runtime.listModels()).resolves.toEqual([{ id: "qwen3:8b", label: "qwen3:8b" }]);
    const controller = new AbortController();
    const deltas = [];
    for await (const delta of runtime.chat({ model: "qwen3:8b", messages, signal: controller.signal })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual([{ reasoning: "checking" }, { content: "hello" }]);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("turns a loopback transport failure into an actionable start/install state", async () => {
    const backend: InferenceBackend = {
      async listModels() {
        throw new InferenceBackendError("refused", undefined, "/v1/models", "transport");
      },
      async *chat() {},
      async chatOnce() {
        throw new Error("not used");
      },
    };
    await expect(createOllamaChatRuntime({ backend }).listModels()).rejects.toThrow(
      OLLAMA_UNAVAILABLE_MESSAGE,
    );
  });
});
