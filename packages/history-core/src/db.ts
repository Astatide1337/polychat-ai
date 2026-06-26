import type { Conversation, IngestRequest, Message, ProviderId, SyncProviderStatus } from "./types.js";

export const SQLITE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS conversations (
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  title TEXT,
  url TEXT,
  model TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_synced_at TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (provider, id)
);`,
  `CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  parent_id TEXT,
  node_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  raw_json TEXT,
  PRIMARY KEY (provider, conversation_id, id)
);`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
USING fts5(provider, conversation_id, role, content);`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_provider_updated
ON conversations(provider, updated_at);`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages(provider, conversation_id);`,
  `DROP TRIGGER IF EXISTS messages_ai;`,
  `DROP TRIGGER IF EXISTS messages_ad;`,
  `DROP TRIGGER IF EXISTS messages_au;`,
  `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, provider, conversation_id, role, content)
  VALUES (new.rowid, new.provider, new.conversation_id, new.role, new.content);
END;`,
  `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;`,
  `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, provider, conversation_id, role, content)
  VALUES (new.rowid, new.provider, new.conversation_id, new.role, new.content);
END;`,
].join("\n\n");

function quoteSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlValue(value: string | null | number | boolean | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return quoteSql(value);
}

export function sqlJson(value: unknown): string {
  return sqlValue(JSON.stringify(value));
}

export function buildUpsertConversationSql(conversation: Conversation): string {
  return [
    "INSERT INTO conversations (id, provider, title, url, model, created_at, updated_at, last_synced_at, raw_json)",
    `VALUES (${[
      sqlValue(conversation.id),
      sqlValue(conversation.provider),
      sqlValue(conversation.title),
      sqlValue(conversation.url),
      sqlValue(conversation.model),
      sqlValue(conversation.createdAt),
      sqlValue(conversation.updatedAt),
      sqlValue(conversation.lastSyncedAt),
      sqlJson(conversation.raw),
    ].join(", ")})`,
    "ON CONFLICT(provider, id) DO UPDATE SET",
    [
      "title=excluded.title",
      "url=excluded.url",
      "model=excluded.model",
      "created_at=excluded.created_at",
      "updated_at=excluded.updated_at",
      "last_synced_at=excluded.last_synced_at",
      "raw_json=excluded.raw_json",
    ].join(", "),
    ";",
  ].join(" ");
}

export function buildUpsertMessageSql(message: Message): string {
  return [
    "INSERT INTO messages (id, provider, conversation_id, role, content, model, parent_id, node_id, created_at, updated_at, raw_json)",
    `VALUES (${[
      sqlValue(message.id),
      sqlValue(message.provider),
      sqlValue(message.conversationId),
      sqlValue(message.role),
      sqlValue(message.content),
      sqlValue(message.model),
      sqlValue(message.parentId),
      sqlValue(message.nodeId),
      sqlValue(message.createdAt),
      sqlValue(message.updatedAt),
      sqlJson(message.raw),
    ].join(", ")})`,
    "ON CONFLICT(provider, conversation_id, id) DO UPDATE SET",
    [
      "role=excluded.role",
      "content=excluded.content",
      "model=excluded.model",
      "parent_id=excluded.parent_id",
      "node_id=excluded.node_id",
      "created_at=excluded.created_at",
      "updated_at=excluded.updated_at",
      "raw_json=excluded.raw_json",
    ].join(", "),
    ";",
  ].join(" ");
}

export function buildUpsertRequestSql(request: IngestRequest): string {
  return [
    buildUpsertConversationSql(request.conversation),
    ...request.messages.map(buildUpsertMessageSql),
  ].join("\n\n");
}

