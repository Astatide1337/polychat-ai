import { randomUUID } from "node:crypto";
import type { BrowserContext } from "playwright-core";
import { hasProviderSessionArtifacts } from "../browser/profile.js";
import { loadSession } from "../session/store.js";
import { createSSEParser } from "../utils/stream.js";
import type { ChatChunk, ChatMessage, ChatOptions, ModelInfo, ProviderConversation } from "./types.js";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function readClaudeAuth(context: BrowserContext) {
  const orgs = await readClaudeOrganizations(context);
  const orgId = orgs[0]?.uuid ?? orgs[0]?.id ?? orgs[0]?.org_id ?? null;
  if (!orgId) throw new Error("Could not determine Claude organization id");
  return { orgId, cookieHeader: cookieHeaderForClaude(await context.cookies()) };
}

function claudeHeaders(cookieHeader: string) {
  return {
    cookie: cookieHeader,
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
    accept: "application/json, text/plain, */*",
    origin: "https://claude.ai",
    referer: "https://claude.ai/",
  };
}

async function readClaudeOrganizations(context: BrowserContext) {
  const cookieHeader = cookieHeaderForClaude(await context.cookies());
  const res = await fetch("https://claude.ai/api/organizations", {
    headers: claudeHeaders(cookieHeader),
  });
  if (!res.ok) throw new Error(`Failed to load organizations: ${res.status}`);
  return res.json() as Promise<Array<{ uuid?: string; id?: string; org_id?: string }>>;
}

function cookieHeaderForClaude(cookies: Array<{ domain: string; name: string; value: string }>) {
  return cookies
    .filter((cookie) => /claude\.ai|claude\.com|anthropic/i.test(cookie.domain))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function formatPrompt(messages: ChatMessage[]) {
  return messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Model discovery — conversation history + known models
// ---------------------------------------------------------------------------

const KNOWN_CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "claude" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "claude" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "claude" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "claude" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "claude" },
];

export function normalizeClaModels(convos: unknown[], provider: string): ModelInfo[] {
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const item of convos) {
    if (!item || typeof item !== "object") continue;
    const modelId = (item as { model?: unknown }).model;
    if (typeof modelId === "string" && modelId.trim() && !seen.has(modelId)) {
      seen.add(modelId);
      const known = KNOWN_CLAUDE_MODELS.find((m) => m.id === modelId);
      models.push({ id: modelId, name: known?.name ?? modelId, provider });
    }
  }
  for (const known of KNOWN_CLAUDE_MODELS) {
    if (!seen.has(known.id)) {
      seen.add(known.id);
      models.push({ id: known.id, name: known.name, provider });
    }
  }
  return models;
}

// ---------------------------------------------------------------------------
// Adapter object
// ---------------------------------------------------------------------------

export const claudeAdapter = {
  id: "claude" as const,
  name: "Claude",
  baseUrl: "https://claude.ai",
  loginUrl: "https://claude.ai/login",
  models: [] as ModelInfo[],

  async listModels(context?: unknown): Promise<ModelInfo[]> {
    const { orgId, cookieHeader } = await readClaudeAuth(context as BrowserContext);
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations?limit=100`, {
      headers: claudeHeaders(cookieHeader),
    });
    if (!res.ok) throw new Error(`Claude conversation list request failed: ${res.status}`);
    const payload = await res.json() as unknown;
    if (!Array.isArray(payload)) throw new Error("Unexpected Claude conversation list response");
    return normalizeClaModels(payload, "claude");
  },

  async detectLoginSuccess(context?: unknown): Promise<boolean> {
    try {
      const orgs = await readClaudeOrganizations(context as BrowserContext);
      return orgs.length > 0;
    } catch { return false; }
  },

  async listConversations(context?: unknown): Promise<ProviderConversation[]> {
    const { orgId, cookieHeader } = await readClaudeAuth(context as BrowserContext);
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
      headers: claudeHeaders(cookieHeader),
    });
    if (!res.ok) return [];
    const payload = await res.json() as unknown;
    if (!Array.isArray(payload)) return [];
    return payload.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const convo = item as Record<string, unknown>;
      const id = typeof convo.uuid === "string" ? convo.uuid : typeof convo.id === "string" ? convo.id : null;
      if (!id) return [];
      return [{
        id,
        provider: "claude",
        title: typeof convo.name === "string" && convo.name.trim() ? convo.name.trim() : "Untitled conversation",
        modelId: typeof convo.model === "string" ? convo.model : undefined,
        updatedAt: typeof convo.updated_at === "string" ? convo.updated_at : undefined,
        url: `https://claude.ai/chat/${id}`,
      }];
    });
  },

  async createConversation(context: unknown, model: string): Promise<ProviderConversation> {
    const { orgId, cookieHeader } = await readClaudeAuth(context as BrowserContext);
    const conversationId = randomUUID();
    const created = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
      method: "POST",
      headers: { ...claudeHeaders(cookieHeader), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", model, uuid: conversationId }),
    });
    if (!created.ok) throw new Error("Failed to create Claude conversation");
    return { id: conversationId, provider: "claude", title: "New conversation", modelId: model, url: `https://claude.ai/chat/${conversationId}` };
  },

  async *sendMessage(context: unknown, messages: ChatMessage[], model: string, options: ChatOptions): AsyncGenerator<ChatChunk> {
    const conversation = await claudeAdapter.createConversation(context, model);
    yield* claudeAdapter.sendMessageToConversation(context, conversation.id, messages, model, options);
  },

  async *sendMessageToConversation(context: unknown, conversationId: string, messages: ChatMessage[], model: string, _options: ChatOptions): AsyncGenerator<ChatChunk> {
    const { orgId, cookieHeader } = await readClaudeAuth(context as BrowserContext);
    const prompt = formatPrompt(messages);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
    const turnMessageUuids = { human_message_uuid: randomUUID(), assistant_message_uuid: randomUUID() };

    const completionRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`, {
      method: "POST",
      headers: { ...claudeHeaders(cookieHeader), "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        prompt, model, timezone, locale, rendering_mode: "messages",
        turn_message_uuids: turnMessageUuids, attachments: [], files: [], sync_sources: [],
      }),
    });
    if (!completionRes.ok || !completionRes.body) {
      throw new Error(`Claude completion request failed: ${completionRes.status}`);
    }

    const reader = completionRes.body.getReader();
    const decoder = new TextDecoder();
    const parseSSEChunk = createSSEParser();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parseSSEChunk(decoder.decode(value, { stream: true }))) {
        if (!event.data || typeof event.data !== "object") continue;
        const data = event.data as Record<string, unknown>;
        if (data.type === "error") {
          const error = data.error as { message?: string } | undefined;
          throw new Error(error?.message ?? "Claude returned an error");
        }
        if (data.type === "content_block_delta") {
          const delta = data.delta as { type?: string; text?: string; thinking?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) yield { kind: "content", text: delta.text };
          if (delta?.type === "thinking_delta" && delta.thinking) yield { kind: "thinking", text: delta.thinking };
        }
      }
    }
  },

  async validateSession(_context?: unknown): Promise<boolean> {
    return hasProviderSessionArtifacts("claude", loadSession("claude"));
  },
};
