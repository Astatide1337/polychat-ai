import { Command } from "commander";
import { loginWithOAuth, OAUTH_PROVIDERS } from "../browser/oauth.js";
import { detectBrowserKind } from "../browser/detect.js";
import { loginWithCDP, type CdpCookie } from "../browser/cdp.js";
import {
  findFirefoxProfileDirForProvider,
  readFirefoxStorageState,
  hasProviderSessionArtifacts,
  toPlaywrightStorageState,
  injectDeepSeekModels,
  filterStateForProvider,
} from "../browser/profile.js";
import { getLoginInfo } from "../providers/registry.js";
import { saveSession } from "../session/store.js";
import { loadConfig, saveConfig } from "../config/index.js";
import { openUrlInDefaultBrowser } from "../browser/external.js";
import type { FirefoxStorageState } from "../browser/profile.js";

function markProviderConnected(provider: string, defaultModel: string) {
  const config = loadConfig();
  if (!config.providers[provider]) {
    config.providers[provider] = { connected: false, defaultModel } as typeof config.providers[string];
  }
  if (!config.providers[provider].defaultModel) {
    config.providers[provider].defaultModel = defaultModel;
  }
  config.providers[provider].connected = true;
  config.providers[provider].lastValidated = new Date().toISOString();
  saveConfig(config);
}

function makeCdpDetectSuccess(provider: string) {
  if (provider === "deepseek") {
    return (cookies: CdpCookie[], _currentUrl: string): boolean => {
      return cookies.some(
        (c) => c.domain.includes("deepseek.com") && c.name === "ds_session_id" && c.value.length > 0,
      );
    };
  }
  if (provider === "kimi") {
    return (cookies: CdpCookie[], _currentUrl: string): boolean => {
      return cookies.some(
        (c) => c.domain.includes("kimi.com") && c.name === "kimi-auth" && c.value.length > 100,
      );
    };
  }
  // Generic fallback: check if we've navigated away from the login page
  return (_cookies: CdpCookie[], currentUrl: string): boolean => {
    const info = getLoginInfo(provider);
    const loginUrl = info.loginUrl;
    try {
      const loginPath = new URL(loginUrl).pathname;
      const currentPath = new URL(currentUrl).pathname;
      if (currentPath !== loginPath) return true;
    } catch {
      if (currentUrl !== loginUrl) return true;
    }
    return false;
  };
}

async function loginViaFirefoxProfile(provider: string, loginUrl: string, providerName: string) {
  openUrlInDefaultBrowser(loginUrl);
  console.log(`Browser opened in your default browser. Please log in to ${providerName}...`);
  console.log("Waiting for login to complete...");

  const timeoutMs = 5 * 60 * 1000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const profileDir = findFirefoxProfileDirForProvider(provider);
    if (profileDir) {
      const state = readFirefoxStorageState(profileDir);
      if (hasProviderSessionArtifacts(provider, state)) {
        const filteredState = filterStateForProvider(provider, state!);
        const hydratedState = provider === "chatgpt"
          ? await maybeHydrateChatGptState(filteredState)
          : filteredState;
        let storageState = toPlaywrightStorageState(hydratedState!);
        if (provider === "deepseek") {
          storageState = injectDeepSeekModels(storageState, hydratedState!) as typeof storageState;
        }
        saveSession(provider, storageState);
        const info = getLoginInfo(provider);
        markProviderConnected(provider, info.defaultModel);
        console.log(`✓ Logged in to ${providerName} successfully. Session saved.`);
        return;
      }
    }
    await delay(2000);
  }
  console.error("✗ Login timed out. Please try again.");
  process.exitCode = 1;
}

async function maybeHydrateChatGptState(state: FirefoxStorageState | null) {
  if (!state) return state;
  const accessToken = await readChatGptAccessTokenFromCookies(state); 
  if (!accessToken) return state;
  const origins = state.origins.filter((origin) => origin.origin !== "https://chatgpt.com");
  origins.push({
    origin: "https://chatgpt.com",
    localStorage: [{ name: "accessToken", value: accessToken }],
  });
  return { ...state, origins };
}

