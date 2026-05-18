import { chatgptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { deepseekAdapter } from "./deepseek.js";
import { geminiAdapter } from "./gemini.js";
import { kimiAdapter } from "./kimi.js";
import type { ModelInfo, ProviderAdapter } from "./types.js";

const adapters: Record<string, ProviderAdapter> = {
  chatgpt: chatgptAdapter,
  claude: claudeAdapter,
  deepseek: deepseekAdapter,
  gemini: geminiAdapter,
  kimi: kimiAdapter,
};

export function getAdapter(providerId: string): ProviderAdapter {
  const adapter = adapters[providerId];
  if (!adapter) {
    throw new Error(`Unknown provider "${providerId}". Available: ${Object.keys(adapters).join(", ")}`);
  }
  return adapter;
}

export function getAdapterForModel(modelId: string): ProviderAdapter {
  for (const adapter of Object.values(adapters)) {
    if (adapter.models.some((model) => model.id === modelId)) return adapter;
  }
  throw new Error(`Model '${modelId}' not found. Run 'polychat models' to see available models.`);
}

export function getAllModels(): ModelInfo[] {
  return Object.values(adapters).flatMap((adapter) => adapter.models);
}
