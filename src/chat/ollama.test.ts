import { describe, expect, it, vi } from "vitest";
import {
  OLLAMA_BASE_URL,
  OLLAMA_UNAVAILABLE_MESSAGE,
  createOllamaChatRuntime,
} from "./ollama";
import {
  InferenceBackendError,
  OpenAIHttpBackend,
  type ChatDelta,
  type InferenceBackend,
} from "../inference/backend";

const messages = [{ role: "user" as const, content: "hello" }];

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function collect(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}

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

  it("parses Ollama's OpenAI-compatible model list, reasoning, and text fixtures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "qwen3:8b", object: "model" }] }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"id":"chat-1","model":"qwen3:8b","choices":[{"delta":{"role":"assistant","reasoning":"checking locally"},"finish_reason":null}]}\n\n',
          'data: {"id":"chat-1","model":"qwen3:8b","choices":[{"delta":{"content":"local answer"},"finish_reason":null}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
    const runtime = createOllamaChatRuntime({
      backend: new OpenAIHttpBackend({ baseURL: OLLAMA_BASE_URL, fetch }),
    });

    await expect(runtime.listModels()).resolves.toEqual([
      { id: "qwen3:8b", label: "qwen3:8b" },
    ]);
    await expect(
      collect(
        runtime.chat({
          model: "qwen3:8b",
          messages,
          signal: new AbortController().signal,
        }),
      ),
    ).resolves.toEqual([
      {
        id: "chat-1",
        model: "qwen3:8b",
        role: "assistant",
        reasoning: "checking locally",
      },
      { id: "chat-1", model: "qwen3:8b", content: "local answer" },
    ]);
  });

  it("surfaces deterministic malformed and server-error streaming fixtures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(["data: not-json\n\n"]))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"error":{"message":"model runner failed"}}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
    const runtime = createOllamaChatRuntime({
      backend: new OpenAIHttpBackend({ baseURL: OLLAMA_BASE_URL, fetch }),
    });

    await expect(
      collect(
        runtime.chat({
          model: "qwen3:8b",
          messages,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow("invalid SSE JSON");
    await expect(
      collect(
        runtime.chat({
          model: "qwen3:8b",
          messages,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow("model runner failed");
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
