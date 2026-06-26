import {
  normalizeClaudeConversation,
  type ConversationSummary,
  type ProviderAdapter,
} from "@polychat-ai/history-core/browser";

type Org = { uuid?: string; id?: string };

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

async function getOrgId(): Promise<string> {
  const orgs = await fetchJson<Org[]>("/api/organizations");
  const org = orgs[0];
  return (org?.uuid ?? org?.id ?? "").trim();
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  async listConversations() {
    const orgId = await getOrgId();
    const items = await fetchJson<Array<Record<string, unknown>>>(
      `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations?limit=100`
    );
    return items
      .map((item) => {
        const id = String(item.uuid ?? item.id ?? crypto.randomUUID());
        return {
          id,
          provider: "claude" as const,
          title: typeof item.name === "string" && item.name.trim() ? item.name : null,
          url: `https://claude.ai/chat/${id}`,
          model: typeof item.model === "string" ? item.model : null,
          createdAt: typeof item.created_at === "string" ? item.created_at : null,
          updatedAt: typeof item.updated_at === "string" ? item.updated_at : null,
          lastSyncedAt: new Date().toISOString(),
          raw: item,
        };
      })
      .filter((item) => item.id.length > 0);
  },
  async getConversation(id: string) {
    const orgId = await getOrgId();
    const raw = await fetchJson<Record<string, unknown>>(
      `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(id)}`
    );
    return normalizeClaudeConversation(raw);
  },
};
