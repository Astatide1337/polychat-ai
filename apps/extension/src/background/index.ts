import {
  parseConversation,
  parseMessage,
  type Conversation,
  type IngestRequest,
  type Message,
  type ProviderId,
  type ProviderAdapter,
} from "@polychat-ai/history-core/browser";

import { loadSettings, saveSettings, type ExtensionSettings } from "../config.js";
import { getHealth, postBatch, postConversation } from "../ingest-client.js";
import { PROVIDER_ADAPTERS } from "../providers/registry.js";
import { tabsQuery, tabsSendMessage } from "../webext.js";

type SyncResult =
  | { ok: true; count: number; errors?: string[] }
  | { ok: false; error: string };
type ConversationDetail = Awaited<ReturnType<ProviderAdapter["getConversation"]>>;
type SyncSuccess = Extract<SyncResult, { ok: true }>;

const AUTO_INGEST_DEBOUNCE_MS = 30_000;
const E2E_SCAN_ATTEMPTS = 20;
const E2E_SCAN_INTERVAL_MS = 1_000;
const autoIngestedAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDetailError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(408|409|425|429|500|502|503|504)\b/.test(message);
}

function retryDelayMs(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b/.test(message)) return 8_000 * attempt;
  return 1_500 * attempt;
}

function isSyncSuccess(result: SyncResult): result is SyncSuccess {
  return result.ok;
}

function formatSyncResult(result: SyncResult, prefix: string): string {
  if (isSyncSuccess(result)) {
    return result.errors?.length
      ? `${prefix} synced ${result.count} conversations with errors: ${result.errors.join("; ")}`
      : `${prefix} synced ${result.count} conversations across providers.`;
  }
  return `${prefix} sync failed: ${result.error}`;
}

async function getConversationWithRetry(adapter: ProviderAdapter, id: string): Promise<ConversationDetail> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await adapter.getConversation(id);
    } catch (error) {
      lastError = error;
      if (attempt === 4 || !isRetryableDetailError(error)) break;
      await sleep(retryDelayMs(error, attempt));
    }
  }
  throw lastError;
}

function getE2EParamsFromUrl(url: string): URLSearchParams | null {
  if (!url.includes("polychat-e2e=all")) return null;
  try {
    const params = new URL(url).searchParams;
    return params.get("ingestToken") === "polychat-e2e-token" ? params : null;
  } catch {
    return null;
  }
}

