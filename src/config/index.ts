import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const PROVIDERS = {
  chatgpt: { name: "ChatGPT", defaultModel: "gpt-5-5" },
  claude: { name: "Claude", defaultModel: "claude-sonnet-4-6" },
  deepseek: { name: "DeepSeek", defaultModel: "deepseek-v4-flash" },
  gemini: { name: "Gemini", defaultModel: "gemini-2.5-flash" },
  kimi: { name: "Kimi", defaultModel: "kimi" },
} as const;

const legacyProviderDefaults: Partial<Record<ProviderKey, string[]>> = {
  chatgpt: ["gpt-4o", "gpt-4.1-mini", "gpt-5-mini"],
  deepseek: ["deepseek-v4"],
};

export type ProviderKey = keyof typeof PROVIDERS;

export interface PolychatConfig {
  defaultModel: string;
  server: { port: number; host: string };
  sessionSalt: string;
  providers: Record<string, {
    defaultModel: string;
    connected: boolean;
    lastValidated: string | null;
    /** When true, all completions for this provider default to temporary chat (not saved to provider history). */
    temporary?: boolean;
  }>;
}

const CONFIG_DIR = join(homedir(), ".polychat");
const SESSION_DIR = join(CONFIG_DIR, "sessions");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function ensureDirs() {
  mkdirSync(SESSION_DIR, { recursive: true });
}

export function getConfigDir() {
  ensureDirs();
  return CONFIG_DIR;
}

export function getSessionDir() {
  ensureDirs();
  return SESSION_DIR;
}

export function loadConfig(): PolychatConfig {
  ensureDirs();
  if (!existsSync(CONFIG_FILE)) {
    const config: PolychatConfig = {
      defaultModel: PROVIDERS.claude.defaultModel,
      server: { port: 1443, host: "127.0.0.1" },
      sessionSalt: randomBytes(32).toString("hex"),
      providers: Object.fromEntries(
        Object.entries(PROVIDERS).map(([key, provider]) => [key, {
          defaultModel: provider.defaultModel,
          connected: false,
          lastValidated: null,
        }]),
      ),
    };
    saveConfig(config);
    return config;
  }

  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PolychatConfig;
  let changed = false;

  if (!config.defaultModel?.trim()) {
    config.defaultModel = PROVIDERS.claude.defaultModel;
    changed = true;
  }

  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    const providerKey = providerId as ProviderKey;
    const providerConfig = config.providers[providerId];
    if (!providerConfig) {
      config.providers[providerId] = {
        defaultModel: provider.defaultModel,
        connected: false,
        lastValidated: null,
      };
      changed = true;
      continue;
    }

    if (!providerConfig.defaultModel?.trim()) {
      providerConfig.defaultModel = provider.defaultModel;
      changed = true;
    }

    const legacyDefaultsForProvider = legacyProviderDefaults[providerKey] ?? [];
    if (legacyDefaultsForProvider.includes(providerConfig.defaultModel)) {
      providerConfig.defaultModel = provider.defaultModel;
      changed = true;
    }
  }

  for (const providerId of Object.keys(config.providers)) {
    if (!(providerId in PROVIDERS)) {
      delete config.providers[providerId];
      changed = true;
    }
  }

  if (changed) {
    saveConfig(config);
  }

  return config;
}
export function saveConfig(config: PolychatConfig) {
	ensureDirs();
	const tempFile = `${CONFIG_FILE}.${process.pid}.tmp`;
	writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`);
	try {
		chmodSync(tempFile, 0o600);
	} catch {
		// Best effort on platforms that do not support POSIX permissions (e.g., Windows).
	}
	renameSync(tempFile, CONFIG_FILE);
	try {
		chmodSync(CONFIG_FILE, 0o600);
	} catch {
		// Best effort on platforms that do not support POSIX permissions (e.g., Windows).
	}
}
