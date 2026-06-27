import type { ProviderAdapter, ProviderId } from "@polychat-ai/history-core/browser";

import { chatgptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { geminiAdapter } from "./gemini.js";

export const PROVIDER_ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  chatgpt: chatgptAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter,
};

export function detectProvider(url: string): ProviderId | null {
  if (url.includes("chatgpt.com")) return "chatgpt";
  if (url.includes("claude.ai")) return "claude";
  if (url.includes("gemini.google.com")) return "gemini";
  return null;
}
