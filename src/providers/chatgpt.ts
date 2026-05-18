import { createHash, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import { hasProviderSessionArtifacts } from "../browser/profile.js";
import { loadSession } from "../session/store.js";
import { createSSEParser } from "../utils/stream.js";
import type { ChatChunk, ChatMessage, ChatOptions, ModelInfo, ProviderConversation } from "./types.js";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function chatGptHeaders(context: BrowserContext, accept: string): Promise<Record<string, string>> {
  const cookieHeader = cookieHeaderForChatGpt(await context.cookies());
  const accessToken = await readChatGptAccessToken(context);
  if (!accessToken) throw new Error("ChatGPT session is missing an access token");
  return {
    "Content-Type": "application/json",
    Accept: accept,
    Authorization: `Bearer ${accessToken}`,
    cookie: cookieHeader,
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
  };
}

async function chatGptCompletionHeaders(context: BrowserContext): Promise<Record<string, string>> {
  const headers = await chatGptHeaders(context, "text/event-stream");

  const csrfRes = await fetch("https://chatgpt.com/api/auth/csrf", {
    headers: { cookie: headers.cookie, "user-agent": headers["user-agent"], accept: "application/json" },
  });
  const csrfToken = csrfRes.ok ? ((await csrfRes.json()) as { csrfToken?: string })?.csrfToken ?? null : null;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;

  const requirements = await getChatRequirements(headers);
  headers["openai-sentinel-chat-requirements-token"] = requirements.token;
  if (requirements.proofofwork?.required && requirements.proofofwork.seed && requirements.proofofwork.difficulty) {
    const proofToken = generateProofToken(requirements.proofofwork.seed, requirements.proofofwork.difficulty, headers["user-agent"]);
    if (proofToken) headers["openai-sentinel-proof-token"] = proofToken;
  }
  return headers;
}

async function fetchChatGptConversation(context: BrowserContext, conversationId: string): Promise<Record<string, unknown>> {
  const headers = await chatGptHeaders(context, "application/json");
  const res = await fetch(`https://chatgpt.com/backend-api/conversation/${conversationId}`, { headers });
  if (!res.ok) throw new Error(`ChatGPT conversation load request failed: ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

async function readChatGptAccessToken(context: BrowserContext, page?: Page): Promise<string | null> {
  if (page) {
    const stored = await page.evaluate(() => localStorage.getItem("accessToken")).catch(() => null);
    if (stored) return stored;
  }
  const cookieHeader = cookieHeaderForChatGpt(await context.cookies());
  const res = await fetch("https://chatgpt.com/api/auth/session", {
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: cookieHeader,
      origin: "https://chatgpt.com",
      referer: "https://chatgpt.com/",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
    },
  });
  if (!res.ok) return null;
  const session = await res.json() as { accessToken?: string | null };
  return session.accessToken ?? null;
}

function cookieHeaderForChatGpt(cookies: Array<{ domain: string; name: string; value: string }>) {
  return cookies
    .filter((cookie) => /chatgpt\.com|openai\.com/i.test(cookie.domain))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Chat requirements / proof-of-work
// ---------------------------------------------------------------------------

interface ChatRequirements {
  token: string;
  proofofwork?: { required?: boolean; seed?: string; difficulty?: string };
}

async function getChatRequirements(headers: Record<string, string>): Promise<ChatRequirements> {
  const accessToken = (headers.Authorization ?? "").replace("Bearer ", "");
  const fallback: ChatRequirements = { token: accessToken.slice(0, 32) };
  try {
    const requirementsRes = await fetch("https://chatgpt.com/backend-api/sentinel/chat-requirements", {
      method: "POST", headers, body: JSON.stringify({ p: accessToken.slice(0, 32) }),
    });
    if (!requirementsRes.ok) return fallback;
    const payload = await requirementsRes.json() as ChatRequirements;
    return { token: payload?.token ?? fallback.token, proofofwork: payload?.proofofwork };
  } catch { return fallback; }
}

function generateProofToken(seed: string, difficulty: string, userAgent: string): string | null {
  const screen = [3008, 4010, 6000][Math.floor(Math.random() * 3)] * [1, 2, 4][Math.floor(Math.random() * 3)];
  const now = new Date();
  const parseTime = now.toUTCString();
  const proofArray: unknown[] = [
    screen, parseTime, null, 0, userAgent,
    "https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js",
    "dpl=1440a687921de39ff5ee56b92807faaadce73f13", "en", "en-US", null,
    "plugins\u2212[object PluginArray]", "_reactListeningcfilawjnerp", "alert",
  ];
  const diffLen = difficulty.length;
  for (let i = 0; i < 100000; i++) {
    proofArray[3] = i;
    const jsonData = JSON.stringify(proofArray);
    const base = Buffer.from(jsonData).toString("base64");
    const hash = createHash("sha3-512").update(seed + base).digest("hex");
    if (hash.slice(0, diffLen) <= difficulty) return "gAAAAAB" + base;
  }
  const fallbackBase = Buffer.from(JSON.stringify(`"${seed}"`)).toString("base64");
  return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallbackBase;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function buildPayload(messages: ChatMessage[], model: string, conversationId: string | null, parentMessageId: string | null) {
  const history = messages.slice(0, -1);
  const latest = messages[messages.length - 1];
  const system = history.length ? history.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n") : "";
  return {
    model,
    messages: [
      ...(system ? [{ id: randomUUID(), author: { role: "system" }, content: { content_type: "text", parts: [system] }, metadata: {} }] : []),
      ...(latest ? [{ id: randomUUID(), author: { role: latest.role }, content: { content_type: "text", parts: [latest.content] }, metadata: {} }] : []),
    ],
    parent_message_id: parentMessageId ?? randomUUID(),
    conversation_id: conversationId,
    timezone_offset_min: new Date().getTimezoneOffset(),
  };
}

function flattenChatGptMessages(mapping: Record<string, unknown>, currentNode: string | null): ChatMessage[] {
  const chain: unknown[] = [];
  const seen = new Set<string>();
  let nodeId = currentNode;
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!node || typeof node !== "object") break;
    chain.push(node);
    const parent = (node as { parent?: unknown }).parent;
    nodeId = typeof parent === "string" ? parent : null;
  }
  return chain.reverse().flatMap((node) => {
    const message = (node as { message?: unknown }).message;
    if (!message || typeof message !== "object") return [];
    const role = ((message as { author?: { role?: unknown } }).author?.role);
    if (role !== "user" && role !== "assistant" && role !== "system") return [];
    const parts = ((message as { content?: { parts?: unknown[] } }).content?.parts ?? []).filter((part): part is string => typeof part === "string");
    const content = parts.join("");
    return content ? [{ role, content }] : [];
  });
}

function extractChatGptLatestText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (obj.type === "error") {
    const error = obj.error as { message?: string } | undefined;
    throw new Error(error?.message ?? "ChatGPT returned an error");
  }
  const message = obj.message as { author?: { role?: string }; content?: { content_type?: string; parts?: unknown[] } } | undefined;
  if (message?.content?.content_type === "text" && Array.isArray(message.content.parts)) {
    const role = message.author?.role;
    if (role === "assistant") {
      const parts = message.content.parts.filter((p): p is string => typeof p === "string");
      if (parts.length > 0) return parts.join("");
    }
    return null;
  }
  const streamOp = typeof obj.o === "string" ? obj.o : null;
  if (streamOp === "append" && typeof obj.p === "string" && obj.p.startsWith("/message/content/parts") && typeof obj.v === "string") {
    return obj.v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

async function* sendChatGptMessage(
  context: BrowserContext, messages: ChatMessage[], model: string,
  _options: ChatOptions, conversationId: string | null, parentMessageId: string | null,
): AsyncGenerator<ChatChunk> {
  const parseSSEChunk = createSSEParser();
  const headers = await chatGptCompletionHeaders(context);
  const payload = buildPayload(messages, model, conversationId, parentMessageId);

  const completionRes = await fetch("https://chatgpt.com/backend-api/conversation", {
    method: "POST", headers,
    body: JSON.stringify({ ...payload, action: "next", history_and_training_disabled: false, conversation_mode: { kind: "primary_assistant" }, force_paragen: false, force_rate_limit: false }),
  });
  if (!completionRes.ok || !completionRes.body) throw new Error(`ChatGPT conversation request failed: ${completionRes.status}`);

  const reader = completionRes.body.getReader();
  const decoder = new TextDecoder();
  let lastText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parseSSEChunk(decoder.decode(value, { stream: true }))) {
      const newText = extractChatGptLatestText(event.data);
      if (newText !== null && newText.length > lastText.length && newText.startsWith(lastText)) {
        yield { kind: "content", text: newText.slice(lastText.length) };
        lastText = newText;
      } else if (newText !== null && newText !== lastText && !newText.startsWith(lastText)) {
        yield { kind: "content", text: newText };
        lastText += newText;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Model normalization
// ---------------------------------------------------------------------------

export function normalizeChatGptModelPayload(payload: unknown, provider: string): ModelInfo[] {
  const obj = payload && typeof payload === "object" ? payload as { models?: unknown } : {};
  const items = Array.isArray(obj.models) ? obj.models : [];
  return dedupeModels(items.flatMap((item): ModelInfo[] => {
    if (!item || typeof item !== "object") return [];
    const model = item as { slug?: unknown; title?: unknown; name?: unknown };
    const id = typeof model.slug === "string" ? model.slug.trim() : "";
    if (!id) return [];
    const title = typeof model.title === "string" && model.title.trim() ? model.title.trim()
      : typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
    return [{ id, name: title, provider }];
  }));
}

function dedupeModels(models: ModelInfo[]) {
  const seen = new Set<string>();
  const deduped: ModelInfo[] = [];
  for (const model of models) {
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(model);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Adapter object
// ---------------------------------------------------------------------------

export const chatgptAdapter = {
  id: "chatgpt" as const,
  name: "ChatGPT",
  baseUrl: "https://chatgpt.com",
  loginUrl: "https://chatgpt.com/auth/login",
  models: [] as ModelInfo[],

  async detectLoginSuccess(context?: unknown): Promise<boolean> {
    const ctx = context as BrowserContext;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded" });
    const token = await readChatGptAccessToken(ctx, page);
    if (token) return true;
    return page.locator('textarea, [contenteditable="true"]').first().isVisible().catch(() => false);
  },

  async listModels(context?: unknown): Promise<ModelInfo[]> {
    const headers = await chatGptHeaders(context as BrowserContext, "application/json");
    const res = await fetch("https://chatgpt.com/backend-api/models?history_and_training_disabled=false", { headers });
    if (!res.ok) throw new Error(`ChatGPT model list request failed: ${res.status}`);
    const payload = await res.json() as unknown;
    const models = normalizeChatGptModelPayload(payload, "chatgpt");
    if (models.length === 0) throw new Error("ChatGPT model list response did not include any models");
    return models;
  },

  async listConversations(context?: unknown): Promise<ProviderConversation[]> {
    const headers = await chatGptHeaders(context as BrowserContext, "application/json");
    const res = await fetch("https://chatgpt.com/backend-api/conversations?offset=0&limit=50&order=updated", { headers });
    if (!res.ok) throw new Error(`ChatGPT conversation list request failed: ${res.status}`);
    const payload = await res.json() as { items?: unknown[]; conversations?: unknown[] };
    const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.conversations) ? payload.conversations : [];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const conversation = item as Record<string, unknown>;
      const id = typeof conversation.id === "string" ? conversation.id : typeof conversation.conversation_id === "string" ? conversation.conversation_id : null;
      if (!id) return [];
      const title = typeof conversation.title === "string" && conversation.title.trim() ? conversation.title.trim() : "Untitled conversation";
      const updatedAt = typeof conversation.update_time === "string" ? conversation.update_time : typeof conversation.update_time === "number" ? new Date(conversation.update_time * 1000).toISOString() : undefined;
      return [{ id, provider: "chatgpt", title, updatedAt, url: `https://chatgpt.com/c/${id}` }];
    });
  },

  async loadConversationMessages(context: unknown, conversationId: string): Promise<ChatMessage[]> {
    const detail = await fetchChatGptConversation(context as BrowserContext, conversationId);
    const mapping = detail.mapping && typeof detail.mapping === "object" ? detail.mapping as Record<string, unknown> : {};
    return flattenChatGptMessages(mapping, typeof detail.current_node === "string" ? detail.current_node : null);
  },

  async *sendMessageToConversation(context: unknown, conversationId: string, messages: ChatMessage[], model: string, options: ChatOptions): AsyncGenerator<ChatChunk> {
    const detail = await fetchChatGptConversation(context as BrowserContext, conversationId).catch(() => ({ current_node: null }));
    yield* sendChatGptMessage(context as BrowserContext, messages, model, options, conversationId, typeof detail.current_node === "string" ? detail.current_node : null);
  },

  async *sendMessage(context: unknown, messages: ChatMessage[], model: string, options: ChatOptions): AsyncGenerator<ChatChunk> {
    yield* sendChatGptMessage(context as BrowserContext, messages, model, options, null, null);
  },

  async validateSession(_context?: unknown): Promise<boolean> {
    return hasProviderSessionArtifacts("chatgpt", loadSession("chatgpt"));
  },
};
