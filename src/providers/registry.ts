import type { LoginInfo } from "./types.js";

const providers: Record<string, LoginInfo> = {
  chatgpt: { id: "chatgpt", name: "ChatGPT", loginUrl: "https://chatgpt.com/auth/login", defaultModel: "gpt-5-mini" },
  claude: { id: "claude", name: "Claude", loginUrl: "https://claude.ai/login", defaultModel: "claude-sonnet-4-6" },
  deepseek: { id: "deepseek", name: "DeepSeek", loginUrl: "https://chat.deepseek.com/sign_in", defaultModel: "deepseek-chat" },
  gemini: { id: "gemini", name: "Gemini", loginUrl: "https://gemini.google.com", defaultModel: "gemini-2.5-flash" },
  kimi: { id: "kimi", name: "Kimi", loginUrl: "https://www.kimi.com", defaultModel: "kimi" },
};

export function getLoginInfo(providerId: string): LoginInfo {
  const info = providers[providerId];
  if (!info) throw new Error(`Unknown provider "${providerId}". Available: ${Object.keys(providers).join(", ")}`);
  return info;
}
