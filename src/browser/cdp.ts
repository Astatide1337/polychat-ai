// @ts-ignore — ws has no @types package installed
import WebSocket from "ws";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findChromiumExecutable } from "./executable.js";
import { saveSession } from "../session/store.js";
import { saveDeepSeekToken } from "../providers/deepseek.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cookie as returned by CDP Network.getAllCookies */
export interface CdpCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: string;
}

/** CDP target info returned by /json/list */
interface CdpTarget {
	id: string;
	webSocketDebuggerUrl: string;
	url: string;
	type: string;
	title: string;
}

/** Minimal CDP response envelope */
interface CdpResponse {
	id: number;
	result?: Record<string, unknown>;
	error?: { message: string };
}

/** Callback used by loginWithCDP to decide if login has succeeded */
export type DetectSuccess = (cookies: CdpCookie[], currentUrl: string) => boolean;

// ---------------------------------------------------------------------------
// Low-level CDP helpers
// ---------------------------------------------------------------------------

let msgId = 0;

/** Send a CDP command and wait for the matching response. */
function cdpSend(
	ws: WebSocket,
	method: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const id = ++msgId;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			ws.removeListener("message", onMessage);
			reject(new Error(`CDP command timed out: ${method}`));
		}, 15_000);

		function onMessage(data: WebSocket.Data) {
			try {
				const msg = JSON.parse(String(data)) as CdpResponse;
				if (msg.id === id) {
					clearTimeout(timeout);
					ws.removeListener("message", onMessage);
					if (msg.error) {
						reject(new Error(`CDP error: ${msg.error.message}`));
					} else {
						resolve(msg.result ?? {});
					}
				}
			} catch { /* ignore non-JSON or unrelated messages */ }
		}

		ws.on("message", onMessage);
		ws.send(JSON.stringify({ id, method, params }));
	});
}

/** Run a JS expression in the page and return the result. */
async function cdpEvaluate(ws: WebSocket, expression: string): Promise<unknown> {
	const result = await cdpSend(ws, "Runtime.evaluate", {
		expression,
		returnByValue: true,
	});
	return (result as { result?: { value?: unknown } }).result?.value ?? null;
}

// ---------------------------------------------------------------------------
// Browser launch + CDP discovery
// ---------------------------------------------------------------------------

async function launchChromiumWithCDP(loginUrl: string): Promise<{ ws: WebSocket; cleanup: () => void }> {
	const executable = findChromiumExecutable();

	// Persistent dedicated polychat profile at ~/.polychat/browser/chromium
	// Never touches the user's main browser or open tabs
	const userDataDir = join(homedir(), ".polychat", "browser", "chromium");
	mkdirSync(userDataDir, { recursive: true });

	// Find a free port for CDP
	const { createServer } = await import("node:http");
	const tempServer = createServer();
	const port = await new Promise<number>((resolve, reject) => {
		tempServer.listen(0, "127.0.0.1", () => {
			const addr = tempServer.address();
			if (addr && typeof addr === "object") resolve(addr.port);
			else reject(new Error("Could not get temp port"));
		});
	});
	await new Promise<void>((resolve) => tempServer.close(() => resolve()));

	// Launch browser with CDP enabled, in app-mode (minimal window, no tabs bar)
	const child = execFile(
		executable,
		[
			`--app=${loginUrl}`,
			`--remote-debugging-port=${port}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			"--disable-features=TranslateUI",
			`--user-data-dir=${userDataDir}`,
		],
		() => { /* browser exited */ },
	);

	// Wait for CDP to be ready
	const cdpUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 15_000;
	let targets: CdpTarget[] = [];

	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${cdpUrl}/json/list`);
			if (res.ok) {
				targets = (await res.json()) as CdpTarget[];
				if (targets.length > 0) break;
			}
		} catch {
			// not ready yet
		}
		await delay(500);
	}

	if (targets.length === 0) {
		throw new Error("Chromium launched but no CDP targets found");
	}

	// Find a page target
	const target = targets.find((t) => t.type === "page") ?? targets[0];
	const wsUrl = target.webSocketDebuggerUrl;

	if (!wsUrl) {
		throw new Error("No WebSocket debugger URL found for CDP target");
	}

	// Connect via WebSocket
	const ws = await new Promise<WebSocket>((resolve, reject) => {
		const socket = new WebSocket(wsUrl);
		socket.on("open", () => resolve(socket));
		socket.on("error", reject);
	});

	const cleanup = () => {
		try { ws.close(); } catch { /* ignore */ }
		try { child.kill(); } catch { /* ignore */ }
		// Note: userDataDir is persistent — intentionally not deleted on cleanup
	};

	return { ws, cleanup };
}

