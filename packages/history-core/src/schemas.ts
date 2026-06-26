import type { Conversation, IngestRequest, Message, ProviderId } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function expectText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError("expected string or null");
  }
  return value;
}

function parseProviderId(value: unknown): ProviderId {
  if (value === "chatgpt" || value === "claude" || value === "gemini") {
    return value;
  }
  throw new TypeError("provider must be chatgpt, claude, or gemini");
}

function parseIsoTimestamp(value: unknown, label: string): string | null {
  const text = optionalString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`${label} must be an ISO date string`);
  }
  return new Date(parsed).toISOString();
}

function parseUnknown(value: unknown): unknown {
  return value;
}

export function parseConversation(value: unknown): Conversation {
  const input = expectObject(value, "conversation");
  return {
    id: expectString(input.id, "conversation.id"),
    provider: parseProviderId(input.provider),
    title: optionalString(input.title),
    url: optionalString(input.url),
    model: optionalString(input.model),
    createdAt: parseIsoTimestamp(input.createdAt, "conversation.createdAt"),
    updatedAt: parseIsoTimestamp(input.updatedAt, "conversation.updatedAt"),
    lastSyncedAt: expectString(input.lastSyncedAt, "conversation.lastSyncedAt"),
    raw: parseUnknown(input.raw),
  };
}

export function parseMessage(value: unknown): Message {
  const input = expectObject(value, "message");
  return {
    id: expectString(input.id, "message.id"),
    provider: parseProviderId(input.provider),
    conversationId: expectString(input.conversationId, "message.conversationId"),
    role: (() => {
      const role = input.role;
      if (
        role === "user" ||
        role === "assistant" ||
        role === "system" ||
        role === "tool" ||
        role === "unknown"
      ) {
        return role;
      }
      throw new TypeError("message.role must be user, assistant, system, tool, or unknown");
    })(),
    content: expectText(input.content, "message.content"),
    model: optionalString(input.model),
    parentId: optionalString(input.parentId),
    nodeId: optionalString(input.nodeId),
    createdAt: parseIsoTimestamp(input.createdAt, "message.createdAt"),
    updatedAt: parseIsoTimestamp(input.updatedAt, "message.updatedAt"),
    raw: parseUnknown(input.raw),
  };
}

export function parseIngestRequest(value: unknown): IngestRequest {
  const input = expectObject(value, "request body");
  const conversation = parseConversation(input.conversation);
  const messagesRaw = input.messages;
  if (!Array.isArray(messagesRaw)) {
    throw new TypeError("messages must be an array");
  }
  const replaceMessages = input.replaceMessages;
  if (replaceMessages !== undefined && typeof replaceMessages !== "boolean") {
    throw new TypeError("replaceMessages must be a boolean");
  }
  return {
    conversation,
    messages: messagesRaw.map(parseMessage),
    replaceMessages,
  };
}
