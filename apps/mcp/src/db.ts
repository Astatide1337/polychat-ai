import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import sqlite3 from "node-sqlite3-wasm";

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
  type SearchSyntax,
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
  private readonly db: InstanceType<typeof sqlite3.Database>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new sqlite3.Database(dbPath);
  }

  close(): void {
    if (this.db.isOpen) {
      this.db.close();
    }
  }

  private run(sql: string): void {
    this.db.exec(sql);
  }

  private query<T extends Record<string, unknown>>(sql: string): T[] {
    return this.db.all(sql) as T[];
  }

  ensureSchema(): void {
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
    limit = 10,
    syntax: SearchSyntax = "plain"
  ): ConversationSearchResult[] {
    const rows = this.query<Record<string, unknown>>(buildSearchQuery(query, provider, limit, syntax));
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
