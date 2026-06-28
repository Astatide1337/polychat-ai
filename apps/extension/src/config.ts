import type { ProviderId } from "@polychat-ai/history-core/browser";

import { storageGet, storageSet } from "./webext.js";

export type ConversationSyncCacheEntry = {
  summaryUpdatedAt: string | null;
  messagesUpdatedAt: string | null;
  messageCount: number;
  lastMessageId: string | null;
  lastMessageUpdatedAt: string | null;
  lastSyncedAt: string;
};

export type SyncCache = Record<ProviderId, Record<string, ConversationSyncCacheEntry>>;

export type ExtensionSettings = {
  serverUrl: string;
  ingestToken: string;
  lastSyncAt: string | null;
  lastResult: string | null;
  testConversationIds: Record<ProviderId, string>;
  syncCache: SyncCache;
};

function createSyncCache(): SyncCache {
  return {
    chatgpt: {},
    claude: {},
    gemini: {},
  };
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function normalizeConversationSyncCacheEntry(value: unknown): ConversationSyncCacheEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return {
    summaryUpdatedAt: normalizeTimestamp(input.summaryUpdatedAt),
    messagesUpdatedAt: normalizeTimestamp(input.messagesUpdatedAt),
    messageCount: Number.isFinite(Number(input.messageCount)) ? Math.max(0, Math.trunc(Number(input.messageCount))) : 0,
    lastMessageId: typeof input.lastMessageId === "string" && input.lastMessageId.trim() ? input.lastMessageId.trim() : null,
    lastMessageUpdatedAt: normalizeTimestamp(input.lastMessageUpdatedAt),
    lastSyncedAt: normalizeTimestamp(input.lastSyncedAt) ?? new Date().toISOString(),
  };
}

export function normalizeSyncCache(value: unknown): SyncCache {
  const cache = createSyncCache();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return cache;
  }
  const input = value as Partial<Record<ProviderId, unknown>>;
  for (const provider of ["chatgpt", "claude", "gemini"] as ProviderId[]) {
    const providerCache = input[provider];
    if (!providerCache || typeof providerCache !== "object" || Array.isArray(providerCache)) continue;
    const normalized: Record<string, ConversationSyncCacheEntry> = {};
    for (const [conversationId, entry] of Object.entries(providerCache as Record<string, unknown>)) {
      const normalizedEntry = normalizeConversationSyncCacheEntry(entry);
      if (!normalizedEntry) continue;
      const id = conversationId.trim();
      if (!id) continue;
      normalized[id] = normalizedEntry;
    }
    cache[provider] = normalized;
  }
  return cache;
}

export function normalizeSettings(settings: Partial<ExtensionSettings>): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    testConversationIds: {
      ...DEFAULT_SETTINGS.testConversationIds,
      ...(settings.testConversationIds ?? {}),
    },
    syncCache: normalizeSyncCache(settings.syncCache ?? DEFAULT_SETTINGS.syncCache),
  };
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: "http://127.0.0.1:3333",
  ingestToken: "",
  lastSyncAt: null,
  lastResult: null,
  testConversationIds: {
    chatgpt: "",
    claude: "",
    gemini: "",
  },
  syncCache: createSyncCache(),
};

const STORAGE_KEY = "polychat-ai-extension-settings";

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await storageGet<Record<string, Partial<ExtensionSettings>>>(STORAGE_KEY);
  return normalizeSettings(stored?.[STORAGE_KEY] ?? {});
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const merged = normalizeSettings({ ...(await loadSettings()), ...settings });
  await storageSet({ [STORAGE_KEY]: merged });
  return merged;
}