async function readChatGptAccessTokenFromCookies(state: FirefoxStorageState) {
  // Priority-order essential auth cookies, capped at 8KB to avoid HTTP 431.
  // Mirrors the Rust extract_chatgpt_cookies logic.
  const all = state.cookies
    .filter((c) => /chatgpt\.com|openai\.com/i.test(c.domain));
  const essential = all.filter((c) =>
    c.name.includes("session-token") ||
    c.name.includes("oai-is") ||
    c.name.includes("oai-client-auth") ||
    c.name === "__cf_bm" ||
    c.name === "__cflb" ||
    c.name === "cf_clearance" ||
    c.name === "oai-sc" ||
    c.name === "_puid" ||
    c.name === "oai-did"
  );
  // Sort: session tokens first
  essential.sort((a, b) => {
    const pri = (n: string) => n.includes("session-token") ? 0 : n.includes("oai-is") ? 1 : 2;
    return pri(a.name) - pri(b.name);
  });
  let cookieHeader = "";
  for (const c of essential) {
    const pair = `${c.name}=${c.value}`;
    if (cookieHeader.length + pair.length + 2 > 8000) break;
    cookieHeader += (cookieHeader ? "; " : "") + pair;
  }
  // If essential cookies alone are too few, add remaining valid cookies up to 8KB
  if (cookieHeader.length < 500) {
    const now = Date.now() / 1000;
    const remaining = all.filter((c) => !essential.includes(c) && (!c.expires || c.expires > now));
    for (const c of remaining) {
      const pair = `${c.name}=${c.value}`;
      if (cookieHeader.length + pair.length + 2 > 8000) break;
      cookieHeader += (cookieHeader ? "; " : "") + pair;
    }
  }
  const res = await fetch("https://chatgpt.com/api/auth/session", {
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: cookieHeader,
      origin: "https://chatgpt.com",
      referer: "https://chatgpt.com/",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
    },
  });
  if (!res.ok) return null;
  const session = await res.json() as { accessToken?: string | null };
  return session.accessToken ?? null;
}

export function registerLoginCommand(program: Command) {
  program
    .command("login <provider>")
    .description("Login to a provider")
    .action(async (provider: string) => {
      try {
        const info = getLoginInfo(provider);

        if (provider === "chatgpt") {
        // ChatGPT login: prefer Firefox profile reading over OAuth.
        // The OAuth path saves {type: "oauth"} tokens that the Rust provider
        // cannot use (it needs cookie-based storageState with accessToken).
        // Since chatgpt.com is typically already logged in via the browser,
        // reading from the Firefox profile is faster and produces the right format.
        const profileDir = findFirefoxProfileDirForProvider(provider);
        if (profileDir) {
          const state = readFirefoxStorageState(profileDir);
          if (state && hasProviderSessionArtifacts(provider, state)) {
            const filteredState = filterStateForProvider(provider, state);
            const hydratedState = await maybeHydrateChatGptState(filteredState);
            const storageState = toPlaywrightStorageState(hydratedState!);
            saveSession(provider, storageState);
            markProviderConnected(provider, info.defaultModel);
            console.log(`✓ Logged in to ${info.name} successfully. Session saved.`);
            return;
          }
        }
        // No Firefox profile with ChatGPT cookies — fall through to OAuth
      }

      if (provider in OAUTH_PROVIDERS) {
        await loginWithOAuth(provider);
        markProviderConnected(provider, info.defaultModel);
        console.log(`✓ Logged in to ${info.name} successfully. Session saved.`);
        return;
      }

      const browserInfo = await detectBrowserKind();
        if (browserInfo.kind === "unsupported") {
          console.error(
            browserInfo.unsupportedReason ??
              "Safari is not supported for login. Please set Chrome, Brave, or Firefox as your default browser.",
          );
          process.exitCode = 1;
          return;
        }

        if (browserInfo.kind === "chromium") {
          await loginWithCDP(provider, info.loginUrl, makeCdpDetectSuccess(provider));
          markProviderConnected(provider, info.defaultModel);
          console.log(`✓ Logged in to ${info.name} successfully. Session saved.`);
          return;
        }

        if (browserInfo.kind === "firefox") {
          await loginViaFirefoxProfile(provider, info.loginUrl, info.name);
          return;
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
