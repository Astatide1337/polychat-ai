import { loadSettings, saveSettings } from "../config.js";
import { getSyncStatus } from "../ingest-client.js";
import {
  syncAll as syncAllProviders,
  syncConversation as syncConversationWithCache,
  syncProvider as syncProviderWithCache,
  type SyncResult,
} from "../sync.js";
import { permissionsRequest } from "../webext.js";

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
const AUTO_TEST_PARAM = ["auto", "test"].join("");
type ProviderId = "chatgpt" | "claude" | "gemini";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function serverOriginPattern(serverUrl: string): string | null {
  const url = new URL(serverUrl);
  if (url.protocol !== "https:" || isLoopbackHostname(url.hostname)) return null;
  if (url.hostname === "polychat.astatide.com") return null;
  return `${url.protocol}//${url.host}/*`;
}

async function ensureServerPermission(serverUrl: string): Promise<void> {
  const originPattern = serverOriginPattern(serverUrl);
  if (!originPattern) return;
  const granted = await permissionsRequest({ origins: [originPattern] });
  if (!granted) {
    throw new Error(`Permission required to access ${new URL(serverUrl).origin}`);
  }
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

async function refresh(options: { keepResult?: boolean } = {}): Promise<void> {
  const settings = await loadSettings();
  if (serverUrlInput) serverUrlInput.value = settings.serverUrl;
  if (ingestTokenInput) ingestTokenInput.value = settings.ingestToken;
  if (testChatgptInput) testChatgptInput.value = settings.testConversationIds.chatgpt;
  if (testClaudeInput) testClaudeInput.value = settings.testConversationIds.claude;
  if (testGeminiInput) testGeminiInput.value = settings.testConversationIds.gemini;
  setText(lastSync, settings.lastSyncAt ?? "Not synced yet.");
  if (!options.keepResult) {
    setText(result, settings.lastResult ?? "Idle.");
  }
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
  try {
    const settings = await loadSettings();
    await ensureServerPermission(settings.serverUrl);
    return await syncProviderWithCache(provider);
  } catch (error) {
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function syncAll(): Promise<SyncResult> {
  try {
    const settings = await loadSettings();
    await ensureServerPermission(settings.serverUrl);
    return await syncAllProviders();
  } catch (error) {
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sync(type: "polychat-ai:sync-provider" | "polychat-ai:sync-all", provider?: string) {
  setText(result, "Syncing...");
  const response = type === "polychat-ai:sync-all" ? await syncAll() : await syncProvider((provider ?? "chatgpt") as ProviderId);
  setText(result, JSON.stringify(response, null, 2));
  await refresh({ keepResult: true });
}

async function syncConversation() {
  const provider = conversationProviderSelect?.value || "chatgpt";
  const conversationId = conversationIdInput?.value.trim() || "";
  if (!conversationId) {
    setText(result, "conversation id required");
    return;
  }
  setText(result, "Syncing conversation...");
  try {
    const settings = await loadSettings();
    await ensureServerPermission(settings.serverUrl);
    const response = await syncConversationWithCache(provider as ProviderId, conversationId);
    setText(result, JSON.stringify(response, null, 2));
  } catch (error) {
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: `Conversation sync failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    setText(result, error instanceof Error ? error.message : String(error));
  }
  await refresh({ keepResult: true });
}

async function syncTestConversation(provider: "chatgpt" | "claude" | "gemini") {
  if (!process.env.POLYCHAT_EXTENSION_TEST_MODE) {
    setText(result, "test mode disabled");
    return;
  }
  try {
    const settings = await loadSettings();
    await ensureServerPermission(settings.serverUrl);
    const conversationId = settings.testConversationIds[provider];
    if (!conversationId) {
      setText(result, `${provider} test id not set`);
      console.warn(`[polychat-ai] missing test conversation id for ${provider}`);
      return;
    }
    console.info(`[polychat-ai] syncing test conversation`, { provider, conversationId });
    const response = await syncConversationWithCache(provider, conversationId);
    console.info(`[polychat-ai] sync response`, { provider, response });
    setText(result, JSON.stringify(response, null, 2));
  } catch (error) {
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: `Test sync failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    setText(result, error instanceof Error ? error.message : String(error));
  }
  await refresh({ keepResult: true });
}

async function runAutoTest(): Promise<void> {
  if (!process.env.POLYCHAT_EXTENSION_TEST_MODE || autoTestParams.get(AUTO_TEST_PARAM) !== "1") return;
  console.info("[polychat-ai] auto test enabled", Object.fromEntries(autoTestParams.entries()));
  const serverUrl = validateServerUrl(autoTestParams.get("serverUrl") || "http://127.0.0.1:3333");
  await ensureServerPermission(serverUrl);
  await saveSettings({
    serverUrl,
    ingestToken: autoTestParams.get("ingestToken") || "",
    testConversationIds: {
      chatgpt: autoTestParams.get("chatgpt") || "",
      claude: autoTestParams.get("claude") || "",
      gemini: autoTestParams.get("gemini") || "",
    },
  });
  if (autoTestParams.get("all") === "1") {
    await syncAllProviders();
    return;
  }
  if (autoTestParams.get("chatgpt")) {
    await syncConversationWithCache("chatgpt", autoTestParams.get("chatgpt") || "");
  }
  if (autoTestParams.get("claude")) {
    await syncConversationWithCache("claude", autoTestParams.get("claude") || "");
  }
  if (autoTestParams.get("gemini")) {
    await syncConversationWithCache("gemini", autoTestParams.get("gemini") || "");
  }
}

saveButton?.addEventListener("click", async () => {
  try {
    const serverUrl = validateServerUrl(serverUrlInput?.value.trim() || "http://127.0.0.1:3333");
    await ensureServerPermission(serverUrl);
    const settings = await saveSettings({
      serverUrl,
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
  if (!process.env.POLYCHAT_EXTENSION_TEST_MODE) {
    document.querySelectorAll<HTMLElement>("[data-test-only]").forEach((node) => {
      node.hidden = true;
    });
  }
  if (process.env.POLYCHAT_EXTENSION_TEST_MODE) {
    if (autoTestParams.get(AUTO_TEST_PARAM) === "1") {
      await runAutoTest();
      await refresh({ keepResult: true });
      return;
    }
  }
  await refresh();
}

void initialize();
