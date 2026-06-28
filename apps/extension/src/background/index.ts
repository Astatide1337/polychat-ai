import { loadSettings, saveSettings, type ExtensionSettings } from "../config.js";
import { getHealth } from "../ingest-client.js";
import {
  syncAll as syncAllProviders,
  syncConversation as syncConversationWithCache,
  syncProvider as syncProviderWithCache,
  syncSnapshot as syncSnapshotWithCache,
  type SyncResult,
} from "../sync.js";
import { tabsQuery, tabsSendMessage } from "../webext.js";

type ProviderId = "chatgpt" | "claude" | "gemini";

const AUTO_INGEST_DEBOUNCE_MS = 30_000;
const E2E_SCAN_ATTEMPTS = 20;
const E2E_SCAN_INTERVAL_MS = 1_000;
const E2E_TRIGGER_PARAM = ["polychat", "e2e"].join("-");
const E2E_TRIGGER_TOKEN = [E2E_TRIGGER_PARAM, "token"].join("-");
const autoIngestedAt = new Map<string, number>();
let e2eSyncPromise: Promise<SyncResult> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSyncSuccess(result: SyncResult): result is Extract<SyncResult, { ok: true }> {
  return result.ok;
}

function formatSyncResult(result: SyncResult, prefix: string): string {
  if (!isSyncSuccess(result)) {
    return `${prefix} sync failed: ${result.error}`;
  }
  const parts = [`${prefix} synced ${result.count} conversations`];
  if (result.skipped > 0) {
    parts.push(`skipped ${result.skipped} unchanged`);
  }
  if (result.errors?.length) {
    parts.push(`with errors: ${result.errors.join("; ")}`);
  }
  return `${parts.join(", ")}.`;
}

async function syncProvider(provider: ProviderId): Promise<SyncResult> {
  return syncProviderWithCache(provider);
}

async function syncConversation(provider: ProviderId, conversationId: string): Promise<SyncResult> {
  return syncConversationWithCache(provider, conversationId);
}

async function syncAll(): Promise<SyncResult> {
  return syncAllProviders();
}

async function syncSnapshot(provider: ProviderId, snapshot: any, serverUrl: string, ingestToken: string) {
  return syncSnapshotWithCache(provider, snapshot, serverUrl, ingestToken);
}

function getE2EParamsFromUrl(url: string): URLSearchParams | null {
  if (!url.includes(`${E2E_TRIGGER_PARAM}=all`)) return null;
  try {
    const params = new URL(url).searchParams;
    return params.get("ingestToken") === E2E_TRIGGER_TOKEN ? params : null;
  } catch {
    return null;
  }
}

function getE2EConversationIds(params: URLSearchParams): Array<{ provider: ProviderId; conversationId: string }> {
  return (["chatgpt", "claude", "gemini"] as ProviderId[])
    .map((provider) => ({
      provider,
      conversationId: params.get(provider)?.trim() || "",
    }))
    .filter((entry) => entry.conversationId);
}

