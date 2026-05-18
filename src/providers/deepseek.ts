import { createSSEParser } from "../utils/stream.js";
import { buildPowHeader, solveDeepSeekPoW } from "../utils/deepseek-pow.js";
import { hasProviderSessionArtifacts } from "../browser/profile.js";
import { loadSession, saveSession } from "../session/store.js";
import { loadConfig, saveConfig } from "../config/index.js";
import type { ChatChunk, ChatMessage, ChatOptions, ModelInfo, ProviderConversation } from "./types.js";

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

function extractTokenFromStorageState(state: Record<string, unknown>): string | null {
  const origins = Array.isArray(state.origins) ? state.origins : [];
  for (const origin of origins) {
    if (!origin || typeof origin !== "object") continue;
    const ls = Array.isArray((origin as { localStorage?: unknown[] }).localStorage)
      ? (origin as { localStorage: Array<{ name?: string; value?: string }> }).localStorage
      : [];
    for (const entry of ls) {
      if (entry?.name?.toLowerCase() === "usertoken" && entry.value) {
        try {
          const parsed = JSON.parse(entry.value) as { value?: unknown };
          if (typeof parsed.value === "string" && parsed.value.trim()) return parsed.value.trim();
        } catch {
          if (entry.value.trim().length > 20) return entry.value.trim();
        }
      }
    }
  }
  return null;
}

function readDeepSeekToken(): string | null {
  const raw = loadSession("deepseek");
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Record<string, unknown>;
  if (typeof state.userToken === "string" && state.userToken.trim()) return state.userToken.trim();
  return extractTokenFromStorageState(state);
}

export function saveDeepSeekToken(token: string): void {
  const config = loadConfig();
  saveSession("deepseek", { userToken: token });
  if (config.providers.deepseek) {
    config.providers.deepseek.connected = true;
    config.providers.deepseek.lastValidated = new Date().toISOString();
    saveConfig(config);
  }
}

// ---------------------------------------------------------------------------
// Model config — read from session localStorage captured at login
// ---------------------------------------------------------------------------

interface DeepSeekModelConfig {
  model_type: string;
  name?: string;
  description?: string;
  enabled?: boolean;
}

function readDeepSeekModelConfigs(): DeepSeekModelConfig[] | null {
  try {
    const raw = loadSession("deepseek");
    if (!raw || typeof raw !== "object") return null;
    const state = raw as Record<string, unknown>;
    const origins = Array.isArray(state.origins) ? state.origins : [];
    for (const origin of origins) {
      if (!origin || typeof origin !== "object") continue;
      const ls = Array.isArray((origin as { localStorage?: unknown[] }).localStorage)
        ? (origin as { localStorage: Array<{ name?: string; value?: string }> }).localStorage
        : [];
      for (const entry of ls) {
        if (entry?.name === "__polychat_deepseek_models" && entry.value) {
          try {
            const configs = JSON.parse(entry.value) as unknown[];
            if (Array.isArray(configs) && configs.length > 0) {
              return configs.filter(
                (c): c is DeepSeekModelConfig =>
                  c !== null && typeof c === "object" && typeof (c as DeepSeekModelConfig).model_type === "string" && (c as DeepSeekModelConfig).model_type.trim().length > 0
              );
            }
          } catch {
            // Corrupt entry — fall through to defaults
          }
        }
      }
    }
  } catch {
    // Session unreadable
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function buildBaseHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-client-platform": "web",
    "x-client-version": "2.0.0",
    "x-app-version": "2.0.0",
    "x-client-locale": "en_US",
    "x-client-timezone-offset": String(-new Date().getTimezoneOffset()),
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
    origin: "https://chat.deepseek.com",
    referer: "https://chat.deepseek.com/",
    accept: "*/*",
  };
}

function resolveModelId(model: string): string {
  const stripped = model.startsWith("deepseek-") ? model.slice("deepseek-".length) : model;
  const aliases: Record<string, string> = {
    chat: "default", v3: "default", "v3-0324": "default",
    v4: "default", "v4-flash": "default", DEFAULT: "default",
    r1: "default", reasoner: "default", "r1-0528": "default",
    expert: "expert", vision: "vision", default: "default",
  };
  return aliases[stripped] ?? stripped;
}

function formatLastUserMessage(messages: ChatMessage[]): string {
  if (messages.length === 0) return "";
  const last = messages[messages.length - 1];
  if (messages.length === 1) return last.content;
  const history = messages.slice(0, -1).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  return `${history}\n\nUser: ${last.content}`;
}

// ---------------------------------------------------------------------------
// DeepSeek API calls (pure HTTPS)
// ---------------------------------------------------------------------------

