import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname as pathDirname, join, resolve } from "node:path";
// @ts-ignore — node-sqlite3-wasm is CJS; pull Database from the default export
import nodeSqliteWasm from "node-sqlite3-wasm";
const { Database } = nodeSqliteWasm as { Database: new (path: string, opts?: { readOnly?: boolean; fileMustExist?: boolean }) => { exec(sql: string): void; all(sql: string): Array<Record<string, unknown>>; close(): void } };

type StorageStateLike = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None" | undefined;
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
};

export interface FirefoxStorageState extends StorageStateLike {}

export function listFirefoxProfileDirs(): string[] {
  const dirs = new Set<string>();
  const iniPaths = [
    join(homedir(), ".config", "zen", "profiles.ini"),
    join(homedir(), ".config", "mozilla", "firefox", "profiles.ini"),
    join(homedir(), ".mozilla", "firefox", "profiles.ini"),
  ];

  for (const iniPath of iniPaths) {
    for (const dir of parseProfilesIniFile(iniPath)) {
      dirs.add(dir);
    }
  }

  const roots = [
    join(homedir(), ".config", "zen"),
    join(homedir(), ".config", "mozilla", "firefox"),
    join(homedir(), ".mozilla", "firefox"),
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      if (existsSync(join(dir, "cookies.sqlite")) || existsSync(join(dir, "webappsstore.sqlite"))) {
        dirs.add(dir);
      }
    }
  }

  return Array.from(dirs);
}

export function findDefaultFirefoxProfileDir(): string | null {
  const dirs = listFirefoxProfileDirs();
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => profileScore(b) - profileScore(a));
  return dirs[0] ?? null;
}

export function findFirefoxProfileDirForProvider(provider: string): string | null {
  const dirs = listFirefoxProfileDirs();
  if (dirs.length === 0) return null;

  let bestMatching: string | null = null;
  let bestMatchingScore = -1;
  let bestFallback: string | null = null;
  let bestFallbackScore = -1;

  for (const dir of dirs) {
    const score = profileScore(dir);
    const state = readFirefoxStorageState(dir);
    if (state && hasProviderSessionArtifacts(provider, state)) {
      if (score > bestMatchingScore) {
        bestMatching = dir;
        bestMatchingScore = score;
      }
      continue;
    }

    if (score > bestFallbackScore) {
      bestFallback = dir;
      bestFallbackScore = score;
    }
  }

  return bestMatching ?? bestFallback ?? null;
}

