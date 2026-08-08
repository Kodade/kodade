import { describe, expect, it, vi } from "vitest";
import { InferenceBackendError, OpenAIHttpBackend, type ChatDelta } from "./backend";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}

describe("OpenAIHttpBackend", () => {
  it("assembles split SSE frames and preserves OpenAI delta fields", async () => {
    const fetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"id":"chat-1","model":"local","choices":[{"delta":{"role":"assistant","reasoning":"Think ","content":"Hel"},"finish_reason":null}]}\n',
        '\ndata: {"id":"chat-1","model":"local","choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"p"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chat-1","model":"local","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ]),
    );
    const backend = new OpenAIHttpBackend({ baseURL: "http://127.0.0.1:4470", fetch });

    const deltas = await collect(
      backend.chat({ model: "local", messages: [{ role: "user", content: "hi" }] }),
    );

    expect(deltas).toEqual([
      {
        id: "chat-1",
        model: "local",
        role: "assistant",
        content: "Hel",
        reasoning: "Think ",
      },
      {
        id: "chat-1",
        model: "local",
        content: "lo",
        toolCalls: [
          {
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: '{"p' },
          },
        ],
      },
      { id: "chat-1", model: "local", finishReason: "stop" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4470/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "local",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );
  });

  it("parses CRLF frames split across fetch chunks", async () => {
    const fetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\r',
        "\n\r",
        "\ndata: [DONE]\r\n\r\n",
      ]),
    );
    const backend = new OpenAIHttpBackend({ baseURL: "http://localhost:4470", fetch });

    await expect(
      collect(backend.chat({ messages: [{ role: "user", content: "hi" }] })),
    ).resolves.toEqual([{ content: "hi" }]);
  });

  it("cancels the SSE reader when a consumer stops early", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n'),
        );
      },
      cancel,
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    const backend = new OpenAIHttpBackend({ baseURL: "http://localhost:4470", fetch });

    for await (const _delta of backend.chat({ messages: [{ role: "user", content: "hi" }] })) {
      break;
    }

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves AbortError when the request is aborted before its first token", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal === controller.signal && controller.signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      throw new Error("abort signal was not passed to fetch");
    });
    const backend = new OpenAIHttpBackend({ baseURL: "http://localhost:4470", fetch });

    await expect(
      collect(
        backend.chat(
          { messages: [{ role: "user", content: "hi" }] },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns a non-stream completion and sends remote authorization", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "chat-2",
        model: "remote-model",
        choices: [{ message: { role: "assistant", content: "remote ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
    const backend = new OpenAIHttpBackend({
      baseURL: "https://models.example.test/openai/v1/",
      apiKey: "secret",
      fetch,
    });

    await expect(
      backend.chatOnce({ messages: [{ role: "user", content: "ping" }] }),
    ).resolves.toMatchObject({
      id: "chat-2",
      content: "remote ok",
      finishReason: "stop",
      usage: { totalTokens: 5 },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://models.example.test/openai/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("composes clean API and Köd roots from a valid versioned base", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ supports: {} }));
    const backend = new OpenAIHttpBackend({
      baseURL: "https://models.example.test/openai/v1/",
      fetch,
    });

    await backend.listModels();
    await backend.capabilities();

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://models.example.test/openai/v1/models",
      "https://models.example.test/openai/kod/capabilities",
    ]);
  });

  it("passes Köd extensions through and surfaces constrained capability", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "qwen", object: "model", kod: { ctx: 4096, ctx_advisory: true, loaded: true, quant: "Q8_0" } }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ supports: { tools: false, grammar: true, constrained: true, embeddings: false } }),
      )
      .mockResolvedValueOnce(jsonResponse({ total_ram_bytes: 64, loaded_bytes: 32, loaded_models: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "qwen", metadata: { context_length: 2048, context_length_is_advisory: true } }))
      .mockResolvedValueOnce(jsonResponse({ unloaded: "qwen" }));
    const backend = new OpenAIHttpBackend({ baseURL: "http://localhost:4470/v1", fetch });

    await expect(backend.listModels()).resolves.toEqual([
      { id: "qwen", object: "model", ctx: 4096, ctxAdvisory: true, loaded: true, quant: "Q8_0" },
    ]);
    await expect(backend.capabilities()).resolves.toMatchObject({
      supports: { constrained: true },
    });
    await expect(backend.memoryReport()).resolves.toMatchObject({ totalRamBytes: 64 });
    await backend.loadModel({ path: "/models/qwen.gguf", ctx: 2048 });
    await backend.unloadModel("qwen");

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:4470/v1/models",
      "http://localhost:4470/kod/capabilities",
      "http://localhost:4470/kod/memory",
      "http://localhost:4470/kod/load",
      "http://localhost:4470/kod/unload",
    ]);
    expect(fetch.mock.calls[3][1]).toMatchObject({
      body: JSON.stringify({ path: "/models/qwen.gguf", ctx: 2048 }),
    });
    expect(fetch.mock.calls[4][1]).toMatchObject({ body: JSON.stringify({ id: "qwen" }) });
  });

  it("surfaces HTTP and malformed SSE failures with endpoint context", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "model is not loaded" } }, 409))
      .mockResolvedValueOnce(sseResponse(["data: not-json\n\n"]))
      .mockResolvedValueOnce(
        sseResponse(['data: {"error":{"message":"generation failed"}}\n\ndata: [DONE]\n\n']),
      );
    const backend = new OpenAIHttpBackend({ baseURL: "http://localhost:4470", fetch });

    await expect(backend.listModels()).rejects.toEqual(
      expect.objectContaining<Partial<InferenceBackendError>>({
        name: "InferenceBackendError",
        status: 409,
        message: "model is not loaded",
      }),
    );
    await expect(
      collect(backend.chat({ messages: [{ role: "user", content: "hi" }] })),
    ).rejects.toThrow("invalid SSE JSON from /v1/chat/completions");
    await expect(
      collect(backend.chat({ messages: [{ role: "user", content: "hi" }] })),
    ).rejects.toThrow("generation failed");
  });

  it("wraps transport failures with endpoint context", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    const backend = new OpenAIHttpBackend({ baseURL: "http://localhost:4470", fetch });

    await expect(backend.listModels()).rejects.toEqual(
      expect.objectContaining<Partial<InferenceBackendError>>({
        name: "InferenceBackendError",
        kind: "transport",
        endpoint: "/v1/models",
        message: "transport failed at /v1/models: network unavailable",
      }),
    );
  });
});
