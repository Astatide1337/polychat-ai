const MODEL_ALIASES: Record<string, string> = {
  "gpt-5-mini": "gpt-5-5",
  "gpt-4.1-mini": "gpt-5-5",
  "deepseek-v4-flash": "deepseek-chat",
  "gemini-3.1-flash-lite": "gemini-2.5-flash",
  "gemini-3-flash": "gemini-2.5-flash",
  "gemini-3.1-pro": "gemini-2.5-pro",
  "gemini-3-pro": "gemini-2.5-pro",
  "kimi-k2.6": "k2",
  "kimi-k2": "k2",
};

export function canonicalModelId(model: string): string | null {
  return MODEL_ALIASES[model] ?? null;
}

export function modelMatches(requested: string, available: string): boolean {
  return requested === available || canonicalModelId(requested) === available;
}
