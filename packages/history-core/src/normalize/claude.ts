import { scopedId, shortId } from "../ids.js";
import { summarizeContent } from "../content.js";
import type { Conversation, Message } from "../types.js";

type RawClaudeMessage = Record<string, unknown>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function roleFrom(value: unknown): Message["role"] {
  const role = typeof value === "string" ? value.toLowerCase() : "";
  if (role === "human") return "user";
  if (role === "assistant" || role === "user" || role === "system" || role === "tool") {
    return role;
  }
  return "unknown";
}

function collectMessages(raw: Record<string, unknown>): RawClaudeMessage[] {
  const direct = raw.messages;
  if (Array.isArray(direct)) return direct as RawClaudeMessage[];
  const chatMessages = raw.chat_messages;
  if (Array.isArray(chatMessages)) return chatMessages as RawClaudeMessage[];
  const transcript = raw.transcript;
  if (transcript && typeof transcript === "object" && Array.isArray((transcript as Record<string, unknown>).messages)) {
    return (transcript as Record<string, unknown>).messages as RawClaudeMessage[];
  }
  const conversation = raw.conversation;
  if (conversation && typeof conversation === "object" && Array.isArray((conversation as Record<string, unknown>).messages)) {
    return (conversation as Record<string, unknown>).messages as RawClaudeMessage[];
  }
  const bodyText = typeof raw.bodyText === "string" ? raw.bodyText.trim() : "";
  if (bodyText) {
    return [
      {
        id: "body-text",
        role: "unknown",
        content: { parts: [bodyText] },
      },
    ];
  }
  return [];
}

export function normalizeClaudeConversation(raw: unknown): { conversation: Conversation; messages: Message[] } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const id =
    (input.uuid as string | undefined)?.trim() ||
    (input.id as string | undefined)?.trim() ||
    scopedId("claude", input.name ?? input.title ?? input);
  const messagesRaw = collectMessages(input);
  const messages: Message[] = messagesRaw.map((message, index) => {
    const nodeId =
      (message.uuid as string | undefined)?.trim() ||
      (message.id as string | undefined)?.trim() ||
      shortId("claude_node", [id, index]);
    const parentId =
      (message.parent_message_uuid as string | null | undefined) ??
      (message.parent_id as string | null | undefined) ??
      null;
    const content = summarizeContent(
      message.content ??
        message.text ??
        message.parts ??
        message.message ??
        message.completion ??
        ""
    );
    return {
      id: (message.message_uuid as string | undefined)?.trim() || nodeId,
      provider: "claude",
      conversationId: id,
      role: roleFrom(message.role ?? message.sender ?? message.author),
      content,
      model: (message.model as string | undefined) ?? (input.model as string | undefined) ?? null,
      parentId,
      nodeId,
      createdAt: iso(message.created_at ?? message.timestamp ?? message.createdAt),
      updatedAt: iso(message.updated_at ?? message.updatedAt),
      raw: message,
    } satisfies Message;
  });

  const updatedAt =
    iso(input.updated_at ?? input.updatedAt) ??
    messages[messages.length - 1]?.createdAt ??
    null;

  return {
    conversation: {
      id,
      provider: "claude",
      title:
        typeof input.name === "string" && input.name.trim().length > 0
          ? input.name
          : typeof input.title === "string" && input.title.trim().length > 0
            ? input.title
            : null,
      url:
        typeof input.url === "string" && input.url.trim().length > 0
          ? input.url
          : `https://claude.ai/chat/${id}`,
      model: typeof input.model === "string" ? input.model : null,
      createdAt: iso(input.created_at ?? input.createdAt),
      updatedAt,
      lastSyncedAt: new Date().toISOString(),
      raw: input,
    },
    messages,
  };
}