export function readFirefoxStorageState(profileDir: string): FirefoxStorageState | null {
  const tempDir = mkdtempSync(join(tmpdir(), "polychat-firefox-"));
  try {
    const cookiesDb = copySQLiteDatabase(profileDir, tempDir, "cookies.sqlite");

    const cookies = cookiesDb
      ? querySQLite(
          cookiesDb,
          `
      select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
      from moz_cookies
    `,
        ).map((row) => ({
          name: String(row.name ?? ""),
          value: String(row.value ?? ""),
          domain: normalizeHost(String(row.host ?? "")),
          path: String(row.path ?? "/"),
          expires: Number(row.expiry ?? 0),
          httpOnly: Boolean(row.isHttpOnly),
          secure: Boolean(row.isSecure),
          sameSite: sameSiteFromNumber(Number(row.sameSite ?? 0)),
        }))
      : [];

    // Try legacy webappsstore.sqlite first
    const storageDb = copySQLiteDatabase(profileDir, tempDir, "webappsstore.sqlite");
    let origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> = [];

    if (storageDb) {
      try {
        const rows = querySQLite(storageDb, `select originKey, key, value from webappsstore2`);
        if (rows.length > 0) {
          origins = groupByOrigin(
            rows.map((row) => ({
              origin: String(row.originKey ?? ""),
              name: String(row.key ?? ""),
              value: String(row.value ?? ""),
            })),
          );
        }
      } catch {
        // Ignore
      }
    }

    // Modern Firefox/Zen stores localStorage in storage/default/<origin>/ls/data.sqlite
    if (origins.length === 0) {
      origins = readModernFirefoxLocalStorage(profileDir, tempDir);
    }

    if (cookies.length === 0 && origins.length === 0) {
      return null;
    }

    return { cookies, origins };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Convert a Firefox storage directory name to a proper origin URL.
 * Firefox encodes origins as "<scheme>+++<host>" or "<scheme>+++<host>+<port>".
 * The host uses literal dots; "+++" separates scheme from host;
 * a single "+" after the host (followed by digits) separates host from port.
 */
function firefoxOriginDirToUrl(dirName: string): string {
  // Split on "+++" to get scheme and the rest
  const sepIdx = dirName.indexOf("+++");
  if (sepIdx === -1) return dirName;
  const scheme = dirName.slice(0, sepIdx);
  const rest = dirName.slice(sepIdx + 3);
  // The rest is "<host>" or "<host>+<port>". A port is numeric after the last "+".
  const portMatch = rest.match(/^(.+)\+(\d+)$/);
  if (portMatch) {
    return `${scheme}://${portMatch[1]}:${portMatch[2]}`;
  }
  return `${scheme}://${rest}`;
}

function readModernFirefoxLocalStorage(
  profileDir: string,
  tempDir: string,
): Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> {
  const storageDefaultDir = join(profileDir, "storage", "default");
  if (!existsSync(storageDefaultDir)) return [];

  const origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> = [];

  for (const originDir of readdirSync(storageDefaultDir, { withFileTypes: true })) {
    if (!originDir.isDirectory()) continue;
    const lsDb = join(storageDefaultDir, originDir.name, "ls", "data.sqlite");
    if (!existsSync(lsDb)) continue;

    // Convert Firefox storage dir name to origin URL.
    // Format: "<scheme>+++<host>" or "<scheme>+++<host>+<port>"
    // The host uses literal dots. The separator between scheme and host is "+++".
    // The port (if any) is separated from the host by a single "+".
    // e.g. "https+++chat.deepseek.com" -> "https://chat.deepseek.com"
    //      "http+++localhost+3000"      -> "http://localhost:3000"
    const rawName = originDir.name.replace(/\^partitionKey=.*$/, "");
    const origin = firefoxOriginDirToUrl(rawName);

    try {
      const target = join(tempDir, `ls-${originDir.name.replace(/[^a-z0-9]/gi, "_")}.sqlite`);
      copyFileSync(lsDb, target);
      for (const suffix of ["-wal", "-shm"]) {
        const sibling = `${lsDb}${suffix}`;
        if (existsSync(sibling)) copyFileSync(sibling, `${target}${suffix}`);
      }
      const rows = querySQLite(target, "select key, value from data");
      if (rows.length > 0) {
        origins.push({
          origin,
          localStorage: rows.map((row) => ({
            name: String(row.key ?? ""),
            value: String(row.value ?? ""),
          })),
        });
      }
    } catch {
      // Skip unreadable databases
    }
  }

  return origins;
}

export function hasProviderSessionArtifacts(provider: string, state: Record<string, unknown> | null): boolean {
  if (!state) return false;

  const cookies = Array.isArray(state.cookies) ? state.cookies as Array<{ domain?: string; name?: string; value?: string }> : [];
  const origins = Array.isArray(state.origins) ? state.origins as Array<{ origin?: string; localStorage?: Array<{ name?: string; value?: string }> }> : [];

  if (provider === "claude") {
    return cookies.some((cookie) => {
      const host = normalizeHost(cookie.domain ?? "").replace(/^\./, "");
      const name = (cookie.name ?? "").toLowerCase();
      return (host === "claude.ai" || host === "claude.com" || host.endsWith(".claude.ai") || host.endsWith(".claude.com"))
        && ["__ssid", "routinghint", "lastactiveorg", "activitysessionid", "anthropic-device-id", "sessionkey"].includes(name);
    });
  }

  if (provider === "chatgpt") {
    return cookies.some((cookie) => {
      const host = normalizeHost(cookie.domain ?? "").replace(/^\./, "");
      const name = (cookie.name ?? "").toLowerCase();
      return (host.endsWith("chatgpt.com") || host.endsWith("chat.openai.com") || host.endsWith("openai.com") || host.endsWith("auth.openai.com"))
        && (name.startsWith("__secure-next-auth.session-token") || name.startsWith("__host-next-auth.session-token")
          || name === "__secure-oai-is" || name === "__secure-authjs.session-token" || name === "authjs.session-token"
          || name === "oai-did" || name === "oai-hlib" || name === "oai-chat-web-route"
          || name.includes("session-token") || name.includes("session"));
    }) || origins.some((origin) => {
      const originText = (origin.origin ?? "").toLowerCase();
      return (originText.includes("chatgpt.com") || originText.includes("chat.openai.com") || originText.includes("openai.com"))
        && (origin.localStorage ?? []).some((entry) => {
          const name = (entry.name ?? "").toLowerCase();
          return Boolean(entry.value) && (name.includes("token") || name.includes("session") || name.includes("auth") || name === "accesstoken");
        });
    });
  }

  if (provider === "deepseek") {
    const hasAuthCookie = cookies.some((cookie) => {
      const host = normalizeHost(cookie.domain ?? "").replace(/^\./, "");
      if (!host.endsWith("deepseek.com")) return false;
      const name = (cookie.name ?? "").toLowerCase();
      return name === "ds_session_id" && (cookie.value ?? "").length > 10;
    });
    if (hasAuthCookie) return true;
    return origins.some((origin) => {
      const originText = (origin.origin ?? "").toLowerCase();
      if (!originText.includes("deepseek.com")) return false;
      return (origin.localStorage ?? []).some((entry) => {
        const name = (entry.name ?? "").toLowerCase();
        const val = entry.value ?? "";
        if (!val) return false;
        if (name === "usertoken") {
          if (val.includes('"value":null')) return false;
          return val.length > 30;
        }
        return false;
      });
    });
  }



  if (provider === "gemini") {
    // Gemini uses OAuth sessions stored as { type: "oauth", access_token, ... }
    // which don't have cookies/origins in the Playwright storageState format,
    // so check for any state presence
    return cookies.length > 0 || origins.length > 0;
  }

  if (provider === "kimi") {
    return cookies.some((cookie) => {
      const host = normalizeHost(cookie.domain ?? "").replace(/^\./, "");
      return host.endsWith("kimi.com")
        && cookie.name === "kimi-auth"
        && (cookie.value ?? "").length > 100;
    });
  }



  return cookies.length > 0 || origins.length > 0;
}
// ---------------------------------------------------------------------------
// Provider-specific state filtering and DeepSeek model injection
// ---------------------------------------------------------------------------

const PROVIDER_DOMAINS: Record<string, RegExp> = {
	chatgpt: /chatgpt\.com|openai\.com/i,
	claude: /claude\.ai|claude\.com|anthropic/i,
	deepseek: /deepseek\.com/i,
	gemini: /google\.com/i,
	kimi: /kimi\.com|moonshot\.ai/i,
};

export function filterStateForProvider(
	provider: string,
	state: FirefoxStorageState,
): FirefoxStorageState {
	const pattern = PROVIDER_DOMAINS[provider];
	if (!pattern) return state;
	return {
		cookies: state.cookies.filter((c) => pattern.test(c.domain ?? "")),
		origins: state.origins.filter((o) => pattern.test(o.origin ?? "")),
	};
}

/**
 * Try to extract DeepSeek model configs from a Firefox storage state and inject
 * them as a clean JSON entry under `__polychat_deepseek_models`.
 *
 * Firefox stores large localStorage values with binary prefixes that make the
 * raw string unparseable. We strip everything before the first `{` to recover
 * the JSON payload. If extraction fails the state is returned unchanged —
 * `listModels` falls back to a static default list.
 */
export function injectDeepSeekModels(
	playwrightState: ReturnType<typeof toPlaywrightStorageState>,
	rawState: FirefoxStorageState,
): ReturnType<typeof toPlaywrightStorageState> {
	// If a clean key was already written (from a prior Playwright login), keep it.
	const alreadyHasClean = playwrightState.origins.some((o) =>
		o.localStorage.some((e) => e.name === "__polychat_deepseek_models"),
	);
	if (alreadyHasClean) return playwrightState;

	// Try to extract model_configs from the binary-prefixed feature store entry.
	let configs: unknown[] | null = null;
	for (const origin of rawState.origins) {
		for (const entry of origin.localStorage ?? []) {
			if (entry.name !== "__ds_remote_feature_store_model") continue;
			try {
				// Strip binary prefix bytes before the opening `{`
				const jsonStart = entry.value.indexOf("{");
				if (jsonStart === -1) continue;
				const parsed = JSON.parse(entry.value.slice(jsonStart)) as { features?: { model_configs?: unknown[] } };
				const list = parsed?.features?.model_configs;
				if (Array.isArray(list) && list.length > 0) { configs = list; break; }
			} catch { /* binary chars embedded in the value — skip */ }
		}
		if (configs) break;
	}
	if (!configs) return playwrightState;

	// Inject the clean entry into the deepseek.com origin.
	return {
		...playwrightState,
		origins: playwrightState.origins.map((o) => {
			if (!o.origin.includes("deepseek.com")) return o;
			return {
				...o,
				localStorage: [
					...o.localStorage.filter((e) => e.name !== "__polychat_deepseek_models"),
					{ name: "__polychat_deepseek_models", value: JSON.stringify(configs!) },
				],
			};
		}),
	};
}

export function normalizeStorageState(state: Record<string, unknown>): StorageStateLike {
  const cookies = (Array.isArray(state.cookies) ? state.cookies : []) as StorageStateLike["cookies"];
  const origins = (Array.isArray(state.origins) ? state.origins : []) as StorageStateLike["origins"];
  return {
    cookies: cookies.map((cookie) => ({
      ...cookie,
      expires: cookie.expires > 10_000_000_000 ? Math.floor(cookie.expires / 1000) : cookie.expires,
    })),
    origins: origins.map((origin) => ({
      origin: origin.origin,
      localStorage: origin.localStorage.map((entry) => ({ name: entry.name, value: entry.value })),
    })),
  };
}

export function toPlaywrightStorageState(state: FirefoxStorageState) {
  return normalizeStorageState({
    cookies: state.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    })),
    origins: state.origins.map((origin) => ({
      origin: origin.origin,
      localStorage: origin.localStorage.map((entry) => ({ name: entry.name, value: entry.value })),
    })),
  });
}

