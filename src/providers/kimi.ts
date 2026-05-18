import type { ModelInfo, ProviderAdapter, ProviderConversation } from "./types.js";
import { loadSession } from "../session/store.js";

// ---------------------------------------------------------------------------
// Known Kimi models
// ---------------------------------------------------------------------------

const KNOWN_KIMI_MODELS: ModelInfo[] = [
  { id: "kimi", name: "Kimi", provider: "kimi" },
  { id: "k2", name: "Kimi K2", provider: "kimi" },
];

// ---------------------------------------------------------------------------
// Kimi v2 Connect RPC helpers
// ---------------------------------------------------------------------------

const V2_BASE = "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService";

/**
 * Extract kimi-auth cookie from the encrypted session file.
 */
function extractKimiAuth(): string | null {
  const session = loadSession("kimi");
  if (!session || !Array.isArray(session.cookies)) return null;
  const cookie = (session.cookies as Array<{ name?: string; domain?: string; value?: string }>)
    .find(c => c.name === "kimi-auth" && c.domain?.includes("kimi.com") && (c.value?.length ?? 0) > 100);
  return cookie?.value ?? null;
}

/**
 * Build common headers for Kimi v2 Connect RPC requests.
 */
function kimiV2Headers(auth: string): Record<string, string> {
  const deviceId = String(Math.floor(Math.random() * 9_000_000_000_000_000) + 1_000_000_000_000_000);
  const cfBm = ""; // __cf_bm re-issued by Cloudflare on each request; not required for JSON RPC
  return {
    "Authorization": `Bearer ${auth}`,
    "Cookie": `kimi-auth=${auth}${cfBm ? `; __cf_bm=${cfBm}` : ""}`,
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
    "x-msh-device-id": deviceId,
    "x-msh-platform": "web",
    "x-traffic-id": deviceId,
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const kimiAdapter: ProviderAdapter = {
  id: "kimi",
  name: "Kimi",
  baseUrl: "https://www.kimi.com",
  loginUrl: "https://www.kimi.com",
  models: [],

  async listModels(_context?: unknown): Promise<ModelInfo[]> {
    return KNOWN_KIMI_MODELS;
  },

  async detectLoginSuccess(_context?: unknown): Promise<boolean> {
    if (!_context || typeof _context !== "object") return false;
    const ctx = _context as Record<string, unknown>;
    const cookies = Array.isArray(ctx.cookies)
      ? (ctx.cookies as Array<{ domain?: string; name?: string; value?: string }>)
      : [];
    return cookies.some(
      (c) =>
        c.domain?.includes("kimi.com") &&
        c.name === "kimi-auth" &&
        (c.value?.length ?? 0) > 100,
    );
  },

  async validateSession(_context?: unknown): Promise<boolean> {
    return true; // Rust server validates via /health
  },

  async listConversations(_context?: unknown): Promise<ProviderConversation[]> {
    const auth = extractKimiAuth();
    if (!auth) return [];

    try {
      const res = await fetch(`${V2_BASE}/ListChats`, {
        method: "POST",
        headers: kimiV2Headers(auth),
        body: JSON.stringify({ page_size: 50, page_token: "" }),
      });
      if (!res.ok) return [];

      const data = await res.json() as { chats?: Array<{ id?: string; name?: string; createTime?: string; updateTime?: string }> };
      if (!Array.isArray(data.chats)) return [];

      return data.chats
        .filter(c => typeof c.id === "string" && c.id.length > 0)
        .map(c => ({
          id: c.id!,
          provider: "kimi" as const,
          title: c.name?.trim() || "Untitled conversation",
          updatedAt: c.updateTime ?? c.createTime,
          url: `https://www.kimi.com/chat/${c.id}`,
        }));
    } catch {
      return [];
    }
  },
};
