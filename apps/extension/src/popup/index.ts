import {
  parseConversation,
  type IngestRequest,
  type ProviderId,
  type ProviderAdapter,
} from "@polychat-ai/history-core/browser";

import { loadSettings, saveSettings } from "../config.js";
import { getSyncStatus, postBatch, postConversation } from "../ingest-client.js";
import { PROVIDER_ADAPTERS } from "../providers/registry.js";

const serverUrlInput = document.getElementById("serverUrl") as HTMLInputElement | null;
const ingestTokenInput = document.getElementById("ingestToken") as HTMLInputElement | null;
const saveButton = document.getElementById("save") as HTMLButtonElement | null;
const syncChatgptButton = document.getElementById("sync-chatgpt") as HTMLButtonElement | null;
const syncClaudeButton = document.getElementById("sync-claude") as HTMLButtonElement | null;
const syncGeminiButton = document.getElementById("sync-gemini") as HTMLButtonElement | null;
const syncAllButton = document.getElementById("sync-all") as HTMLButtonElement | null;
const conversationProviderSelect = document.getElementById("conversationProvider") as HTMLSelectElement | null;
const conversationIdInput = document.getElementById("conversationId") as HTMLInputElement | null;
const syncConversationButton = document.getElementById("sync-conversation") as HTMLButtonElement | null;
const testChatgptInput = document.getElementById("testChatgpt") as HTMLInputElement | null;
const testClaudeInput = document.getElementById("testClaude") as HTMLInputElement | null;
const testGeminiInput = document.getElementById("testGemini") as HTMLInputElement | null;
const syncTestChatgptButton = document.getElementById("sync-test-chatgpt") as HTMLButtonElement | null;
const syncTestClaudeButton = document.getElementById("sync-test-claude") as HTMLButtonElement | null;
const syncTestGeminiButton = document.getElementById("sync-test-gemini") as HTMLButtonElement | null;
const lastSync = document.getElementById("lastSync");
const result = document.getElementById("result");
const serverStatus = document.getElementById("serverStatus");
const autoTestParams = new URLSearchParams(location.search);

type SyncResult = {
  ok: true;
  count: number;
  errors?: string[];
};

type ConversationDetail = Awaited<ReturnType<ProviderAdapter["getConversation"]>>;

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

function setText(node: HTMLElement | null, value: string): void {
  if (node) node.textContent = value;
}

function validateServerUrl(value: string): string {
  const url = new URL(value.trim() || "http://127.0.0.1:3333");
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback)) {
    return url.toString();
  }
  throw new Error("Use https:// for remote servers");
}

async function refresh(): Promise<void> {
  const settings = await loadSettings();
  if (serverUrlInput) serverUrlInput.value = settings.serverUrl;
  if (ingestTokenInput) ingestTokenInput.value = settings.ingestToken;
  if (testChatgptInput) testChatgptInput.value = settings.testConversationIds.chatgpt;
  if (testClaudeInput) testClaudeInput.value = settings.testConversationIds.claude;
  if (testGeminiInput) testGeminiInput.value = settings.testConversationIds.gemini;
  setText(lastSync, settings.lastSyncAt ?? "Not synced yet.");
  setText(result, settings.lastResult ?? "Idle.");
  try {
    const status = await getSyncStatus({
      serverUrl: settings.serverUrl,
      ingestToken: settings.ingestToken,
    });
    setText(
      serverStatus,
      status.providers.length
        ? status.providers
            .map((provider) => `${provider.provider}: ${provider.conversations} conv / ${provider.messages} msg`)
            .join("\n")
        : "No synced conversations yet."
    );
  } catch (error) {
    setText(serverStatus, error instanceof Error ? error.message : String(error));
  }
}