// ---------------------------------------------------------------------------
// Cookie + URL polling
// ---------------------------------------------------------------------------

/** Fetch all cookies for the page via CDP. */
async function getCdpCookies(ws: WebSocket): Promise<CdpCookie[]> {
	const result = await cdpSend(ws, "Network.getAllCookies");
	const cookies = (result as { cookies?: unknown[] }).cookies ?? [];
	return cookies as CdpCookie[];
}

/** Get the current URL of the page via CDP. */
async function getCdpCurrentUrl(ws: WebSocket): Promise<string> {
	const url = (await cdpEvaluate(ws, "document.location.href")) as string | null;
	return url ?? "";
}

// ---------------------------------------------------------------------------
// DeepSeek post-login: extract userToken + model feature store
// ---------------------------------------------------------------------------

async function persistDeepSeekViaCDP(ws: WebSocket): Promise<void> {
	// Extract userToken from localStorage
	const userToken = (await cdpEvaluate(ws, `(() => {
		try {
			const raw = localStorage.getItem("userToken");
			if (raw) {
				const parsed = JSON.parse(raw);
				if (typeof parsed.value === "string" && parsed.value.trim()) return parsed.value.trim();
			}
		} catch {}
		const chunkGlobal = window.webpackChunk_deepseek_chat;
		if (!chunkGlobal) return null;
		let req;
		chunkGlobal.push([[Math.random()], {}, (r) => { req = r; }]);
		const app = req?.(86389)?.y;
		const appToken = app?.getUserTokenWithSource?.().token ?? null;
		if (appToken && app?.setStorageUserToken) {
			try { app.setStorageUserToken(appToken); } catch {}
		}
		return appToken;
	})()`)) as string | null;

	if (userToken) {
		// Write clean userToken back to localStorage
		await cdpSend(ws, "Runtime.evaluate", {
			expression: `localStorage.setItem("userToken", JSON.stringify({ value: ${JSON.stringify(userToken)}, __version: "0" }))`,
			returnByValue: true,
		});
		saveDeepSeekToken(userToken);
	}

	// Navigate to chat page if not already there (to trigger model feature store)
	const currentUrl = await getCdpCurrentUrl(ws);
	if (!currentUrl.startsWith("https://chat.deepseek.com/a/chat")) {
		await cdpSend(ws, "Page.navigate", { url: "https://chat.deepseek.com/a/chat" });
		// Wait for page to load
		await delay(3000);
	}

	// Wait for __ds_remote_feature_store_model to populate, then copy to our key
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const written = (await cdpEvaluate(ws, `(() => {
			try {
				const raw = localStorage.getItem("__ds_remote_feature_store_model");
				if (!raw) return false;
				const parsed = JSON.parse(raw);
				const list = parsed?.features?.model_configs;
				if (!Array.isArray(list) || list.length === 0) return false;
				localStorage.setItem("__polychat_deepseek_models", JSON.stringify(list));
				return true;
			} catch { return false; }
		})()`)) as boolean;

		if (written) break;
		await delay(1000);
	}
}

// ---------------------------------------------------------------------------
// Convert CDP cookies → Playwright StorageState format
// ---------------------------------------------------------------------------

