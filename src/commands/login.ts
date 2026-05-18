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
import { getAdapter } from "../providers/registry.js";
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
				(c) =>
					c.domain.includes("deepseek.com") &&
					c.name === "ds_session_id" &&
					c.value.length > 0,
			);
		};
	}


	if (provider === "kimi") {
		return (cookies: CdpCookie[], _currentUrl: string): boolean => {
			return cookies.some(
				(c) =>
					c.domain.includes("kimi.com") &&
					c.name === "kimi-auth" &&
					c.value.length > 100,
			);
		};
	}

	// Generic fallback: check if we've navigated away from the login page
	return (_cookies: CdpCookie[], currentUrl: string): boolean => {
		const adapter = getAdapter(provider);
		const loginUrl = adapter.loginUrl;
		// If we're no longer on the login URL, consider it a success
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
				const hydratedState = provider === "chatgpt" ? await maybeHydrateChatGptState(filteredState) : filteredState;
				let storageState = toPlaywrightStorageState(hydratedState!);
				if (provider === "deepseek") {
					storageState = injectDeepSeekModels(storageState, hydratedState!) as typeof storageState;
				}
				saveSession(provider, storageState);
				markProviderConnected(provider, getAdapter(provider).models[0]?.id ?? "");
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
	origins.push({ origin: "https://chatgpt.com", localStorage: [{ name: "accessToken", value: accessToken }] });
	return { ...state, origins };
}

async function readChatGptAccessTokenFromCookies(state: FirefoxStorageState) {
	const cookieHeader = state.cookies
		.filter((cookie) => /chatgpt\.com|openai\.com/i.test(cookie.domain))
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");
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
				const adapter = getAdapter(provider);

				if (provider in OAUTH_PROVIDERS) {
					await loginWithOAuth(provider);
					markProviderConnected(provider, adapter.models[0]?.id ?? "");
					console.log(`✓ Logged in to ${adapter.name} successfully. Session saved.`);
					return;
				}

				const browserInfo = await detectBrowserKind();

				if (browserInfo.kind === "unsupported") {
					console.error(browserInfo.unsupportedReason ??
						"Safari is not supported for login. Please set Chrome, Brave, or Firefox as your default browser.");
					process.exitCode = 1;
					return;
				}

				if (browserInfo.kind === "chromium") {
					await loginWithCDP(provider, adapter.loginUrl, makeCdpDetectSuccess(provider));
					markProviderConnected(provider, adapter.models[0]?.id ?? "");
					console.log(`✓ Logged in to ${adapter.name} successfully. Session saved.`);
					return;
				}

				if (browserInfo.kind === "firefox") {
					await loginViaFirefoxProfile(provider, adapter.loginUrl, adapter.name);
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
