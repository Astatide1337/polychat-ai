import {
  parseConversation,
  parseMessage,
  type Conversation,
  type IngestRequest,
  type Message,
  type ProviderAdapter,
  type ProviderId,
} from "@polychat-ai/history-core/browser";

import {
  loadSettings,
  saveSettings,
  type ConversationSyncCacheEntry,
  type ExtensionSettings,
  type SyncCache,
} from "./config.js";
import { postConversation } from "./ingest-client.js";
import { PROVIDER_ADAPTERS } from "./providers/registry.js";

export type SyncResult =
  | {
      ok: true;
      count: number;
      skipped: number;
      detailFetched: number;
      messagesPosted: number;
      errors?: string[];
    }
  | { ok: false; error: string };

type ConversationSummary = Awaited<ReturnType<ProviderAdapter["listConversations"]>>[number];
type ConversationDetail = Awaited<ReturnType<ProviderAdapter["getConversation"]>>;

type SyncPlan = {
  request: IngestRequest | null;
  nextCacheEntry: ConversationSyncCacheEntry | null;
  detailFetched: boolean;
  skipped: boolean;
  messagesPosted: number;
};

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

function formatSyncResult(prefix: string, result: SyncResult): string {
  if (!result.ok) {
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

function getConversationCache(
  syncCache: SyncCache,
  provider: ProviderId,
  conversationId: string
): ConversationSyncCacheEntry | null {
  return syncCache[provider][conversationId] ?? null;
}

function setConversationCache(
  syncCache: SyncCache,
  provider: ProviderId,
  conversationId: string,
  entry: ConversationSyncCacheEntry | null
): SyncCache {
  const providerCache = { ...syncCache[provider] };
  if (entry) {
    providerCache[conversationId] = entry;
  } else {
    delete providerCache[conversationId];
  }
  return {
    ...syncCache,
    [provider]: providerCache,
  };
}

function normalizeConversationSummary(provider: ProviderId, summary: ConversationSummary): Conversation {
  return parseConversation({
    id: summary.id,
    provider,
    title: summary.title,
    url: summary.url,
    model: summary.model,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    lastSyncedAt: new Date().toISOString(),
    raw: summary.raw,
  });
}

function isFullySynced(entry: ConversationSyncCacheEntry | null, syncVersion: string | null): boolean {
  if (!entry || !syncVersion) return false;
  return entry.summaryUpdatedAt === syncVersion && entry.messagesUpdatedAt === syncVersion;
}

function messageAnchorMatches(entry: ConversationSyncCacheEntry, messages: Message[]): boolean {
  if (entry.messageCount === 0) return messages.length === 0;
  if (messages.length < entry.messageCount) return false;
  const anchor = messages[entry.messageCount - 1];
  return Boolean(anchor && anchor.id === entry.lastMessageId && anchor.updatedAt === entry.lastMessageUpdatedAt);
}

function planConversationSync(
  summary: ConversationSummary,
  detail: ConversationDetail,
  cached: ConversationSyncCacheEntry | null
): SyncPlan {
  const syncVersion = summary.updatedAt ?? detail.conversation.updatedAt ?? null;
  if (isFullySynced(cached, syncVersion)) {
    return {
      request: null,
      nextCacheEntry: cached,
      detailFetched: false,
      skipped: true,
      messagesPosted: 0,
    };
  }

  const currentMessages = detail.messages;
  let messagesToSend: Message[] = currentMessages;
  let replaceMessages = true;

  if (cached) {
    if (messageAnchorMatches(cached, currentMessages)) {
      if (currentMessages.length > cached.messageCount) {
        messagesToSend = currentMessages.slice(cached.messageCount);
        replaceMessages = false;
      } else if (currentMessages.length === cached.messageCount) {
        messagesToSend = [];
        replaceMessages = false;
      }
    }
  }

  if (
    cached &&
    currentMessages.length > 0 &&
    currentMessages.length === cached.messageCount &&
    cached.summaryUpdatedAt !== syncVersion
  ) {
    messagesToSend = currentMessages;
    replaceMessages = true;
  }

  const conversationNeedsUpsert =
    !cached ||
    cached.summaryUpdatedAt !== syncVersion ||
    cached.messagesUpdatedAt !== syncVersion ||
    messagesToSend.length > 0 ||
    currentMessages.length === 0;

  const request: IngestRequest | null = conversationNeedsUpsert
    ? {
        conversation: detail.conversation,
        messages: messagesToSend,
        replaceMessages,
      }
    : null;

  const lastMessage = currentMessages[currentMessages.length - 1] ?? null;
  const nextCacheEntry: ConversationSyncCacheEntry = {
    summaryUpdatedAt: syncVersion,
    messagesUpdatedAt: syncVersion,
    messageCount: currentMessages.length,
    lastMessageId: lastMessage?.id ?? null,
    lastMessageUpdatedAt: lastMessage?.updatedAt ?? null,
    lastSyncedAt: new Date().toISOString(),
  };

  return {
    request,
    nextCacheEntry,
    detailFetched: true,
    skipped: false,
    messagesPosted: messagesToSend.length,
  };
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

async function postConversationRequest(
  serverUrl: string,
  ingestToken: string,
  request: IngestRequest
): Promise<void> {
  await postConversation({ serverUrl, ingestToken }, request);
}

async function syncProviderWithSettings(
  provider: ProviderId,
  settings: ExtensionSettings
): Promise<SyncResult> {
  const adapter = PROVIDER_ADAPTERS[provider];
  let conversations: ConversationSummary[];
  try {
    conversations = await adapter.listConversations();
  } catch (error) {
    const message = `${provider} list failed: ${error instanceof Error ? error.message : String(error)}`;
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: message,
    });
    return { ok: false, error: message };
  }

  let nextSyncCache: SyncCache = { ...settings.syncCache };
  const errors: string[] = [];
  let count = 0;
  let skipped = 0;
  let detailFetched = 0;
  let messagesPosted = 0;

  for (const summary of conversations) {
    const cached = getConversationCache(nextSyncCache, provider, summary.id);
    const syncVersion = summary.updatedAt ?? null;
    if (isFullySynced(cached, syncVersion)) {
      skipped += 1;
      continue;
    }

    if (provider === "chatgpt") {
      await sleep(750);
    }

    try {
      const detail = await getConversationWithRetry(adapter, summary.id);
      detailFetched += 1;
      const plan = planConversationSync(summary, detail, cached);
      if (!plan.request) {
        skipped += 1;
        nextSyncCache = setConversationCache(nextSyncCache, provider, summary.id, plan.nextCacheEntry);
        continue;
      }
      await postConversationRequest(settings.serverUrl, settings.ingestToken, plan.request);
      count += 1;
      messagesPosted += plan.messagesPosted;
      nextSyncCache = setConversationCache(nextSyncCache, provider, summary.id, plan.nextCacheEntry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${summary.id}: ${message}`);
      try {
        await postConversationRequest(settings.serverUrl, settings.ingestToken, {
          conversation: normalizeConversationSummary(provider, summary),
          messages: [],
          replaceMessages: false,
        });
        count += 1;
        nextSyncCache = setConversationCache(nextSyncCache, provider, summary.id, {
          summaryUpdatedAt: syncVersion,
          messagesUpdatedAt: cached?.messagesUpdatedAt ?? null,
          messageCount: cached?.messageCount ?? 0,
          lastMessageId: cached?.lastMessageId ?? null,
          lastMessageUpdatedAt: cached?.lastMessageUpdatedAt ?? null,
          lastSyncedAt: new Date().toISOString(),
        });
      } catch (fallbackError) {
        errors.push(
          `${summary.id}: summary fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
        );
      }
    }
  }

  const result: SyncResult = errors.length
    ? { ok: true, count, skipped, detailFetched, messagesPosted, errors }
    : { ok: true, count, skipped, detailFetched, messagesPosted };

  await saveSettings({
    syncCache: nextSyncCache,
    lastSyncAt: new Date().toISOString(),
    lastResult: formatSyncResult(provider, result),
  });

  if (process.env.POLYCHAT_EXTENSION_TEST_MODE) {
    console.info(
      `[polychat-ai] provider sync metrics provider=${provider} requested=${conversations.length} detailFetched=${detailFetched} skipped=${skipped} requestsSent=${count} messagesPosted=${messagesPosted}`
    );
  }

  return result;
}

