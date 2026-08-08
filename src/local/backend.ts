// KödLocal's loop-facing inference seam. The same HTTP implementation speaks
// to loopback kodade-modeld or a remote OpenAI-compatible base URL.

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type JsonSchemaResponseFormat = {
  type: "json_schema";
  jsonSchema: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
};

export type ChatRequest = {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  tools?: ChatTool[];
  toolChoice?: unknown;
  responseFormat?: JsonSchemaResponseFormat;
  kodGrammar?: string;
};

export type ToolCallDelta = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type ChatDelta = {
  id?: string;
  model?: string;
  role?: string;
  content?: string;
  // OpenAI-compatible servers such as Ollama may stream reasoning separately
  // from visible content. Keeping it generic lets chat-only providers reuse
  // this transport without borrowing KödLocal's tool runtime.
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  finishReason?: string;
  // modeld includes this on its final streaming delta so terminal and manager
  // surfaces can report measured decode speed rather than a marketing guess.
  tokensPerSecond?: number;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ChatResponse = {
  id: string;
  model?: string;
  role: string;
  content: string;
  toolCalls?: ToolCallDelta[];
  finishReason?: string;
  usage?: TokenUsage;
  tokensPerSecond?: number;
};

export type InferenceModel = {
  id: string;
  object: string;
  ownedBy?: string;
  ctx?: number;
  ctxAdvisory?: boolean;
  loaded?: boolean;
  quant?: string;
};

export type InferenceSupports = {
  tools: boolean;
  grammar: boolean;
  constrained: boolean;
  embeddings: boolean;
};

export type BackendCapabilities = {
  engine?: string;
  formats?: string[];
  supports: InferenceSupports;
  ramBudgetBytes?: number;
};

export type LoadedModel = {
  id: string;
  name?: string;
  path?: string;
  metadata?: {
    contextLength?: number;
    contextLengthIsAdvisory?: boolean;
    quant?: string;
    architecture?: string;
  };
  footprintBytes?: number;
};

export type MemoryReport = {
  totalRamBytes?: number;
  ramBudgetBytes?: number;
  loadedBytes: number;
  loadedModels: LoadedModel[];
};

export interface InferenceBackend {
  chat(request: ChatRequest, options?: ChatRequestOptions): AsyncIterable<ChatDelta>;
  chatOnce(request: ChatRequest, options?: ChatRequestOptions): Promise<ChatResponse>;
  listModels(): Promise<InferenceModel[]>;
  capabilities?(): Promise<BackendCapabilities>;
  memoryReport?(): Promise<MemoryReport>;
  loadModel?(request: { path: string; ctx?: number }): Promise<LoadedModel>;
  unloadModel?(id: string): Promise<void>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ChatRequestOptions = {
  signal?: AbortSignal;
};

export type OpenAIHttpBackendOptions = {
  baseURL: string;
  apiKey?: string;
  fetch?: FetchLike;
};

export class InferenceBackendError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly endpoint?: string,
    public readonly kind?: "transport",
  ) {
    super(message);
    this.name = "InferenceBackendError";
  }
}

type OpenAIChunk = {
  id?: string;
  model?: string;
  error?: { message?: string } | string;
  choices?: Array<{
      delta?: {
      role?: string;
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  kod?: { tokens_per_second?: number };
};

type OpenAICompletion = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  kod?: { tokens_per_second?: number };
};

function endpointRoots(baseURL: string): { api: string; root: string } {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (/\/v1$/i.test(trimmed)) {
    return { api: trimmed, root: trimmed.slice(0, -3) };
  }
  return { api: `${trimmed}/v1`, root: trimmed };
}

function requestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
  }));
  return {
    ...(request.model === undefined ? {} : { model: request.model }),
    messages,
    stream,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
    ...(request.kodGrammar === undefined ? {} : { kod_grammar: request.kodGrammar }),
    ...(request.responseFormat === undefined
      ? {}
      : {
          response_format: {
            type: request.responseFormat.type,
            json_schema: {
              name: request.responseFormat.jsonSchema.name,
              schema: request.responseFormat.jsonSchema.schema,
              ...(request.responseFormat.jsonSchema.strict === undefined
                ? {}
                : { strict: request.responseFormat.jsonSchema.strict }),
            },
          },
        }),
  };
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    if (typeof error === "string") return error;
  }
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function transportMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown transport error";
}

