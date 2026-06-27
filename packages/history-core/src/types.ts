export type ProviderId = "chatgpt" | "claude" | "gemini";
export type SearchSyntax = "plain" | "fts";

export type MessageRole = "user" | "assistant" | "system" | "tool" | "unknown";

export type Conversation = {
  id: string;
  provider: ProviderId;
  title: string | null;
  url: string | null;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastSyncedAt: string;
  raw: unknown;
};

export type Message = {
  id: string;
  provider: ProviderId;
  conversationId: string;
  role: MessageRole;
  content: string;
  model: string | null;
  parentId: string | null;
  nodeId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  raw: unknown;
};

export type ConversationSummary = Pick<
  Conversation,
  "id" | "provider" | "title" | "url" | "model" | "createdAt" | "updatedAt" | "lastSyncedAt" | "raw"
>;

export type IngestRequest = {
  conversation: Conversation;
  messages: Message[];
  replaceMessages?: boolean;
};

export type SyncProviderStatus = {
  provider: ProviderId;
  conversations: number;
  messages: number;
  latestSync: string | null;
};

export type ProviderAdapter = {
  id: ProviderId;
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<{
    conversation: Conversation;
    messages: Message[];
  }>;
};
