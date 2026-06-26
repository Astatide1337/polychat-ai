import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import {
  buildConversationListQuery,
  buildConversationQuery,
  buildMessageQuery,
  buildSearchQuery,
  buildSyncStatusQuery,
  buildUpsertRequestSql,
  decodeCursor,
  encodeCursor,
  parseConversationRow,
  parseMessageRow,
  parseSyncStatusRow,
  type Conversation,
  type IngestRequest,
  type Message,
  type ProviderId,
  type SyncProviderStatus,
} from "@polychat-ai/history-core";
import { MIGRATION_SQL } from "./migrations.js";

export type ConversationSearchMatch = {
  messageId: string;
  role: string;
  snippet: string;
};

export type ConversationSearchResult = {
  conversation: Conversation;
  matches: ConversationSearchMatch[];
};

export class SqliteDatabase {
  constructor(private readonly dbPath: string) {}

  private run(sql: string): void {
    execFileSync("sqlite3", [this.dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
      input: sql,
      encoding: "utf8",
    });
  }

  private query<T extends Record<string, unknown>>(sql: string): T[] {
    const output = execFileSync("sqlite3", ["-json", this.dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
      input: sql,
      encoding: "utf8",
    }).trim();
    if (!output) return [];
    return JSON.parse(output) as T[];
  }

  ensureSchema(): void {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      throw new Error(`database directory does not exist: ${dir}`);
    }
    this.run(MIGRATION_SQL);
  }

  ingestConversation(request: IngestRequest): void {
    this.run([MIGRATION_SQL, buildUpsertRequestSql(request)].join("\n\n"));
  }

  ingestBatch(requests: IngestRequest[]): void {
    if (requests.length === 0) return;
    const sql = [
      "BEGIN;",
      MIGRATION_SQL,
      ...requests.map(buildUpsertRequestSql),
      "COMMIT;",
    ].join("\n\n");
    this.run(sql);
  }

  listConversations(provider?: ProviderId, limit = 50, cursor?: string): {
    conversations: Conversation[];
    nextCursor: string | null;
  } {
    const rows = this.query<Record<string, unknown>>(buildConversationListQuery(provider, limit, cursor));
    const next = rows.length > limit ? rows.pop() : null;
    return {
      conversations: rows.map(parseConversationRow),
      nextCursor: next
        ? encodeCursor({
            updatedAt: next.updatedAt ? String(next.updatedAt) : null,
            id: String(next.id ?? ""),
          })
        : null,
    };
  }

  getConversation(provider: ProviderId, conversationId: string): Conversation | null {
    const rows = this.query<Record<string, unknown>>(buildConversationQuery(provider, conversationId));
    return rows[0] ? parseConversationRow(rows[0]) : null;
  }

  getMessages(provider: ProviderId, conversationId: string): Message[] {
    return this.query<Record<string, unknown>>(buildMessageQuery(provider, conversationId)).map(parseMessageRow);
  }

  searchConversations(
    query: string,
    provider: ProviderId | undefined,
    limit = 10
  ): ConversationSearchResult[] {
    const rows = this.query<Record<string, unknown>>(buildSearchQuery(query, provider, limit));
    const grouped = new Map<string, ConversationSearchResult>();
    for (const row of rows) {
      const conversation = parseConversationRow(row);
      const key = `${conversation.provider}:${conversation.id}`;
      const existing = grouped.get(key);
      const match = {
        messageId: String(row.messageId ?? ""),
        role: String(row.role ?? "unknown"),
        snippet: String(row.snippet ?? ""),
      };
      if (existing) {
        existing.matches.push(match);
      } else {
        grouped.set(key, { conversation, matches: [match] });
      }
    }
    return [...grouped.values()];
  }

  syncStatus(provider?: ProviderId): SyncProviderStatus[] {
    return this.query<Record<string, unknown>>(buildSyncStatusQuery(provider)).map(parseSyncStatusRow);
  }
}