async function syncProvider(provider: ProviderId): Promise<SyncResult> {
  const settings = await loadSettings();
  const adapter = PROVIDER_ADAPTERS[provider];
  const conversations = await adapter.listConversations();
  const summaryBatch: IngestRequest[] = conversations.map((summary) => ({
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
  }));
  if (summaryBatch.length > 0) {
    await postBatch({ serverUrl: settings.serverUrl, ingestToken: settings.ingestToken }, summaryBatch);
  }

  const batch: IngestRequest[] = [];
  const errors: string[] = [];

  for (const summary of conversations) {
    try {
      if (provider === "chatgpt") await sleep(750);
      const detail = await getConversationWithRetry(adapter, summary.id);
      batch.push({
        conversation: detail.conversation,
        messages: detail.messages,
      });
    } catch (error) {
      errors.push(`${summary.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (batch.length > 0) {
    await postBatch({ serverUrl: settings.serverUrl, ingestToken: settings.ingestToken }, batch);
  }
  await saveSettings({
    lastSyncAt: new Date().toISOString(),
    lastResult: errors.length
      ? `Synced ${conversations.length} ${provider} conversations with ${errors.length} detail errors.`
      : `Synced ${conversations.length} ${provider} conversations.`,
  });
  return errors.length ? { ok: true, count: conversations.length, errors } : { ok: true, count: conversations.length };
}

async function syncAll(): Promise<SyncResult> {
  let count = 0;
  const errors: string[] = [];
  for (const provider of ["chatgpt", "claude", "gemini"] as ProviderId[]) {
    try {
      const response = await syncProvider(provider);
      count += response.count;
      if (response.errors) {
        errors.push(...response.errors.map((error) => `${provider}: ${error}`));
      }
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await saveSettings({
    lastSyncAt: new Date().toISOString(),
    lastResult: errors.length
      ? `Synced ${count} conversations with errors: ${errors.join("; ")}`
      : `Synced ${count} conversations across providers.`,
  });
  return errors.length ? { ok: true, count, errors } : { ok: true, count };
}

async function sync(type: "polychat-ai:sync-provider" | "polychat-ai:sync-all", provider?: string) {
  setText(result, "Syncing...");
  const response = type === "polychat-ai:sync-all" ? await syncAll() : await syncProvider((provider ?? "chatgpt") as ProviderId);
  setText(result, JSON.stringify(response, null, 2));
  await refresh();
}

async function syncConversation() {
  const provider = conversationProviderSelect?.value || "chatgpt";
  const conversationId = conversationIdInput?.value.trim() || "";
  if (!conversationId) {
    setText(result, "conversation id required");
    return;
  }
  setText(result, "Syncing conversation...");
  const typedProvider = provider as ProviderId;
  const settings = await loadSettings();
  const detail = await getConversationWithRetry(PROVIDER_ADAPTERS[typedProvider], conversationId);
  await postConversation({ serverUrl: settings.serverUrl, ingestToken: settings.ingestToken }, {
    conversation: detail.conversation,
    messages: detail.messages,
  });
  await saveSettings({
    lastSyncAt: new Date().toISOString(),
    lastResult: `Synced ${typedProvider} conversation ${conversationId}.`,
  });
  setText(result, JSON.stringify({ ok: true, count: 1 }, null, 2));
  await refresh();
}

async function syncTestConversation(provider: "chatgpt" | "claude" | "gemini") {
  const settings = await loadSettings();
  const conversationId = settings.testConversationIds[provider];
  if (!conversationId) {
    setText(result, `${provider} test id not set`);
    console.warn(`[polychat-ai] missing test conversation id for ${provider}`);
    return;
  }
  console.info(`[polychat-ai] syncing test conversation`, { provider, conversationId });
  const detail = await getConversationWithRetry(PROVIDER_ADAPTERS[provider], conversationId);
  await postConversation({ serverUrl: settings.serverUrl, ingestToken: settings.ingestToken }, {
    conversation: detail.conversation,
    messages: detail.messages,
  });
  const response = { ok: true, count: 1 };
  await saveSettings({
    lastSyncAt: new Date().toISOString(),
    lastResult: `Synced ${provider} test conversation ${conversationId}.`,
  });
  console.info(`[polychat-ai] sync response`, { provider, response });
  setText(result, JSON.stringify(response, null, 2));
  await refresh();
}

async function runAutoTest(): Promise<void> {
  if (autoTestParams.get("autotest") !== "1") return;
  console.info("[polychat-ai] auto test enabled", Object.fromEntries(autoTestParams.entries()));
  await saveSettings({
    serverUrl: validateServerUrl(autoTestParams.get("serverUrl") || "http://127.0.0.1:3333"),
    ingestToken: autoTestParams.get("ingestToken") || "",
    testConversationIds: {
      chatgpt: autoTestParams.get("chatgpt") || "",
      claude: autoTestParams.get("claude") || "",
      gemini: autoTestParams.get("gemini") || "",
    },
  });
  if (autoTestParams.get("all") === "1") {
    await sync("polychat-ai:sync-all");
    return;
  }
  if (autoTestParams.get("chatgpt")) {
    await syncTestConversation("chatgpt");
  }
  if (autoTestParams.get("claude")) {
    await syncTestConversation("claude");
  }
  if (autoTestParams.get("gemini")) {
    await syncTestConversation("gemini");
  }
}

saveButton?.addEventListener("click", async () => {
  try {
    const settings = await saveSettings({
      serverUrl: validateServerUrl(serverUrlInput?.value.trim() || "http://127.0.0.1:3333"),
      ingestToken: ingestTokenInput?.value.trim() || "",
      testConversationIds: {
        chatgpt: testChatgptInput?.value.trim() || "",
        claude: testClaudeInput?.value.trim() || "",
        gemini: testGeminiInput?.value.trim() || "",
      },
    });
    setText(result, `Saved ${settings.serverUrl}`);
  } catch (error) {
    setText(result, error instanceof Error ? error.message : String(error));
  }
});

syncChatgptButton?.addEventListener("click", () => void sync("polychat-ai:sync-provider", "chatgpt"));
syncClaudeButton?.addEventListener("click", () => void sync("polychat-ai:sync-provider", "claude"));
syncGeminiButton?.addEventListener("click", () => void sync("polychat-ai:sync-provider", "gemini"));
syncAllButton?.addEventListener("click", () => void sync("polychat-ai:sync-all"));
syncConversationButton?.addEventListener("click", () => void syncConversation());
syncTestChatgptButton?.addEventListener("click", () => void syncTestConversation("chatgpt"));
syncTestClaudeButton?.addEventListener("click", () => void syncTestConversation("claude"));
syncTestGeminiButton?.addEventListener("click", () => void syncTestConversation("gemini"));

async function initialize(): Promise<void> {
  if (autoTestParams.get("autotest") === "1") {
    await runAutoTest();
    await refresh();
    return;
  }
  await refresh();
}

void initialize();
