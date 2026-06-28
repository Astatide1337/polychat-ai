import { scopedId, shortId } from "../ids.js";
import { summarizeContent } from "../content.js";
import type { Conversation, Message } from "../types.js";

type RawChatGptNode = Record<string, unknown> & {
  id?: string;
  parent?: string | null;
  parent_id?: string | null;
  message?: Record<string, unknown> | null;
  node?: Record<string, unknown> | null;
};

type RawChatGptConversation = Record<string, unknown> & {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: string | number | null;
  update_time?: string | number | null;
  current_node?: string | null;
  mapping?: Record<string, RawChatGptNode | null> | null;
  messages?: unknown;
  chat_messages?: unknown;
  conversation?: unknown;
  data?: unknown;
  item?: unknown;
  payload?: unknown;
  response?: unknown;
  transcript?: unknown;
  bodyText?: string;
  url?: string | null;
  model?: string | null;
  model_slug?: string | null;
};

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function roleFrom(value: unknown): Message["role"] {
  return value === "user" || value === "assistant" || value === "system" || value === "tool"
    ? value
    : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hasChatgptPayloadShape(value: Record<string, unknown>): boolean {
  return (
    "mapping" in value ||
    "messages" in value ||
    "chat_messages" in value ||
    "bodyText" in value ||
    "current_node" in value ||
    "conversation_id" in value
  );
}

function unwrapChatgptConversation(raw: Record<string, unknown>): Record<string, unknown> {
  let current = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    const next = [
      current.conversation,
      current.data,
      current.item,
      current.payload,
      current.response,
      current.transcript,
    ]
      .map(asRecord)
      .find((candidate): candidate is Record<string, unknown> => Boolean(candidate && hasChatgptPayloadShape(candidate)));
    if (!next) break;
    current = next;
  }
  return current;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pickConversationId(raw: RawChatGptConversation, fallback: Record<string, unknown>): string {
  return (
    stringValue(raw.id) ||
    stringValue(raw.conversation_id) ||
    stringValue(fallback.id) ||
    stringValue(fallback.conversation_id) ||
    scopedId("chatgpt", raw.title ?? raw.url ?? raw.current_node ?? raw)
  );
}

function collectMessages(raw: RawChatGptConversation): RawChatGptNode[] {
  const mapping = raw.mapping ?? {};
  const nodes = Object.values(mapping).filter((node): node is RawChatGptNode => Boolean(node && (node.message || node.node)));
  if (nodes.length > 0) return nodes;
  const directMessages = raw.messages;
  if (Array.isArray(directMessages)) return directMessages as RawChatGptNode[];
  const chatMessages = raw.chat_messages;
  if (Array.isArray(chatMessages)) return chatMessages as RawChatGptNode[];
  const conversation = asRecord(raw.conversation);
  if (conversation && Array.isArray(conversation.messages)) return conversation.messages as RawChatGptNode[];
  if (conversation && Array.isArray(conversation.chat_messages)) return conversation.chat_messages as RawChatGptNode[];
  const transcript = asRecord(raw.transcript);
  if (transcript && Array.isArray(transcript.messages)) return transcript.messages as RawChatGptNode[];
  if (transcript && Array.isArray(transcript.chat_messages)) return transcript.chat_messages as RawChatGptNode[];
  const bodyText = typeof raw.bodyText === "string" ? raw.bodyText.trim() : "";
  if (!bodyText) return [];
  return [
    {
      id: raw.current_node ?? raw.id ?? raw.conversation_id ?? "body-text",
      message: {
        author: { role: "unknown" },
        content: { parts: [bodyText] },
        create_time: raw.create_time ?? null,
        update_time: raw.update_time ?? null,
      },
    },
  ];
}

function pickMessageId(
  conversationId: string,
  nodeId: string,
  message: Record<string, unknown> | null | undefined,
  fallbackIndex: number
): string {
  const candidate =
    (message?.id as string | undefined)?.trim() ||
    (message?.message_id as string | undefined)?.trim() ||
    (message?.uuid as string | undefined)?.trim();
  return candidate || shortId("chatgpt_msg", [conversationId, nodeId, fallbackIndex]);
}

export function normalizeChatgptConversation(raw: unknown): { conversation: Conversation; messages: Message[] } {
  const outer = (raw ?? {}) as RawChatGptConversation;
  const input = unwrapChatgptConversation(outer);
  const conversationId = pickConversationId(input as RawChatGptConversation, outer);
  const mapping = (input.mapping ?? {}) as Record<string, RawChatGptNode | null>;
  const orderedNodes: Array<[string, RawChatGptNode]> = [];
  const seen = new Set<string>();

  function visit(nodeId: string | null | undefined) {
    if (!nodeId || seen.has(nodeId)) return;
    const node = mapping[nodeId];
    if (!node) return;
    seen.add(nodeId);
    const parent = (node.parent ?? node.parent_id ?? null) as string | null;
    if (parent) visit(parent);
    if (node.message || node.node) {
      orderedNodes.push([nodeId, node]);
    }
  }

  for (const nodeId of Object.keys(mapping)) {
    visit(nodeId);
  }

  const collected = collectMessages(input);
  if (collected.length > 0 && orderedNodes.length === 0) {
    for (const [index, node] of collected.entries()) {
      const nodeId =
        (node.id as string | undefined)?.trim() ||
        (node.node?.id as string | undefined)?.trim() ||
        shortId("chatgpt_msg", [conversationId, index]);
      orderedNodes.push([nodeId, node]);
    }
  }

  const messages: Message[] = orderedNodes.flatMap(([nodeId, node], index) => {
    const message = node.message ?? node.node ?? node;
    if (!message || typeof message !== "object") return [];
    const contentRecord = (message.content && typeof message.content === "object" && !Array.isArray(message.content))
      ? (message.content as Record<string, unknown>)
      : null;
    const role = roleFrom(message.author && typeof message.author === "object" ? (message.author as Record<string, unknown>).role : message.role);
    const content = summarizeContent(
      contentRecord?.parts ?? contentRecord?.text ?? message.parts ?? message.text ?? ""
    );
    const model =
      stringValue((message.metadata && typeof message.metadata === "object" ? (message.metadata as Record<string, unknown>).model_slug : null)) ??
      stringValue(input.model) ??
      stringValue(input.model_slug) ??
      stringValue(outer.model) ??
      stringValue(outer.model_slug);
    return [
      {
        id: pickMessageId(conversationId, nodeId, message, index),
        provider: "chatgpt",
        conversationId,
        role,
        content,
        model,
        parentId:
          stringValue(node.parent) ??
          stringValue(node.parent_id) ??
          stringValue(message.parent) ??
          stringValue(message.parent_id) ??
          stringValue(message.parent_message_id) ??
          stringValue(message.parentMessageId),
        nodeId,
        createdAt: iso(message.create_time ?? node.create_time),
        updatedAt: iso(message.update_time ?? node.update_time),
        raw: node,
      } satisfies Message,
    ];
  });
  const conversationTitle = stringValue(input.title) ?? stringValue(outer.title);
  const conversationUrl = stringValue(input.url) ?? stringValue(outer.url) ?? `https://chatgpt.com/c/${conversationId}`;
  const conversationModel =
    stringValue(input.model) ??
    stringValue(input.model_slug) ??
    stringValue(outer.model) ??
    stringValue(outer.model_slug);

  return {
    conversation: {
      id: conversationId,
      provider: "chatgpt",
      title: conversationTitle,
      url: conversationUrl,
      model: conversationModel,
      createdAt: iso(input.create_time ?? outer.create_time),
      updatedAt: iso(input.update_time ?? outer.update_time),
      lastSyncedAt: new Date().toISOString(),
      raw: outer,
    },
    messages,
  };
}
