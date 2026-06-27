import {
  normalizeChatgptConversation,
  type ConversationSummary,
  type Message,
  type ProviderAdapter,
} from "@polychat-ai/history-core/browser";

type ChatGptConversationListResponse = {
  items?: Array<{
    id?: string;
    conversation_id?: string;
    title?: string;
    update_time?: string | number | null;
    create_time?: string | number | null;
  }>;
  has_more?: boolean;
};

type ChatGptSessionResponse = {
  accessToken?: string | null;
  expires?: string | null;
};

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  const response = await fetch(`https://chatgpt.com${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!response.ok) {
    throw new Error(`ChatGPT request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function getAuthHeaders(): Promise<HeadersInit> {
  const session = await fetchJson<ChatGptSessionResponse>("/api/auth/session", {
    headers: { accept: "application/json, text/plain, */*" },
  });
  const accessToken = session.accessToken?.trim() ?? "";
  if (!accessToken) {
    throw new Error("ChatGPT session missing access token");
  }
  return {
    authorization: `Bearer ${accessToken}`,
  };
}

function iso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toSummary(item: NonNullable<ChatGptConversationListResponse["items"]>[number]): ConversationSummary {
  const id = String(item.id ?? item.conversation_id ?? crypto.randomUUID());
  return {
    id,
    provider: "chatgpt",
    title: item.title?.trim() || null,
    url: `https://chatgpt.com/c/${id}`,
    model: null,
    createdAt: iso(item.create_time),
    updatedAt: iso(item.update_time),
    lastSyncedAt: new Date().toISOString(),
    raw: item,
  };
}

export const chatgptAdapter: ProviderAdapter = {
  id: "chatgpt",
  async listConversations() {
    const authHeaders = await getAuthHeaders();
    const summaries: ConversationSummary[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const response = await fetchJson<ChatGptConversationListResponse>(
        `/backend-api/conversations?offset=${offset}&limit=50&order=updated`,
        { headers: authHeaders }
      );
      const items = response.items ?? [];
      summaries.push(...items.map(toSummary));
      if (!response.has_more || items.length === 0) break;
      offset += items.length;
    }
    return summaries;
  },
  async getConversation(id: string) {
    const authHeaders = await getAuthHeaders();
    const raw = await fetchJson<Record<string, unknown>>(`/backend-api/conversation/${encodeURIComponent(id)}`, {
      headers: authHeaders,
    });
    const normalized = normalizeChatgptConversation(raw);
    return normalized;
  },
};