function sseBoundary(buffer: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

export class OpenAIHttpBackend implements InferenceBackend {
  private readonly apiURL: string;
  private readonly rootURL: string;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;

  constructor(options: OpenAIHttpBackendOptions) {
    const roots = endpointRoots(options.baseURL);
    this.apiURL = roots.api;
    this.rootURL = roots.root;
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.headers = {
      "content-type": "application/json",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    };
  }

  async *chat(request: ChatRequest, options?: ChatRequestOptions): AsyncIterable<ChatDelta> {
    const endpoint = "/v1/chat/completions";
    const response = await this.fetchResponse(
      `${this.apiURL}/chat/completions`,
      endpoint,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(requestBody(request, true)),
        signal: options?.signal,
      },
    );
    await this.assertOk(response, endpoint);
    if (!response.body) {
      throw new InferenceBackendError(`empty SSE body from ${endpoint}`, response.status, endpoint);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let readerDone = false;
    let failed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = sseBoundary(buffer);
        while (boundary) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const delta = this.parseSseEvent(event, endpoint);
          if (delta === "done") return;
          if (delta) yield delta;
          boundary = sseBoundary(buffer);
        }
        if (done) {
          readerDone = true;
          break;
        }
      }
      if (buffer.trim()) {
        const delta = this.parseSseEvent(buffer, endpoint);
        if (delta && delta !== "done") yield delta;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (!readerDone) await reader.cancel();
      } catch (error) {
        if (!failed) throw error;
      } finally {
        reader.releaseLock();
      }
    }
  }

  async chatOnce(
    request: ChatRequest,
    options?: ChatRequestOptions,
  ): Promise<ChatResponse> {
    const payload = await this.postJson<OpenAICompletion>(
      "/v1/chat/completions",
      requestBody(request, false),
      options,
    );
    const choice = payload.choices?.[0];
    return {
      id: payload.id ?? "",
      ...(payload.model === undefined ? {} : { model: payload.model }),
      role: choice?.message?.role ?? "assistant",
      content: choice?.message?.content ?? "",
      ...(choice?.message?.tool_calls === undefined
        ? {}
        : { toolCalls: choice.message.tool_calls }),
      ...(choice?.finish_reason == null ? {} : { finishReason: choice.finish_reason }),
      ...(payload.usage
        ? {
            usage: {
              promptTokens: payload.usage.prompt_tokens ?? 0,
              completionTokens: payload.usage.completion_tokens ?? 0,
              totalTokens: payload.usage.total_tokens ?? 0,
            },
          }
        : {}),
      ...(payload.kod?.tokens_per_second === undefined
        ? {}
        : { tokensPerSecond: payload.kod.tokens_per_second }),
    };
  }

  async listModels(): Promise<InferenceModel[]> {
    const payload = await this.getJson<{
      data?: Array<{
        id: string;
        object?: string;
        owned_by?: string;
        kod?: { ctx?: number; ctx_advisory?: boolean; loaded?: boolean; quant?: string };
      }>;
    }>("/v1/models");
    return (payload.data ?? []).map((model) => ({
      id: model.id,
      object: model.object ?? "model",
      ...(model.owned_by === undefined ? {} : { ownedBy: model.owned_by }),
      ...(model.kod?.ctx === undefined ? {} : { ctx: model.kod.ctx }),
      ...(model.kod?.ctx_advisory === undefined
        ? {}
        : { ctxAdvisory: model.kod.ctx_advisory }),
      ...(model.kod?.loaded === undefined ? {} : { loaded: model.kod.loaded }),
      ...(model.kod?.quant === undefined ? {} : { quant: model.kod.quant }),
    }));
  }

  async capabilities(): Promise<BackendCapabilities> {
    const value = await this.getJson<{
      engine?: string;
      formats?: string[];
      supports: InferenceSupports;
      ram_budget_bytes?: number;
    }>("/kod/capabilities");
    return {
      ...(value.engine === undefined ? {} : { engine: value.engine }),
      ...(value.formats === undefined ? {} : { formats: value.formats }),
      supports: value.supports,
      ...(value.ram_budget_bytes === undefined
        ? {}
        : { ramBudgetBytes: value.ram_budget_bytes }),
    };
  }

  async memoryReport(): Promise<MemoryReport> {
    const value = await this.getJson<{
      total_ram_bytes?: number;
      ram_budget_bytes?: number;
      loaded_bytes?: number;
      loaded_models?: Array<{
        id: string;
        name?: string;
        path?: string;
        metadata?: {
          context_length?: number;
          context_length_is_advisory?: boolean;
          quant?: string;
          architecture?: string;
        };
        footprint_bytes?: number;
      }>;
    }>("/kod/memory");
    return {
      ...(value.total_ram_bytes === undefined ? {} : { totalRamBytes: value.total_ram_bytes }),
      ...(value.ram_budget_bytes === undefined
        ? {}
        : { ramBudgetBytes: value.ram_budget_bytes }),
      loadedBytes: value.loaded_bytes ?? 0,
      loadedModels: (value.loaded_models ?? []).map((model) => this.mapLoadedModel(model)),
    };
  }

  async loadModel(request: { path: string; ctx?: number }): Promise<LoadedModel> {
    const value = await this.postJson<Parameters<typeof this.mapLoadedModel>[0]>(
      "/kod/load",
      request,
    );
    return this.mapLoadedModel(value);
  }

  async unloadModel(id: string): Promise<void> {
    await this.postJson("/kod/unload", { id });
  }

  private mapLoadedModel(value: {
    id: string;
    name?: string;
    path?: string;
    metadata?: {
      context_length?: number;
      context_length_is_advisory?: boolean;
      quant?: string;
      architecture?: string;
    };
    footprint_bytes?: number;
  }): LoadedModel {
    return {
      id: value.id,
      ...(value.name === undefined ? {} : { name: value.name }),
      ...(value.path === undefined ? {} : { path: value.path }),
      ...(value.metadata === undefined
        ? {}
        : {
            metadata: {
              ...(value.metadata.context_length === undefined
                ? {}
                : { contextLength: value.metadata.context_length }),
              ...(value.metadata.context_length_is_advisory === undefined
                ? {}
                : { contextLengthIsAdvisory: value.metadata.context_length_is_advisory }),
              ...(value.metadata.quant === undefined ? {} : { quant: value.metadata.quant }),
              ...(value.metadata.architecture === undefined
                ? {}
                : { architecture: value.metadata.architecture }),
            },
          }),
      ...(value.footprint_bytes === undefined
        ? {}
        : { footprintBytes: value.footprint_bytes }),
    };
  }

  private parseSseEvent(event: string, endpoint: string): ChatDelta | "done" | null {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return null;
    if (data.trim() === "[DONE]") return "done";

    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(data) as OpenAIChunk;
    } catch {
      throw new InferenceBackendError(`invalid SSE JSON from ${endpoint}`, undefined, endpoint);
    }
    if (chunk.error) {
      const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
      throw new InferenceBackendError(message ?? `stream failed at ${endpoint}`, undefined, endpoint);
    }
    const choice = chunk.choices?.[0];
    if (!choice) return null;
    const delta = choice.delta ?? {};
    return {
      ...(chunk.id === undefined ? {} : { id: chunk.id }),
      ...(chunk.model === undefined ? {} : { model: chunk.model }),
      ...(delta.role === undefined ? {} : { role: delta.role }),
      ...(delta.content == null ? {} : { content: delta.content }),
      ...(delta.reasoning_content == null && delta.reasoning == null
        ? {}
        : { reasoning: delta.reasoning_content ?? delta.reasoning! }),
      ...(delta.tool_calls === undefined ? {} : { toolCalls: delta.tool_calls }),
      ...(choice.finish_reason == null ? {} : { finishReason: choice.finish_reason }),
      ...(chunk.kod?.tokens_per_second === undefined
        ? {}
        : { tokensPerSecond: chunk.kod.tokens_per_second }),
    };
  }

  private async getJson<T>(endpoint: string): Promise<T> {
    const url = endpoint.startsWith("/v1/")
      ? `${this.apiURL}${endpoint.slice(3)}`
      : `${this.rootURL}${endpoint}`;
    const response = await this.fetchResponse(url, endpoint, { headers: this.headers });
    return this.readJson<T>(response, endpoint);
  }

  private async postJson<T = unknown>(
    endpoint: string,
    body: unknown,
    options?: ChatRequestOptions,
  ): Promise<T> {
    const url = endpoint.startsWith("/v1/")
      ? `${this.apiURL}${endpoint.slice(3)}`
      : `${this.rootURL}${endpoint}`;
    const response = await this.fetchResponse(url, endpoint, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return this.readJson<T>(response, endpoint);
  }

  private async fetchResponse(url: string, endpoint: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new InferenceBackendError(
        `transport failed at ${endpoint}: ${transportMessage(error)}`,
        undefined,
        endpoint,
        "transport",
      );
    }
  }

  private async readJson<T>(response: Response, endpoint: string): Promise<T> {
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new InferenceBackendError(`invalid JSON from ${endpoint}`, response.status, endpoint);
        }
      }
    }
    if (!response.ok) {
      throw new InferenceBackendError(
        errorMessage(payload, `${endpoint} failed with HTTP ${response.status}`),
        response.status,
        endpoint,
      );
    }
    return payload as T;
  }

  private async assertOk(response: Response, endpoint: string): Promise<void> {
    if (response.ok) return;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    throw new InferenceBackendError(
      errorMessage(payload, `${endpoint} failed with HTTP ${response.status}`),
      response.status,
      endpoint,
    );
  }
}