async function syncE2EConversationIds(params: URLSearchParams): Promise<SyncResult> {
  if (e2eSyncPromise) return e2eSyncPromise;
  e2eSyncPromise = (async () => {
    const settings = await loadSettings();
    const serverUrl = params.get("serverUrl") || settings.serverUrl;
    const ingestToken = params.get("ingestToken") || settings.ingestToken;
    const conversationIds = getE2EConversationIds(params);

    await saveSettings({
      serverUrl,
      ingestToken,
      testConversationIds: {
        chatgpt: params.get("chatgpt") || "",
        claude: params.get("claude") || "",
        gemini: params.get("gemini") || "",
      },
    });

    if (conversationIds.length === 0) {
      return syncAll();
    }

    const errors: string[] = [];
    let count = 0;
    let skipped = 0;
    let detailFetched = 0;
    let messagesPosted = 0;
    for (const { provider, conversationId } of conversationIds) {
      try {
        console.info("[polychat-ai] e2e syncing designated conversation", { provider, conversationId });
        const result = await syncConversation(provider, conversationId);
        if (result.ok) {
          count += result.count;
          skipped += result.skipped;
          detailFetched += result.detailFetched;
          messagesPosted += result.messagesPosted;
          if (result.errors?.length) {
            errors.push(...result.errors.map((error) => `${provider}: ${error}`));
          }
        }
      } catch (error) {
        errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const result: SyncResult = errors.length > 0
      ? { ok: true, count, skipped, detailFetched, messagesPosted, errors }
      : { ok: true, count, skipped, detailFetched, messagesPosted };
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: formatSyncResult(result, "E2E"),
    });
    if (process.env.POLYCHAT_EXTENSION_TEST_MODE && params.get("cacheProbe") === "1") {
      try {
        await syncSnapshotWithCache(
          "gemini",
          {
            conversationId: "polychat-cache-probe",
            title: "Polychat cache probe",
            url: "polychat-cache-probe://result",
            messages: [
              {
                role: "assistant",
                content: formatSyncResult(result, "E2E"),
              },
            ],
            raw: {
              kind: "cache-probe",
              result,
            },
          },
          settings.serverUrl,
          settings.ingestToken
        );
      } catch (error) {
        console.error("[polychat-ai] cache probe snapshot failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  })();
  try {
    return await e2eSyncPromise;
  } finally {
    e2eSyncPromise = null;
  }
}

async function maybeRunE2ESyncFromUrl(url: string, source: string): Promise<boolean> {
  const params = getE2EParamsFromUrl(url);
  if (!params) return false;
  console.info("[polychat-ai] e2e trigger found", { source, url });
  const result = await syncE2EConversationIds(params);
  console.info("[polychat-ai] e2e sync result", result);
  if (params.get("cacheProbe") === "1") {
    console.info("[polychat-ai] e2e cache probe rerun starting", { source, url });
    const cachedResult = await syncE2EConversationIds(params);
    console.info("[polychat-ai] e2e cache probe rerun result", cachedResult);
  }
  return true;
}

async function runE2ESyncFromOpenTabs(source: string): Promise<boolean> {
  if (!process.env.POLYCHAT_EXTENSION_TEST_MODE) return false;
  const tabs = await tabsQuery({});
  console.info("[polychat-ai] e2e tab scan", { source, tabs: tabs.length });
  for (const tab of tabs) {
    const url = typeof tab?.url === "string" ? tab.url : "";
    if (await maybeRunE2ESyncFromUrl(url, source)) return true;
  }
  return false;
}

async function retryE2ESyncFromOpenTabs(source: string): Promise<void> {
  if (!process.env.POLYCHAT_EXTENSION_TEST_MODE) return;
  for (let attempt = 1; attempt <= E2E_SCAN_ATTEMPTS; attempt += 1) {
    try {
      if (await runE2ESyncFromOpenTabs(`${source}:${attempt}`)) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[polychat-ai] e2e sync failed", { source, attempt, error: message });
      await saveSettings({
        lastSyncAt: new Date().toISOString(),
        lastResult: `E2E sync failed: ${message}`,
      });
      return;
    }
    await sleep(E2E_SCAN_INTERVAL_MS);
  }
  console.info("[polychat-ai] e2e trigger not found", { source });
}

if (process.env.POLYCHAT_EXTENSION_TEST_MODE) {
  void retryE2ESyncFromOpenTabs("boot");
  chrome.tabs.onUpdated.addListener((_tabId: number, changeInfo: { url?: string; status?: string }, tab: { url?: string }) => {
    const url = typeof changeInfo.url === "string" ? changeInfo.url : typeof tab?.url === "string" ? tab.url : "";
    if (!url) return;
    if (changeInfo.status !== "complete" && !changeInfo.url) return;
    void maybeRunE2ESyncFromUrl(url, `updated:${changeInfo.status ?? "unknown"}`);
  });
  chrome.runtime.onStartup.addListener(() => {
    void retryE2ESyncFromOpenTabs("startup");
  });
  chrome.runtime.onInstalled.addListener((details: { reason: string }) => {
    void retryE2ESyncFromOpenTabs(`installed:${details.reason}`);
  });
}

function rememberAutoIngest(provider: string, conversationId: string | null, url: string): boolean {
  const key = [provider, conversationId || "", url].join("|");
  const now = Date.now();
  const last = autoIngestedAt.get(key) ?? 0;
  if (now - last < AUTO_INGEST_DEBOUNCE_MS) {
    return false;
  }
  autoIngestedAt.set(key, now);
  for (const [entryKey, timestamp] of autoIngestedAt.entries()) {
    if (now - timestamp > AUTO_INGEST_DEBOUNCE_MS * 4) {
      autoIngestedAt.delete(entryKey);
    }
  }
  return true;
}

chrome.runtime.onMessage.addListener((message: unknown, sender: { tab?: { id?: number } } | undefined, sendResponse: (value: unknown) => void) => {
  const typed = message as { type?: string; provider?: ProviderId };
  if (typed?.type === "polychat-ai:get-status") {
    void (async () => {
      const settings = await loadSettings();
      const health = await getHealth({ serverUrl: settings.serverUrl, ingestToken: settings.ingestToken }).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      sendResponse({ settings, health });
    })();
    return true;
  }
  if (typed?.type === "polychat-ai:set-settings") {
    void (async () => {
      const settings = await saveSettings(typed as Partial<ExtensionSettings>);
      sendResponse({ ok: true, settings });
    })();
    return true;
  }
  if (typed?.type === "polychat-ai:sync-provider") {
    void syncProvider(typed.provider ?? "chatgpt")
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (typed?.type === "polychat-ai:sync-all") {
    void syncAll()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (typed?.type === "polychat-ai:sync-conversation") {
    const provider = typed.provider;
    const conversationId = String((typed as { conversationId?: string }).conversationId ?? "");
    void (provider
      ? syncConversation(provider, conversationId)
      : Promise.reject(new Error("provider required")))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (typed?.type === "polychat-ai:page-ready") {
    void (async () => {
      const provider = typed.provider;
      if (!provider) return;
      const settings = await loadSettings();
      if (!settings.ingestToken.trim()) return;
      const senderTab = sender?.tab ?? null;
      const senderTabId = typeof senderTab?.id === "number" && senderTab.id >= 0 ? senderTab.id : null;
      const pageReady = typed as { url?: string | null; conversationId?: string | null };
      const url = typeof pageReady.url === "string" ? pageReady.url : null;
      if (!url || url.includes("polychat-auto")) return;
      if (process.env.POLYCHAT_EXTENSION_TEST_MODE) {
        try {
          if (await maybeRunE2ESyncFromUrl(url, "page-ready")) return;
        } catch (error) {
          await saveSettings({
            lastSyncAt: new Date().toISOString(),
            lastResult: `E2E sync failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          return;
        }
      }
      const conversationId = typeof pageReady.conversationId === "string" ? pageReady.conversationId : null;
      if (!rememberAutoIngest(provider, conversationId, url)) return;
      try {
        if (senderTabId !== null) {
          const snapshot = await tabsSendMessage(senderTabId, { type: "polychat-ai:get-snapshot" });
          await syncSnapshot(provider, snapshot, settings.serverUrl, settings.ingestToken);
        }
      } catch (error) {
        await saveSettings({
          lastSyncAt: new Date().toISOString(),
          lastResult: `Auto-ingest ${provider} failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
    return false;
  }
  return false;
});