function cdpCookiesToStorageState(cookies: CdpCookie[]): Record<string, unknown> {
	return {
		cookies: cookies.map((c) => ({
			name: c.name,
			value: c.value,
			domain: c.domain,
			path: c.path,
			expires: c.expires > 10_000_000_000 ? Math.floor(c.expires / 1000) : c.expires,
			httpOnly: c.httpOnly,
			secure: c.secure,
			sameSite: (c.sameSite === "Strict" ? "Strict" : c.sameSite === "Lax" ? "Lax" : c.sameSite === "None" ? "None" : undefined) as "Strict" | "Lax" | "None" | undefined,
		})),
		origins: [] as Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>,
	};
}

/** Add localStorage entries gathered via CDP Runtime.evaluate into a storage state. */
function mergeLocalStorageIntoState(
	state: Record<string, unknown>,
	entries: Array<{ origin: string; name: string; value: string }>,
): Record<string, unknown> {
	const origins = (Array.isArray(state.origins) ? state.origins : []) as Array<{
		origin: string;
		localStorage: Array<{ name: string; value: string }>;
	}>;

	const byOrigin = new Map<string, Map<string, string>>();
	for (const o of origins) {
		const map = new Map<string, string>();
		for (const e of o.localStorage) map.set(e.name, e.value);
		byOrigin.set(o.origin, map);
	}
	for (const e of entries) {
		let map = byOrigin.get(e.origin);
		if (!map) {
			map = new Map();
			byOrigin.set(e.origin, map);
		}
		map.set(e.name, e.value);
	}

	return {
		...state,
		origins: Array.from(byOrigin.entries()).map(([origin, map]) => ({
			origin,
			localStorage: Array.from(map.entries()).map(([name, value]) => ({ name, value })),
		})),
	};
}

// ---------------------------------------------------------------------------
// Main CDP login entry point
// ---------------------------------------------------------------------------

/**
 * Log in to a provider by launching Chromium with CDP, navigating to the
 * login URL, and polling until `detectSuccess` returns true.
 *
 * @param provider   Provider id (e.g. "deepseek")
 * @param loginUrl   URL to navigate to for login
 * @param detectSuccess  Callback that inspects cookies + URL each poll
 */
export async function loginWithCDP(
	provider: string,
	loginUrl: string,
	detectSuccess: DetectSuccess,
): Promise<void> {
	const { ws, cleanup } = await launchChromiumWithCDP(loginUrl);

	try {
		// Enable network and page tracking
		await cdpSend(ws, "Network.enable");
		await cdpSend(ws, "Page.enable");
		// Browser already opened loginUrl via --app= flag
		console.log(`Browser opened. Please log in...`);
		console.log("Waiting for login to complete...");

		const timeoutMs = 5 * 60 * 1000;
		const startedAt = Date.now();

		while (Date.now() - startedAt < timeoutMs) {
			await delay(2000);

			const cookies = await getCdpCookies(ws);
			const currentUrl = await getCdpCurrentUrl(ws);

			if (detectSuccess(cookies, currentUrl)) {
				// Provider-specific post-login logic
				if (provider === "deepseek") {
					await persistDeepSeekViaCDP(ws);
				}

				// Build the full storage state (cookies + localStorage)
				let state = cdpCookiesToStorageState(cookies);

				// If provider is deepseek, also grab localStorage entries we care about
				if (provider === "deepseek") {
					const lsEntries = (await cdpEvaluate(ws, `(() => {
						const result = [];
						const origin = document.location.origin;
						for (const key of ["userToken", "__polychat_deepseek_models"]) {
							const val = localStorage.getItem(key);
							if (val !== null) result.push({ origin, name: key, value: val });
						}
						return result;
					})()`)) as Array<{ origin: string; name: string; value: string }> | null;

					if (lsEntries && Array.isArray(lsEntries)) {
						state = mergeLocalStorageIntoState(state, lsEntries);
					}
				}


				saveSession(provider, state);
				return;
			}
		}

		console.error("✗ Login timed out. Please try again.");
		process.exitCode = 1;
	} finally {
		cleanup();
	}
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
