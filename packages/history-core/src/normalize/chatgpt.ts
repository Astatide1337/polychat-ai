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

function pickConversationId(raw: RawChatGptConversation): string {
  return (
    raw.id?.trim() ||
    raw.conversation_id?.trim() ||
    scopedId("chatgpt", raw.title ?? raw.url ?? raw.current_node ?? raw)
  );
}

function collectMessages(raw: RawChatGptConversation): RawChatGptNode[] {
  const mapping = raw.mapping ?? {};
  const nodes = Object.values(mapping).filter((node): node is RawChatGptNode => Boolean(node && (node.message || node.node)));
  if (nodes.length > 0) return nodes;
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
  const input = (raw ?? {}) as RawChatGptConversation;
  const conversationId = pickConversationId(input);
  const mapping = input.mapping ?? {};
  const currentNode = typeof input.current_node === "string" ? input.current_node : null;
  const orderedNodes: Array<[string, RawChatGptNode]> = [];
  const seen = new Set<string>();

  function visit(nodeId: string | null | undefined) {
    if (!nodeId || seen.has(nodeId)) return;
    const node = mapping[nodeId];
    if (!node) return;
    seen.add(nodeId);
    const parent = (node.parent ?? node.parent_id ?? null) as string | null;
    if (parent) visit(parent);
    orderedNodes.push([nodeId, node]);
  }

  if (currentNode) {
    visit(currentNode);
  } else {
    for (const [nodeId, node] of Object.entries(mapping)) {
      if (node && (node.message || node.node)) {
        orderedNodes.push([nodeId, node]);
      }
    }
    orderedNodes.sort((a, b) => {
      const ta = iso(a[1].message?.create_time ?? a[1].node?.create_time) ?? "";
      const tb = iso(b[1].message?.create_time ?? b[1].node?.create_time) ?? "";
      return ta.localeCompare(tb);
    });
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
    const message = node.message ?? node.node ?? null;
    if (!message) return [];
    const contentRecord = (message.content && typeof message.content === "object" && !Array.isArray(message.content))
      ? (message.content as Record<string, unknown>)
      : null;
    const role = roleFrom(message.author && typeof message.author === "object" ? (message.author as Record<string, unknown>).role : message.role);
    const content = summarizeContent(
      contentRecord?.parts ?? contentRecord?.text ?? message.parts ?? message.text ?? ""
    );
    return [
      {
        id: pickMessageId(conversationId, nodeId, message, index),
        provider: "chatgpt",
        conversationId,
        role,
        content,
        model: typeof message.metadata === "object" && message.metadata
          ? ((message.metadata as Record<string, unknown>).model_slug as string | undefined) ?? input.model ?? input.model_slug ?? null
          : input.model ?? input.model_slug ?? null,
        parentId: (node.parent ?? node.parent_id ?? null) as string | null,
        nodeId,
        createdAt: iso(message.create_time ?? node.create_time),
        updatedAt: iso(message.update_time ?? node.update_time),
        raw: node,
      } satisfies Message,
    ];
  });

  return {
    conversation: {
      id: conversationId,
      provider: "chatgpt",
      title: typeof input.title === "string" ? input.title : null,
      url: typeof input.url === "string" ? input.url : `https://chatgpt.com/c/${conversationId}`,
      model: typeof input.model === "string" ? input.model : typeof input.model_slug === "string" ? input.model_slug : null,
      createdAt: iso(input.create_time),
      updatedAt: iso(input.update_time),
      lastSyncedAt: new Date().toISOString(),
      raw: input,
    },
    messages,
  };
}
