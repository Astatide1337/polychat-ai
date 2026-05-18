export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatChunk {
  kind: "content" | "thinking";
  text: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  providerModel?: string;
}

export interface ProviderConversation {
  id: string;
  provider: string;
  title: string;
  modelId?: string;
  updatedAt?: string;
  url?: string;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  baseUrl: string;
  loginUrl: string;
  models: ModelInfo[];
  listModels(context?: unknown): Promise<ModelInfo[]>;
  detectLoginSuccess(context?: unknown): Promise<boolean>;
  validateSession(context?: unknown): Promise<boolean>;
  listConversations(context?: unknown): Promise<ProviderConversation[]>;
  loadConversationMessages?(context: unknown, conversationId: string): Promise<ChatMessage[]>;
  createConversation?(context: unknown, model: string): Promise<ProviderConversation>;
  sendMessage?(context: unknown, messages: ChatMessage[], model: string, options: ChatOptions): AsyncGenerator<ChatChunk>;
  sendMessageToConversation?(context: unknown, conversationId: string, messages: ChatMessage[], model: string, options: ChatOptions): AsyncGenerator<ChatChunk>;
}