export async function syncProvider(provider: ProviderId): Promise<SyncResult> {
  const settings = await loadSettings();
  return syncProviderWithSettings(provider, settings);
}

export async function syncConversation(provider: ProviderId, conversationId: string): Promise<SyncResult> {
  if (!conversationId.trim()) {
    throw new Error("conversation id required");
  }
  const settings = await loadSettings();
  const adapter = PROVIDER_ADAPTERS[provider];
  let detail: ConversationDetail;
  try {
    detail = await getConversationWithRetry(adapter, conversationId);
  } catch (error) {
    const message = `${provider} conversation fetch failed for ${conversationId}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: message,
    });
    return { ok: false, error: message };
  }

  const cached = getConversationCache(settings.syncCache, provider, conversationId);
  const syncVersion = detail.conversation.updatedAt ?? null;
  if (isFullySynced(cached, syncVersion)) {
    const result: SyncResult = { ok: true, count: 0, skipped: 1, detailFetched: 0, messagesPosted: 0 };
    await saveSettings({
      lastSyncAt: new Date().toISOString(),
      lastResult: formatSyncResult(`${provider} conversation`, result),
    });
    if (process.env.POLYCHAT_EXTENSION_TEST_MODE) {
      console.info(
        `[polychat-ai] conversation sync metrics provider=${provider} conversationId=${conversationId} detailFetched=0 skipped=1 requestsSent=0 messagesPosted=0`
      );
    }
    return result;
  }

  const plan = planConversationSync(
    {
      id: conversationId,
      provider,
      title: detail.conversation.title,
      url: detail.conversation.url,
      model: detail.conversation.model,
      createdAt: detail.conversation.createdAt,
      updatedAt: detail.conversation.updatedAt,
      lastSyncedAt: detail.conversation.lastSyncedAt,
      raw: detail.conversation.raw,
    },
    detail,
    cached
  );

  if (!plan.request) {
    const nextSyncCache = setConversationCache(settings.syncCache, provider, conversationId, plan.nextCacheEntry);
    await saveSettings({
      syncCache: nextSyncCache,
      lastSyncAt: new Date().toISOString(),
      lastResult: formatSyncResult(`${provider} conversation`, {
        ok: true,
        count: 0,
        skipped: 0,
        detailFetched: 1,
        messagesPosted: 0,
      }),
    });
    return { ok: true, count: 0, skipped: 0, detailFetched: 1, messagesPosted: 0 };
  }

  await postConversationRequest(settings.serverUrl, settings.ingestToken, plan.request);
  const nextSyncCache = setConversationCache(settings.syncCache, provider, conversationId, plan.nextCacheEntry);
  const result: SyncResult = {
    ok: true,
    count: 1,
    skipped: 0,
    detailFetched: 1,
    messagesPosted: plan.messagesPosted,
  };
  await saveSettings({
    syncCache: nextSyncCache,
    lastSyncAt: new Date().toISOString(),
    lastResult: formatSyncResult(`${provider} conversation`, result),
  });
  if (process.env.POLYCHAT_EXTENSION_TEST_MODE) {
    console.info(
      `[polychat-ai] conversation sync metrics provider=${provider} conversationId=${conversationId} detailFetched=1 skipped=0 requestsSent=1 messagesPosted=${plan.messagesPosted}`
    );
  }
  return result;
}

export async function syncAll(): Promise<SyncResult> {
  let count = 0;
  let skipped = 0;
  let detailFetched = 0;
  let messagesPosted = 0;
  const errors: string[] = [];
  for (const provider of ["chatgpt", "claude", "gemini"] as ProviderId[]) {
    const result = await syncProvider(provider);
    if (result.ok) {
      count += result.count;
      skipped += result.skipped;
      detailFetched += result.detailFetched;
      messagesPosted += result.messagesPosted;
      if (result.errors?.length) {
        errors.push(...result.errors.map((error) => `${provider}: ${error}`));
      }
    } else {
      errors.push(`${provider}: ${result.error}`);
    }
  }

  const finalResult: SyncResult = errors.length
    ? { ok: true, count, skipped, detailFetched, messagesPosted, errors }
    : { ok: true, count, skipped, detailFetched, messagesPosted };
  await saveSettings({
    lastSyncAt: new Date().toISOString(),
    lastResult: formatSyncResult("All providers", finalResult),
  });
  return finalResult;
}

export async function syncSnapshot(
  provider: ProviderId,
  snapshot: any,
  serverUrl: string,
  ingestToken: string
): Promise<IngestRequest> {
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