function parseProfilesIniFile(iniPath: string): string[] {
  if (!existsSync(iniPath)) return [];
  const root = pathDirname(iniPath);
  const text = readFileSync(iniPath, "utf8");
  const sections = text.split(/\r?\n\s*\r?\n/);
  const dirs: string[] = [];

  for (const section of sections) {
    if (!/\[Profile/i.test(section)) continue;
    const lines = section.split(/\r?\n/);
    const map = new Map<string, string>();
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        map.set(match[1].trim(), match[2].trim());
      }
    }
    const pathValue = map.get("Path");
    if (!pathValue) continue;
    const dir = map.get("IsRelative") === "1" ? resolve(root, pathValue) : pathValue;
    dirs.push(dir);
  }

  return dirs;
}

function profileScore(profileDir: string) {
  const cookiePath = join(profileDir, "cookies.sqlite");
  const storagePath = join(profileDir, "webappsstore.sqlite");
  const cookieStat = existsSync(cookiePath) ? statSync(cookiePath).size : 0;
  const storageStat = existsSync(storagePath) ? statSync(storagePath).size : 0;
  return cookieStat + storageStat;
}

function copySQLiteDatabase(profileDir: string, tempDir: string, fileName: string): string | null {
  const source = join(profileDir, fileName);
  if (!existsSync(source)) return null;
  const target = join(tempDir, fileName);
  copyFileSync(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    const sibling = `${source}${suffix}`;
    if (existsSync(sibling)) {
      copyFileSync(sibling, `${target}${suffix}`);
    }
  }
  return target;
}

