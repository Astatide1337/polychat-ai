export type ProviderId = "chatgpt" | "claude" | "deepseek" | "gemini" | "kimi" | string;

export type ProviderHealth = {
  connected: boolean;
  session_valid: boolean | null;
  defaultModel: string;
};

export type HealthResponse = {
  status: string;
  version?: string;
  providers: Record<ProviderId, ProviderHealth>;
};

export type ModelInfo = {
  id: string;
  name?: string;
  object: "model";
  owned_by: ProviderId;
  capabilities?: Record<string, unknown>;
};

export type ModelListResponse = {
  object: "list";
  data: ModelInfo[];
};

export type ProviderConversation = {
  id: string;
  provider: ProviderId;
  title: string;
  modelId?: string | null;
  updatedAt?: string | null;
  url?: string | null;
  providerDebug?: unknown;
};

export type ConversationListResponse = {
  provider: ProviderId;
  supported: boolean;
  conversations?: ProviderConversation[];
  reason?: string;
};

export type CreateConversationResponse = {
  supported: boolean;
  conversation?: ProviderConversation;
  reason?: string;
};

export type ToolCall = {
  id: string;
  type: string;
  function?: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  provider?: ProviderId | null;
  model?: string | null;
  createdAt: string;
  status?: "pending" | "streaming" | "done" | "error" | "cancelled";
  error?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  provider: ProviderId | null;
  model: string | null;
  providerConversationId: string | null;
  temporary: boolean;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type ChatCompletionRequest = {
  model: string;
  messages: Array<{ role: ChatMessage["role"]; content: string; tool_call_id?: string; name?: string }>;
  stream?: boolean;
  provider_conversation_id?: string | null;
  temporary?: boolean;
  include_provider_debug?: boolean;
};

export type ChatCompletionResponse = {
  id: string;
  choices: Array<{
    message?: {
      role: "assistant";
      content?: string;
      thinking?: string;
      tool_calls?: ToolCall[];
    };
    delta?: {
      content?: string;
      thinking?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string | null;
  }>;
  provider_debug?: unknown;
};

export type StreamCallbacks = {
  signal?: AbortSignal;
  onContent?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolCalls?: (toolCalls: ToolCall[]) => void;
  onDone?: () => void;
  onDebug?: (debug: unknown) => void;
};

export type McpServersResponse = {
  object: "list";
  data: Array<{ id?: string; name?: string; enabled?: boolean; status?: string; [key: string]: unknown }>;
};

export type McpToolsResponse = {
  object: "list";
  data: Array<{ type: string; function?: { name: string; description?: string; parameters?: unknown } }>;
};

export type McpToolResult = {
  object: "mcp.tool_result";
  tool: string;
  server: string;
  original_tool: string;
  content: string;
  is_error: boolean;
};

export type WebSettings = {
  baseUrl: string;
  apiKey: string;
  inspectorOpen: boolean;
  inspectorTab: "status" | "debug" | "mcp";
};
