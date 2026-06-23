import { consumeSse } from "./sse";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ConversationListResponse,
  CreateConversationResponse,
  HealthResponse,
  McpServersResponse,
  McpToolResult,
  McpToolsResponse,
  ModelInfo,
  ModelListResponse,
  StreamCallbacks,
} from "./types";

export class PolychatApiError extends Error {
  status: number;
  code?: string;
  type?: string;

  constructor(status: number, message: string, code?: string, type?: string) {
    super(message);
    this.name = "PolychatApiError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export class PolychatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl = "", apiKey = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private url(path: string): string {
    if (!this.baseUrl) return path;
    return `${this.baseUrl}${path}`;
  }

  private headers(extra?: HeadersInit): HeadersInit {
    return {
      ...extra,
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: this.headers(init?.headers),
    });
    if (!response.ok) throw await parseError(response);
    return response.json() as Promise<T>;
  }

  getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health");
  }

  listModels(): Promise<ModelListResponse> {
    return this.request<ModelListResponse>("/v1/models");
  }

  getModel(modelId: string): Promise<ModelInfo> {
    return this.request<ModelInfo>(`/v1/models/${encodeURIComponent(modelId)}`);
  }

  listConversations(provider: string): Promise<ConversationListResponse> {
    return this.request<ConversationListResponse>(`/v1/conversations?provider=${encodeURIComponent(provider)}`);
  }

  createConversation(provider: string, model: string): Promise<CreateConversationResponse> {
    return this.request<CreateConversationResponse>("/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model }),
    });
  }

  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return this.request<ChatCompletionResponse>("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, stream: false }),
    });
  }

  async streamChatCompletion(request: ChatCompletionRequest, callbacks: StreamCallbacks): Promise<void> {
    const response = await fetch(this.url("/v1/chat/completions"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ...request, stream: true }),
      signal: callbacks.signal,
    });
    if (!response.ok) throw await parseError(response);

    await consumeSse(response, (event) => {
      if (event.type === "content") callbacks.onContent?.(event.value);
      if (event.type === "thinking") callbacks.onThinking?.(event.value);
      if (event.type === "tool_calls") callbacks.onToolCalls?.(event.value);
      if (event.type === "debug") callbacks.onDebug?.(event.value);
      if (event.type === "done") callbacks.onDone?.();
    }, callbacks.signal);
  }

  listMcpServers(): Promise<McpServersResponse> {
    return this.request<McpServersResponse>("/v1/mcp/servers");
  }

  listMcpTools(): Promise<McpToolsResponse> {
    return this.request<McpToolsResponse>("/v1/mcp/tools");
  }

  callMcpTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.request<McpToolResult>(`/v1/mcp/tools/${encodeURIComponent(name)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: args }),
    });
  }
}

async function parseError(response: Response): Promise<PolychatApiError> {
  try {
    const body = await response.json() as { error?: { message?: string; code?: string; type?: string } };
    const error = body.error;
    return new PolychatApiError(
      response.status,
      error?.message ?? response.statusText,
      error?.code,
      error?.type,
    );
  } catch {
    return new PolychatApiError(response.status, response.statusText);
  }
}