async function createChatSession(headers: Record<string, string>): Promise<string> {
  const res = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
    method: "POST", headers, body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`DeepSeek session creation failed: ${res.status}`);
  const json = await res.json() as { data?: { biz_data?: { chat_session?: { id?: string } } } };
  const id = json?.data?.biz_data?.chat_session?.id;
  if (!id) throw new Error("DeepSeek session creation did not return a session ID");
  return id;
}

async function listChatSessions(headers: Record<string, string>): Promise<ProviderConversation[]> {
  const res = await fetch("https://chat.deepseek.com/api/v0/chat_session/fetch_page?page_size=50&sort_type=updated_at", { headers });
  if (!res.ok) return [];
  const json = await res.json() as { data?: { biz_data?: { chat_sessions?: unknown[] } } };
  const sessions = json?.data?.biz_data?.chat_sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.flatMap((s): ProviderConversation[] => {
    if (!s || typeof s !== "object") return [];
    const session = s as { id?: string; title?: string; updated_at?: number };
    const id = typeof session.id === "string" ? session.id : null;
    if (!id) return [];
    const title = typeof session.title === "string" && session.title.trim() ? session.title.trim() : "Untitled conversation";
    const updatedAt = typeof session.updated_at === "number" ? new Date(session.updated_at * 1000).toISOString() : undefined;
    return [{ id, provider: "deepseek", title, updatedAt, url: `https://chat.deepseek.com/a/chat/s/${id}` }];
  });
}

interface DeepSeekChallenge {
  algorithm: string; challenge: string; salt: string; signature: string;
  difficulty: number; expire_at: number; expire_after: number; target_path: string;
}

async function fetchChallenge(headers: Record<string, string>, targetPath: string): Promise<DeepSeekChallenge> {
  const res = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
    method: "POST", headers, body: JSON.stringify({ target_path: targetPath }),
  });
  if (!res.ok) throw new Error(`DeepSeek PoW challenge request failed: ${res.status}`);
  const json = await res.json() as { data?: { biz_data?: { challenge?: DeepSeekChallenge } } };
  const chal = json?.data?.biz_data?.challenge;
  if (!chal) throw new Error("DeepSeek PoW challenge response missing challenge data");
  return chal;
}

function extractTextFromEvent(obj: Record<string, unknown>, responseFragmentStarted: boolean): {
  text: string | null; thinking: string | null; responseStarted: boolean;
} {
  const path = typeof obj.p === "string" ? obj.p : null;
  const op = typeof obj.o === "string" ? obj.o : null;
  const val = obj.v;

  const snapshotFragments = val && typeof val === "object"
    ? (((val as { response?: { fragments?: unknown } }).response?.fragments) ?? null) : null;
  if (Array.isArray(snapshotFragments)) {
    for (const frag of snapshotFragments) {
      if (!frag || typeof frag !== "object") continue;
      const f = frag as { type?: string; content?: string };
      if (typeof f.content === "string") {
        if (f.type === "RESPONSE") return { text: f.content || null, thinking: null, responseStarted: true };
        if (!responseFragmentStarted) return { text: null, thinking: f.content || null, responseStarted: false };
      }
    }
  }

  if (path?.startsWith("response/fragments") && op === "APPEND" && (Array.isArray(val) || (val && typeof val === "object"))) {
    const fragments = Array.isArray(val) ? val : [val];
    for (const frag of fragments) {
      if (!frag || typeof frag !== "object") continue;
      const f = frag as { type?: string; content?: string };
      if (typeof f.content === "string") {
        if (f.type === "RESPONSE") return { text: f.content || null, thinking: null, responseStarted: true };
        return { text: null, thinking: f.content || null, responseStarted: false };
      }
    }
    return { text: null, thinking: null, responseStarted: false };
  }

  if (path?.startsWith("response/fragments") && typeof val === "string") {
    if (!responseFragmentStarted) return { text: null, thinking: val || null, responseStarted: false };
    return { text: val || null, thinking: null, responseStarted: true };
  }

  if (path?.includes("/content") && typeof val === "string") {
    if (!responseFragmentStarted) return { text: null, thinking: val || null, responseStarted: false };
    return { text: val || null, thinking: null, responseStarted: true };
  }

  if (typeof val === "string" && path === null && op === null) {
    if (!responseFragmentStarted) return { text: null, thinking: val || null, responseStarted: false };
    return { text: val || null, thinking: null, responseStarted: true };
  }

  return { text: null, thinking: null, responseStarted: responseFragmentStarted };
}

