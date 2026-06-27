import {
  normalizeClaudeConversation,
  type ConversationSummary,
  type ProviderAdapter,
} from "@polychat-ai/history-core/browser";

type Org = { uuid?: string; id?: string };
type ClaudeConversationRecord = Record<string, unknown>;
const CLAUDE_PAGE_SIZE = 100;
const CLAUDE_MAX_PAGES = 20;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`https://claude.ai${path}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Claude request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function extractConversationItems(value: unknown): ClaudeConversationRecord[] {
  if (Array.isArray(value)) return value as ClaudeConversationRecord[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const items = record.items ?? record.conversations ?? record.data;
    if (Array.isArray(items)) return items as ClaudeConversationRecord[];
  }
  return [];
}

async function getOrgId(): Promise<string> {
  const orgs = await fetchJson<Org[]>("/api/organizations");
  const org = orgs[0];
  return (org?.uuid ?? org?.id ?? "").trim();
}

async function fetchConversationPage(orgId: string, offset: number): Promise<ClaudeConversationRecord[]> {
  const payload = await fetchJson<unknown>(
    `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations?offset=${offset}&limit=${CLAUDE_PAGE_SIZE}`
  );
  return extractConversationItems(payload);
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  async listConversations() {
    const orgId = await getOrgId();
    const summaries: ConversationSummary[] = [];
    const seen = new Set<string>();
    let offset = 0;

    for (let page = 0; page < CLAUDE_MAX_PAGES; page += 1) {
      const items = await fetchConversationPage(orgId, offset);
      if (items.length === 0) break;
      let added = 0;
      for (const item of items) {
        const id = String(item.uuid ?? item.id ?? crypto.randomUUID());
        if (!id || seen.has(id)) continue;
        seen.add(id);
        summaries.push({
          id,
          provider: "claude" as const,
          title: typeof item.name === "string" && item.name.trim() ? item.name : null,
          url: `https://claude.ai/chat/${id}`,
          model: typeof item.model === "string" ? item.model : null,
          createdAt: typeof item.created_at === "string" ? item.created_at : null,
          updatedAt: typeof item.updated_at === "string" ? item.updated_at : null,
          lastSyncedAt: new Date().toISOString(),
          raw: item,
        });
        added += 1;
      }
      if (added === 0 || items.length < CLAUDE_PAGE_SIZE) break;
      offset += items.length;
    }
    return summaries;
  },
  async getConversation(id: string) {
    const orgId = await getOrgId();
    const raw = await fetchJson<Record<string, unknown>>(
      `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(id)}`
    );
    return normalizeClaudeConversation(raw);
  },
};
