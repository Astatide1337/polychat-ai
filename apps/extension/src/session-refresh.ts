import type { ProviderId } from "@polychat-ai/history-core/browser";

import { cookiesGetAll } from "./webext.js";
import { validateServerUrl } from "./remote.js";

type RefreshableProvider = Extract<ProviderId, "chatgpt" | "claude" | "gemini">;

type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Lax" | "Strict" | "None";
};

type BrowserStorageState = {
  cookies: BrowserCookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
};

type RefreshResponse = {
  provider?: string;
  status?: string;
  message?: string;
  error?: { message?: string };
};

const COOKIE_URLS: Record<RefreshableProvider, string[]> = {
  chatgpt: [
    "https://chatgpt.com/",
    "https://chat.openai.com/",
    "https://openai.com/",
    "https://auth.openai.com/",
  ],
  claude: [
    "https://claude.ai/",
    "https://claude.com/",
    "https://anthropic.com/",
  ],
  gemini: [
    "https://gemini.google.com/",
    "https://google.com/",
    "https://www.google.com/",
    "https://accounts.google.com/",
  ],
};

function normalizeSameSite(value: unknown): BrowserCookie["sameSite"] | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "lax":
      return "Lax";
    case "strict":
      return "Strict";
    case "none":
    case "no_restriction":
      return "None";
    default:
      return undefined;
  }
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeCookie(value: unknown): BrowserCookie | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cookie = value as Record<string, unknown>;
  const name = typeof cookie.name === "string" ? cookie.name.trim() : "";
  const cookieValue = typeof cookie.value === "string" ? cookie.value : "";
  const domain = typeof cookie.domain === "string" ? cookie.domain.trim() : "";
  const path = typeof cookie.path === "string" && cookie.path.trim() ? cookie.path.trim() : "/";
  if (!name || !cookieValue || !domain) return null;
  return {
    name,
    value: cookieValue,
    domain,
    path,
    expires: toNumber(cookie.expirationDate, -1),
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

async function collectCookies(provider: RefreshableProvider): Promise<BrowserCookie[]> {
  const urls = COOKIE_URLS[provider];
  const cookies = new Map<string, BrowserCookie>();

  for (const url of urls) {
    try {
      const entries = await cookiesGetAll({ url });
      for (const entry of entries) {
        const cookie = normalizeCookie(entry);
        if (!cookie) continue;
        cookies.set([cookie.domain, cookie.path, cookie.name].join("|"), cookie);
      }
    } catch (error) {
      console.warn("[polychat-ai] cookie collection failed", {
        provider,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return [...cookies.values()].sort((left, right) => {
    if (left.domain !== right.domain) return left.domain.localeCompare(right.domain);
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.name.localeCompare(right.name);
  });
}

function buildStorageState(cookies: BrowserCookie[]): BrowserStorageState {
  return {
    cookies,
    origins: [],
  };
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: T | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const error = body as RefreshResponse | null;
    throw new Error((error?.error?.message ?? error?.message ?? text.trim()) || response.statusText);
  }
  return body ?? ({} as T);
}

export async function refreshProviderSession(
  provider: RefreshableProvider,
  serverUrl: string,
  apiKey: string,
): Promise<{ ok: true; provider: RefreshableProvider; response: RefreshResponse; cookies: number } | { ok: false; error: string }> {
  try {
    const normalizedServerUrl = validateServerUrl(serverUrl).replace(/\/+$/, "");
    const trimmedApiKey = apiKey.trim();

    const cookies = await collectCookies(provider);
    if (cookies.length === 0) {
      throw new Error(`No cookies found for ${provider}. Log in to that provider in this browser first.`);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (trimmedApiKey) {
      headers.Authorization = `Bearer ${trimmedApiKey}`;
    }

    const response = await requestJson<RefreshResponse>(`${normalizedServerUrl}/v1/sessions/${provider}`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildStorageState(cookies)),
    });

    return {
      ok: true,
      provider,
      response,
      cookies: cookies.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
