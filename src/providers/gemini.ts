import type { ModelInfo, ProviderAdapter, ProviderConversation } from "./types.js";

// ---------------------------------------------------------------------------
// Known Gemini models
// ---------------------------------------------------------------------------

const KNOWN_GEMINI_MODELS: ModelInfo[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "gemini" },
];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  name: "Gemini",
  baseUrl: "https://gemini.google.com",
  loginUrl: "https://gemini.google.com",
  models: [],

  async listModels(_context?: unknown): Promise<ModelInfo[]> {
    return KNOWN_GEMINI_MODELS;
  },

  async detectLoginSuccess(_context?: unknown): Promise<boolean> {
    // Gemini session detected by presence of __Secure-1PSID or COMPASS cookie
    // from gemini.google.com domain
    if (!_context || typeof _context !== "object") return false;
    const ctx = _context as Record<string, unknown>;
    const cookies = Array.isArray(ctx.cookies)
      ? (ctx.cookies as Array<{ domain?: string; name?: string; value?: string }>)
      : [];
    return cookies.some(
      (c) =>
        (c.domain?.includes("gemini.google.com") || c.domain?.includes(".google.com")) &&
        (c.name === "COMPASS" || c.name === "__Secure-1PSID") &&
        (c.value?.length ?? 0) > 10,
    );
  },

  async validateSession(_context?: unknown): Promise<boolean> {
    return true; // Rust server validates via /health
  },

  async listConversations(_context?: unknown): Promise<ProviderConversation[]> {
    return [];
  },
};