async function runE2ESyncFromOpenTabs(source: string): Promise<boolean> {
  if (!process.env.POLYCHAT_EXTENSION_TEST_MODE) return false;
  const tabs = await tabsQuery({});
  console.info("[polychat-ai] e2e tab scan", { source, tabs: tabs.length });
  for (const tab of tabs) {
    const url = typeof tab?.url === "string" ? tab.url : "";
    const params = getE2EParamsFromUrl(url);
    if (!params) continue;
    console.info("[polychat-ai] e2e trigger found", { source, url });
    await saveSettings({
      serverUrl: params.get("serverUrl") || "http://127.0.0.1:3333",
      ingestToken: params.get("ingestToken") || "",
    });
    const result = await syncAll();
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: formatSyncResult(result, "E2E"),
    });
    console.info("[polychat-ai] e2e sync result", result);
    return true;
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
  chrome.runtime.onInstalled.addListener((details: { reason: string }) => {
    if (details.reason !== "install" && details.reason !== "update") return;
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

async function syncSnapshot(provider: ProviderId, snapshot: any, serverUrl: string, ingestToken: string): Promise<IngestRequest> {
  const conversation = parseConversation({
    id: snapshot.conversationId ?? snapshot.url ?? crypto.randomUUID(),
    provider,
    title: snapshot.title ?? null,
    url: snapshot.url ?? null,
    model: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
    raw: snapshot.raw ?? snapshot,
  });
  const messages: Message[] = Array.isArray(snapshot.messages)
    ? snapshot.messages.map((message: any, index: number) =>
        parseMessage({
          id: message.id ?? `${conversation.id}:${index}`,
          provider,
          conversationId: conversation.id,
          role: message.role ?? "unknown",
          content: message.content ?? "",
          model: null,
          parentId: message.parentId ?? null,
          nodeId: message.nodeId ?? null,
          createdAt: null,
          updatedAt: null,
          raw: message.raw ?? message,
        })
      )
    : [];
  const request: IngestRequest = { conversation, messages };
  if (messages.length > 0) {
    request.replaceMessages = true;
  } else {
    request.replaceMessages = false;
  }
  await postConversation({ serverUrl, ingestToken }, request);
  return request;
}

async function syncProvider(provider: ProviderId): Promise<SyncResult> {
  const settings = await loadSettings();
  const adapter = PROVIDER_ADAPTERS[provider];
  const conversations = await adapter.listConversations().catch((error: Error) => {
    throw new Error(`${provider} list failed: ${error.message}`);
  });

  if (conversations.length === 0) {
    await saveSettings({ lastSyncAt: new Date().toISOString(), lastResult: `No ${provider} conversations found.` });
    return { ok: true, count: 0 };
  }

  const batch: IngestRequest[] = [];
  for (const summary of conversations) {
    try {
      if (provider === "chatgpt") await sleep(750);
      const detail = await getConversationWithRetry(adapter, summary.id);
      batch.push({
        conversation: detail.conversation,
        messages: detail.messages,
        replaceMessages: true,
      });
    } catch (error) {
      batch.push({
        conversation: parseConversation({
          id: summary.id,
          provider,
          title: summary.title,
          url: summary.url,
          model: summary.model,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          lastSyncedAt: new Date().toISOString(),
          raw: summary.raw,
        }),
        messages: [],
        replaceMessages: false,
      });
      await saveSettings({
        lastResult: `${provider} detail fetch failed for ${summary.id}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  await postBatch({ serverUrl: settings.serverUrl, ingestToken: settings.ingestToken }, batch);
  const maybeTruncated = provider === "claude" && conversations.length === 100;
  await saveSettings({
    lastSyncAt: new Date().toISOString(),
    lastResult: `Synced ${batch.length} ${provider} conversations.${maybeTruncated ? " Provider may be truncated." : ""}`,
  });
  return { ok: true, count: batch.length };
}

async function syncConversation(provider: ProviderId, conversationId: string): Promise<SyncResult> {
  if (!conversationId.trim()) {
    throw new Error("conversation id required");
  }
  const settings = await loadSettings();
  const adapter = PROVIDER_ADAPTERS[provider];
  const detail = await getConversationWithRetry(adapter, conversationId);
  await postConversation(
    { serverUrl: settings.serverUrl, ingestToken: settings.ingestToken },
    {
      conversation: detail.conversation,
      messages: detail.messages,
      replaceMessages: true,
    }
  );
  await saveSettings({
    lastSyncAt: new Date().toISOString(),
    lastResult: `Synced ${provider} conversation ${conversationId}.`,
  });
  return { ok: true, count: 1 };
}

async function syncAll(): Promise<SyncResult> {
  let count = 0;
  const errors: string[] = [];
  for (const provider of ["chatgpt", "claude", "gemini"] as ProviderId[]) {
    try {
      const result = await syncProvider(provider);
      if (result.ok) count += result.count;
      else errors.push(`${provider}: ${result.error}`);
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors.length > 0 ? { ok: true, count, errors } : { ok: true, count };
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
        const e2eParams = getE2EParamsFromUrl(url);
        if (e2eParams) {
          const serverUrl = e2eParams.get("serverUrl") || settings.serverUrl;
          const ingestToken = e2eParams.get("ingestToken") || settings.ingestToken;
          await saveSettings({ serverUrl, ingestToken });
          try {
            const result = await syncAll();
            await saveSettings({
              lastSyncAt: new Date().toISOString(),
              lastResult: formatSyncResult(result, "E2E"),
            });
          } catch (error) {
            await saveSettings({
              lastSyncAt: new Date().toISOString(),
              lastResult: `E2E sync failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
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
