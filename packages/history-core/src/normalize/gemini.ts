import { scopedId, shortId } from "../ids.js";
import { summarizeContent } from "../content.js";
import type { Conversation, Message } from "../types.js";

type RawGeminiMessage = Record<string, unknown>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function roleFrom(value: unknown): Message["role"] {
  const role = typeof value === "string" ? value.toLowerCase() : "";
  if (role === "assistant" || role === "user" || role === "system" || role === "tool") {
    return role;
  }
  return "unknown";
}

function collectMessages(raw: Record<string, unknown>): RawGeminiMessage[] {
  const direct = raw.messages;
  if (Array.isArray(direct)) return direct as RawGeminiMessage[];
  const conversation = raw.conversation;
  if (conversation && typeof conversation === "object") {
    const conv = conversation as Record<string, unknown>;
    if (Array.isArray(conv.messages)) return conv.messages as RawGeminiMessage[];
  }
  const transcript = raw.transcript;
  if (transcript && typeof transcript === "object") {
    const body = transcript as Record<string, unknown>;
    if (Array.isArray(body.messages)) return body.messages as RawGeminiMessage[];
  }
  const geminiWiz = raw.geminiWiz;
  if (geminiWiz && typeof geminiWiz === "object") {
    const wiz = geminiWiz as Record<string, unknown>;
    if (Array.isArray(wiz.rows)) {
      return wiz.rows.flatMap((row, index) => {
        const text = summarizeContent(row);
        if (!text.trim()) return [];
        return [
          {
            id: `wiz-row-${index}`,
            role: index % 2 === 0 ? "user" : "assistant",
            content: text,
            raw: row,
          },
        ];
      });
    }
  }
  const bodyText = typeof raw.bodyText === "string" ? raw.bodyText.trim() : "";
  const url = typeof raw.url === "string" ? raw.url : "";
  const isConversationUrl = /\/app\/[^/?#]+/.test(url) || /[?&]conversation_id=/.test(url);
  if (bodyText && !isConversationUrl) {
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

export function normalizeGeminiConversation(raw: unknown): { conversation: Conversation; messages: Message[] } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const metadata = input.metadata;
  const id =
    (typeof input.id === "string" && input.id.trim()) ||
    (typeof input.cid === "string" && input.cid.trim()) ||
    (Array.isArray(metadata) && typeof metadata[0] === "string" ? metadata[0] : "") ||
    scopedId("gemini", input.title ?? input.name ?? input);
  const messagesRaw = collectMessages(input);
  const messages: Message[] = messagesRaw.map((message, index) => {
    const nodeId =
      (message.id as string | undefined)?.trim() ||
      (message.node_id as string | undefined)?.trim() ||
      shortId("gemini_node", [id, index]);
    const parentId =
      (message.parent_id as string | null | undefined) ??
      (message.parentId as string | null | undefined) ??
      null;
    const content = summarizeContent(message.content ?? message.text ?? message.parts ?? message.payload);
    return {
      id: (message.message_id as string | undefined)?.trim() || nodeId,
      provider: "gemini",
      conversationId: id,
      role: roleFrom(message.role ?? message.author ?? message.sender),
      content,
      model: (message.model as string | undefined) ?? (input.model as string | undefined) ?? null,
      parentId,
      nodeId,
      createdAt: iso(message.created_at ?? message.timestamp ?? message.create_time),
      updatedAt: iso(message.updated_at ?? message.update_time),
      raw: message,
    } satisfies Message;
  });

  return {
    conversation: {
      id,
      provider: "gemini",
      title:
        typeof input.title === "string" && input.title.trim().length > 0
          ? input.title
          : typeof input.name === "string" && input.name.trim().length > 0
            ? input.name
            : null,
      url:
        typeof input.url === "string" && input.url.trim().length > 0
          ? input.url
          : `https://gemini.google.com/app/${id}`,
      model: typeof input.model === "string" ? input.model : null,
      createdAt: iso(input.created_at ?? input.createdAt),
      updatedAt: iso(input.updated_at ?? input.updatedAt) ?? messages[messages.length - 1]?.createdAt ?? null,
      lastSyncedAt: new Date().toISOString(),
      raw: input,
    },
    messages,
  };
}