async function* streamCompletion(
  headers: Record<string, string>, sessionId: string, prompt: string, modelType: string,
): AsyncGenerator<ChatChunk> {
  const chal = await fetchChallenge(headers, "/api/v0/chat/completion");
  const answer = await solveDeepSeekPoW(chal);
  const powHeader = buildPowHeader(answer, "/api/v0/chat/completion");

  const res = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
    method: "POST",
    headers: { ...headers, "x-ds-pow-response": powHeader },
    body: JSON.stringify({
      chat_session_id: sessionId, parent_message_id: null,
      model_type: modelType, prompt, ref_file_ids: [],
      thinking_enabled: false, search_enabled: false, preempt: false,
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek completion request failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const parseSSEChunk = createSSEParser();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let responseFragmentStarted = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parseSSEChunk(decoder.decode(value, { stream: true }))) {
      if (!event.data || typeof event.data !== "object") continue;
      const result = extractTextFromEvent(event.data as Record<string, unknown>, responseFragmentStarted);
      if (result.thinking !== null) yield { kind: "thinking", text: result.thinking };
      if (result.text !== null) yield { kind: "content", text: result.text };
      if (result.responseStarted) responseFragmentStarted = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter object — plain object, not a class
// ---------------------------------------------------------------------------

export const deepseekAdapter = {
  id: "deepseek" as const,
  name: "DeepSeek",
  baseUrl: "https://chat.deepseek.com",
  loginUrl: "https://chat.deepseek.com/sign_in",
  models: [] as ModelInfo[],

  async listModels(_context?: unknown): Promise<ModelInfo[]> {
    const token = readDeepSeekToken();
    if (!token) throw new Error("DeepSeek session is missing credentials. Run 'polychat login deepseek' to authenticate.");

    const res = await fetch("https://chat.deepseek.com/api/v0/users/current", {
      headers: buildBaseHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];

    const configs = readDeepSeekModelConfigs();
    if (configs && configs.length > 0) {
      return configs.filter((c) => c.enabled !== false).map((c) => ({
        id: `deepseek-${c.model_type}`,
        name: c.name ?? `DeepSeek ${c.model_type}`,
        provider: "deepseek",
      }));
    }
    return [
      { id: "deepseek-chat", name: "DeepSeek Chat (default)", provider: "deepseek" },
      { id: "deepseek-r1", name: "DeepSeek R1", provider: "deepseek" },
    ];
  },

  async detectLoginSuccess(context?: unknown): Promise<boolean> {
    if (context && typeof (context as { pages?: () => unknown[] }).pages === "function") {
      const pages = (context as { pages: () => Array<{ evaluate: (fn: () => unknown) => Promise<unknown> }> }).pages();
      const page = pages[0] ?? null;
      if (page) {
        const token = await page.evaluate(() => {
          try {
            const raw = localStorage.getItem("userToken");
            if (!raw) return null;
            const p = JSON.parse(raw) as { value?: unknown };
            return typeof p.value === "string" && p.value.trim().length > 20 ? p.value.trim() : null;
          } catch { return null; }
        }).catch(() => null);
        if (token) return true;
      }
    }
    try {
      return hasProviderSessionArtifacts("deepseek", loadSession("deepseek"));
    } catch { return false; }
  },

  async validateSession(_context?: unknown): Promise<boolean> {
    const token = readDeepSeekToken();
    if (!token) return false;
    try {
      const res = await fetch("https://chat.deepseek.com/api/v0/users/current", {
        headers: buildBaseHeaders(token),
        signal: AbortSignal.timeout(8_000),
      });
      return res.ok;
    } catch { return false; }
  },

  async listConversations(_context?: unknown): Promise<ProviderConversation[]> {
    const token = readDeepSeekToken();
    if (!token) return [];
    return listChatSessions(buildBaseHeaders(token));
  },

  async loadConversationMessages(): Promise<ChatMessage[]> {
    return [];
  },

  async *sendMessageToConversation(_context: unknown, conversationId: string, messages: ChatMessage[], model: string, _options: ChatOptions): AsyncGenerator<ChatChunk> {
    const token = readDeepSeekToken();
    if (!token) throw new Error("DeepSeek session is missing credentials. Run 'polychat login deepseek' to authenticate.");
    const headers = buildBaseHeaders(token);
    const prompt = formatLastUserMessage(messages);
    yield* streamCompletion(headers, conversationId, prompt, resolveModelId(model));
  },

  async *sendMessage(_context: unknown, messages: ChatMessage[], model: string, _options: ChatOptions): AsyncGenerator<ChatChunk> {
    const token = readDeepSeekToken();
    if (!token) throw new Error("DeepSeek session is missing credentials. Run 'polychat login deepseek' to authenticate.");
    const headers = buildBaseHeaders(token);
    const prompt = formatLastUserMessage(messages);
    const sessionId = await createChatSession(headers);
    yield* streamCompletion(headers, sessionId, prompt, resolveModelId(model));
  },
};
