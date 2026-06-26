import type { ProviderId } from "@polychat-ai/history-core/browser";

import { storageGet, storageSet } from "./webext.js";

export type ExtensionSettings = {
  serverUrl: string;
  ingestToken: string;
  lastSyncAt: string | null;
  lastResult: string | null;
  testConversationIds: Record<ProviderId, string>;
};

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
};

const STORAGE_KEY = "polychat-ai-extension-settings";

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await storageGet<Record<string, Partial<ExtensionSettings>>>(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored?.[STORAGE_KEY] ?? {}) };
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const merged = { ...(await loadSettings()), ...settings };
  await storageSet({ [STORAGE_KEY]: merged });
  return merged;
}
