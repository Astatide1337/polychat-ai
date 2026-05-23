import { hasProviderSessionArtifacts } from "../browser/profile.js";
import { loadSession, saveSession } from "../session/store.js";
import { loadConfig, saveConfig } from "../config/index.js";

// ---------------------------------------------------------------------------
// Token persistence — used by cdp.ts during login
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

export function saveDeepSeekToken(token: string): void {
  const config = loadConfig();
  saveSession("deepseek", { userToken: token });
  if (config.providers.deepseek) {
    config.providers.deepseek.connected = true;
    config.providers.deepseek.lastValidated = new Date().toISOString();
    saveConfig(config);
  }
}

/** Detect DeepSeek session artifacts from a storage state object. */
export function detectDeepSeekSessionArtifacts(session: unknown): boolean {
  return hasProviderSessionArtifacts("deepseek", session);
}
