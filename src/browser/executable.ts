import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import getBrowserPath from "get-browser-path";

// ── Platform helpers ────────────────────────────────────────────────

function isMac(): boolean {
  return process.platform === "darwin";
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

/** Expand Windows-style `%ENV_VAR%` segments inside a path string. */
function expandWindowsEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, key) => process.env[key] ?? "");
}

// ── which / where lookup ────────────────────────────────────────────

function resolveCommand(command: string): string | null {
  if (existsSync(command)) return command;
  try {
    const output = execFileSync(isWindows() ? "where" : "which", [command], {
      encoding: "utf8",
    });
    const first = output.split(/\r?\n/).find(Boolean)?.trim();
    return first || null;
  } catch {
    return null;
  }
}

// ── Well-known paths ────────────────────────────────────────────────

const CHROME_WELL_KNOWN: Record<string, string[]> = {
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ],
  win32: [
    "%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe",
    "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

const BRAVE_WELL_KNOWN: Record<string, string[]> = {
  linux: [
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
  ],
  darwin: [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  win32: [
    "%PROGRAMFILES%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  ],
};

const EDGE_WELL_KNOWN: Record<string, string[]> = {
  linux: [
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ],
  darwin: [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  win32: [
    "%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

const ARC_WELL_KNOWN: Record<string, string[]> = {
  darwin: [
    "/Applications/Arc.app/Contents/MacOS/Arc",
  ],
};

const FIREFOX_WELL_KNOWN: Record<string, string[]> = {
  linux: [
    "/usr/bin/firefox",
    "/usr/bin/firefox-esr",
  ],
  darwin: [
    "/Applications/Firefox.app/Contents/MacOS/firefox",
  ],
  win32: [],
};

const ZEN_WELL_KNOWN: Record<string, string[]> = {
  linux: [
    "/usr/bin/zen-browser",
    "/usr/lib/zen-browser/zen-browser",
  ],
  darwin: [
    "/Applications/Zen Browser.app/Contents/MacOS/zen",
  ],
  win32: [],
};

// ── First-existing helper ───────────────────────────────────────────

/** Return the first path that exists on disk, or `null`. */
function firstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    const resolved = isWindows() ? expandWindowsEnv(p) : p;
    if (resolved && existsSync(resolved)) return resolved;
  }
  return null;
}

// ── Chromium executable lookup ──────────────────────────────────────

/**
 * Finds the Chromium-based browser executable for the given browser name.
 * Search order: POLYCHAT_BROWSER_PATH env → get-browser-path → well-known paths → which/where → throws
 */
export function findChromiumExecutable(browserHint?: string): string {
  // 1. Environment override
  const envPath = process.env.POLYCHAT_BROWSER_PATH?.trim();
  if (envPath && existsSync(envPath)) return envPath;

  // 2. Normalise hint
  const hint = browserHint?.trim().toLowerCase() ?? "";

  // 3. get-browser-path (supports "chrome" and "edg")
  if (hint === "chrome" || hint === "chromium" || hint === "google-chrome" || hint === "") {
    try {
      const gbp = getBrowserPath("Chrome");
      if (gbp && existsSync(gbp)) return gbp;
    } catch { /* not found via get-browser-path */ }
  }
  if (hint === "edge" || hint === "edg" || hint === "microsoft-edge" || hint === "msedge") {
    try {
      const gbp = getBrowserPath("Edg");
      if (gbp && existsSync(gbp)) return gbp;
    } catch { /* not found via get-browser-path */ }
  }
  // If hint is something else (brave, arc), get-browser-path won't help — skip.

  // 4. Well-known paths per browser hint
  const platform = process.platform;

  if (hint === "brave" || hint === "brave-browser") {
    const found = firstExisting(BRAVE_WELL_KNOWN[platform] ?? []);
    if (found) return found;
  } else if (hint === "edge" || hint === "edg" || hint === "microsoft-edge" || hint === "msedge") {
    const found = firstExisting(EDGE_WELL_KNOWN[platform] ?? []);
    if (found) return found;
  } else if (hint === "arc") {
    const found = firstExisting(ARC_WELL_KNOWN[platform] ?? []);
    if (found) return found;
  } else if (hint === "chrome" || hint === "chromium" || hint === "google-chrome") {
    const found = firstExisting(CHROME_WELL_KNOWN[platform] ?? []);
    if (found) return found;
  } else {
    // No specific hint (or unknown) — try all chromium-based families
    for (const paths of [CHROME_WELL_KNOWN, BRAVE_WELL_KNOWN, EDGE_WELL_KNOWN, ARC_WELL_KNOWN]) {
      const found = firstExisting(paths[platform] ?? []);
      if (found) return found;
    }
  }

  // 5. which / where as last resort
  const whichNames =
    hint === "brave" || hint === "brave-browser"
      ? ["brave-browser", "brave"]
      : hint === "edge" || hint === "edg" || hint === "microsoft-edge" || hint === "msedge"
        ? ["microsoft-edge", "microsoft-edge-stable"]
        : hint === "arc"
          ? ["arc"] // unlikely on CLI but try anyway
          : ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"];

  for (const name of whichNames) {
    const resolved = resolveCommand(name);
    if (resolved) return resolved;
  }

  throw new Error(
    `Could not find a Chromium-based browser executable${hint ? ` for "${hint}"` : ""}. ` +
      "Set POLYCHAT_BROWSER_PATH to the full path of your browser binary."
  );
}

// ── Firefox executable lookup ───────────────────────────────────────

/**
 * Finds the Firefox executable.
 * Search: FIREFOX_PATH env → ZEN_BROWSER_PATH env → well-known paths → which/where → throws
 */
export function findFirefoxExecutable(): string {
  const platform = process.platform;

  // 1. Environment overrides
  const firefoxEnv = process.env.FIREFOX_PATH?.trim();
  if (firefoxEnv && existsSync(firefoxEnv)) return firefoxEnv;

  const zenEnv = process.env.ZEN_BROWSER_PATH?.trim();
  if (zenEnv && existsSync(zenEnv)) return zenEnv;

  // 2. Well-known paths — check Zen first (more likely if installed), then Firefox
  const candidates = [
    ...(ZEN_WELL_KNOWN[platform] ?? []),
    ...(FIREFOX_WELL_KNOWN[platform] ?? []),
  ];
  const found = firstExisting(candidates);
  if (found) return found;

  // 3. which / where as last resort
  const whichNames = ["zen-browser", "firefox", "firefox-esr"];
  for (const name of whichNames) {
    const resolved = resolveCommand(name);
    if (resolved) return resolved;
  }

  throw new Error(
    "Could not find a Firefox executable. " +
      "Set FIREFOX_PATH or ZEN_BROWSER_PATH to the full path of your browser binary."
  );
}