function querySQLite(file: string, sql: string) {
	// node-sqlite3-wasm cannot open WAL-mode databases.
	// When a -wal file exists, use the system sqlite3 CLI to checkpoint.
	const walFile = `${file}-wal`;
	if (existsSync(walFile)) {
		try {
			// Checkpoint WAL into a temporary non-WAL copy and read that.
			const noWalFile = `${file}.nowal`;
			// Backup and convert WAL to rollback journal (required for node-sqlite3-wasm)
			execFileSync("sqlite3", [file, `.backup '${noWalFile}'`], { stdio: "pipe", timeout: 5000 });
			execFileSync("sqlite3", [noWalFile, "PRAGMA journal_mode=delete;"], { stdio: "pipe", timeout: 5000 });
			if (existsSync(noWalFile)) {
				try {
					const db = new Database(noWalFile, { readOnly: true });
					try {
						return db.all(sql) as Array<Record<string, unknown>>;
					} finally {
						db.close();
					}
				} catch {
					return [] as Array<Record<string, unknown>>;
				}
			}
		} catch {
			// sqlite3 CLI not available — fall through to direct open attempt
		}
	}
	try {
		const db = new Database(file, { readOnly: true });
		try {
			const rows = db.all(sql) as Array<Record<string, unknown>>;
			return rows;
		} finally {
			db.close();
		}
	} catch {
		return [] as Array<Record<string, unknown>>;
	}
}

function normalizeHost(host: string) {
  return host || "";
}

function sameSiteFromNumber(value: number): "Strict" | "Lax" | "None" | undefined {
  if (value === 1) return "Lax";
  if (value === 2) return "Strict";
  if (value === 3) return "None";
  return undefined;
}

function groupByOrigin(rows: Array<{ origin: string; name: string; value: string }>) {
  const grouped = new Map<string, Array<{ name: string; value: string }>>();
  for (const row of rows) {
    const list = grouped.get(row.origin) ?? [];
    list.push({ name: row.name, value: row.value });
    grouped.set(row.origin, list);
  }
  return Array.from(grouped.entries()).map(([origin, localStorage]) => ({ origin, localStorage }));
}
