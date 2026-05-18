import defaultBrowser from "default-browser";

export type BrowserKind = "chromium" | "firefox" | "unsupported";

export interface BrowserInfo {
  kind: BrowserKind;
  name: string;
  unsupportedReason?: string;
}

const CHROMIUM_KEYWORDS = [
  "chrome",
  "brave",
  "edge",
  "edg",
  "vivaldi",
  "opera",
  "arc",
  "chromium",
] as const;

const FIREFOX_KEYWORDS = [
  "firefox",
  "zen",
  "librewolf",
  "waterfox",
  "floorp",
  "mozilla",
] as const;

const UNSUPPORTED_REASON =
  "Safari is not supported for login. Please set Chrome, Brave, or Firefox as your default browser.";

const ENV_FALLBACK_REASON =
  "Could not detect default browser. Set POLYCHAT_BROWSER=chrome or POLYCHAT_BROWSER=firefox.";

function classifyFromText(text: string): BrowserKind | null {
  const lower = text.toLowerCase();
  for (const kw of CHROMIUM_KEYWORDS) {
    if (lower.includes(kw)) return "chromium";
  }
  for (const kw of FIREFOX_KEYWORDS) {
    if (lower.includes(kw)) return "firefox";
  }
  return null;
}

function resolveEnvOverride(): BrowserInfo | null {
  const env = process.env.POLYCHAT_BROWSER;
  if (!env) return null;

  const lower = env.toLowerCase();
  if (["chrome", "chromium", "brave", "edge"].includes(lower)) {
    return { kind: "chromium", name: lower };
  }
  if (["firefox", "zen"].includes(lower)) {
    return { kind: "firefox", name: lower };
  }
  return null;
}

/**
 * Detects the user's default browser and returns its kind.
 * Uses the `default-browser` npm package already installed.
 *
 * Classification rules:
 * - Chromium: name/id contains any of: chrome, brave, edge, edg, vivaldi, opera, arc, chromium
 * - Firefox: name/id contains any of: firefox, zen, librewolf, waterfox, floorp, mozilla
 * - Safari or anything else: kind=unsupported, unsupportedReason="Safari is not supported for login. Please set Chrome, Brave, or Firefox as your default browser."
 */
export async function detectBrowserKind(): Promise<BrowserInfo> {
  // Environment variable override takes priority
  const envOverride = resolveEnvOverride();
  if (envOverride) return envOverride;

  try {
    const browser = await defaultBrowser();
    const name = browser.name ?? "";

    // Check both name and id against keyword lists
    const kindFromName = classifyFromText(name);
    if (kindFromName) {
      return { kind: kindFromName, name };
    }

    const kindFromId = classifyFromText(browser.id ?? "");
    if (kindFromId) {
      return { kind: kindFromId, name };
    }

    // Detected but not chromium or firefox → unsupported
    return { kind: "unsupported", name, unsupportedReason: UNSUPPORTED_REASON };
  } catch {
    // defaultBrowser() threw → fallback with env hint
    return { kind: "unsupported", name: "unknown", unsupportedReason: ENV_FALLBACK_REASON };
  }
}