export function encodeCursor(value: { updatedAt: string | null; id: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { updatedAt: string | null; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    updatedAt?: string | null;
    id?: string;
  };
  return {
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    id: typeof parsed.id === "string" ? parsed.id : "",
  };
}

export function buildConversationListQuery(
  provider: ProviderId | undefined,
  limit: number,
  cursor?: string
): string {
  const clauses: string[] = [];
  if (provider) clauses.push(`provider = ${sqlValue(provider)}`);
  if (cursor) {
    const { updatedAt, id } = decodeCursor(cursor);
    const updatedAtSql = sqlValue(updatedAt ?? "");
    const idSql = sqlValue(id);
    clauses.push(
      `(COALESCE(updated_at, '') < COALESCE(${updatedAtSql}, '') OR (COALESCE(updated_at, '') = COALESCE(${updatedAtSql}, '') AND id < ${idSql}))`
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return `
SELECT id, provider, title, url, model, created_at as createdAt, updated_at as updatedAt, last_synced_at as lastSyncedAt
FROM conversations
${where}
ORDER BY COALESCE(updated_at, '') DESC, id DESC
LIMIT ${Math.max(1, limit + 1)};
`.trim();
}

export function buildMessageQuery(provider: ProviderId, conversationId: string): string {
  return `
SELECT id, provider, conversation_id as conversationId, role, content, model, parent_id as parentId, node_id as nodeId, created_at as createdAt, updated_at as updatedAt, raw_json as raw
FROM messages
WHERE provider = ${sqlValue(provider)} AND conversation_id = ${sqlValue(conversationId)}
ORDER BY rowid ASC;
`.trim();
}

export function buildConversationQuery(provider: ProviderId, conversationId: string): string {
  return `
SELECT id, provider, title, url, model, created_at as createdAt, updated_at as updatedAt, last_synced_at as lastSyncedAt, raw_json as raw
FROM conversations
WHERE provider = ${sqlValue(provider)} AND id = ${sqlValue(conversationId)}
LIMIT 1;
`.trim();
}

export function buildSearchQuery(
  query: string,
  provider: ProviderId | undefined,
  limit: number
): string {
  const providerClause = provider ? `AND f.provider = ${sqlValue(provider)}` : "";
  return `
WITH ranked AS (
  SELECT
    m.id AS messageId,
    m.provider AS provider,
    m.conversation_id AS conversationId,
    m.role AS role,
    snippet(messages_fts, 3, '<mark>', '</mark>', '...', 8) AS snippet,
    bm25(messages_fts) AS score
  FROM messages_fts f
  JOIN messages m ON m.rowid = f.rowid
  WHERE messages_fts MATCH ${sqlValue(query)} ${providerClause}
  ORDER BY score ASC
  LIMIT ${Math.max(1, limit * 5)}
)
SELECT
  c.id AS id,
  c.provider AS provider,
  c.title AS title,
  c.url AS url,
  c.model AS model,
  c.created_at AS createdAt,
  c.updated_at AS updatedAt,
  c.last_synced_at AS lastSyncedAt,
  ranked.messageId AS messageId,
  ranked.role AS role,
  ranked.snippet AS snippet
FROM ranked
JOIN conversations c ON c.provider = ranked.provider AND c.id = ranked.conversationId
ORDER BY ranked.score ASC
LIMIT ${Math.max(1, limit)};
`.trim();
}

export function buildSyncStatusQuery(provider: ProviderId | undefined): string {
  const where = provider ? `WHERE provider = ${sqlValue(provider)}` : "";
  return `
SELECT
  provider,
  COUNT(DISTINCT id) AS conversations,
  SUM(CASE WHEN message_id IS NOT NULL THEN 1 ELSE 0 END) AS messages,
  MAX(last_synced_at) AS latestSync
FROM (
  SELECT provider, id, last_synced_at, NULL AS message_id FROM conversations
  UNION ALL
  SELECT provider, conversation_id AS id, NULL AS last_synced_at, id AS message_id FROM messages
)
${where}
GROUP BY provider
ORDER BY provider ASC;
`.trim();
}

export function parseConversationRow(row: Record<string, unknown>): Conversation {
  let raw: unknown = null;
  if (typeof row.raw === "string" && row.raw.length > 0) {
    try {
      raw = JSON.parse(row.raw);
    } catch {
      raw = row.raw;
    }
  } else if (row.raw !== undefined) {
    raw = row.raw;
  }
  return {
    id: String(row.id ?? ""),
    provider: row.provider as ProviderId,
    title: row.title === null || row.title === undefined ? null : String(row.title),
    url: row.url === null || row.url === undefined ? null : String(row.url),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    createdAt: row.createdAt === null || row.createdAt === undefined ? null : String(row.createdAt),
    updatedAt: row.updatedAt === null || row.updatedAt === undefined ? null : String(row.updatedAt),
    lastSyncedAt: String(row.lastSyncedAt ?? ""),
    raw,
  };
}

export function parseMessageRow(row: Record<string, unknown>): Message {
  let raw: unknown = null;
  if (typeof row.raw === "string" && row.raw.length > 0) {
    try {
      raw = JSON.parse(row.raw);
    } catch {
      raw = row.raw;
    }
  } else if (row.raw !== undefined) {
    raw = row.raw;
  }
  return {
    id: String(row.id ?? ""),
    provider: row.provider as ProviderId,
    conversationId: String(row.conversationId ?? ""),
    role: row.role as Message["role"],
    content: String(row.content ?? ""),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    parentId: row.parentId === null || row.parentId === undefined ? null : String(row.parentId),
    nodeId: row.nodeId === null || row.nodeId === undefined ? null : String(row.nodeId),
    createdAt: row.createdAt === null || row.createdAt === undefined ? null : String(row.createdAt),
    updatedAt: row.updatedAt === null || row.updatedAt === undefined ? null : String(row.updatedAt),
    raw,
  };
}

export function parseSyncStatusRow(row: Record<string, unknown>): SyncProviderStatus {
  return {
    provider: row.provider as ProviderId,
    conversations: Number(row.conversations ?? 0),
    messages: Number(row.messages ?? 0),
    latestSync: row.latestSync === null || row.latestSync === undefined ? null : String(row.latestSync),
  };
}
