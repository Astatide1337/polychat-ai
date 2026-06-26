import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";

export function searchConversationsTool(
  db: SqliteDatabase,
  input: { query: string; provider?: ProviderId; limit?: number }
) {
  return {
    results: db.searchConversations(input.query, input.provider, input.limit ?? 10),
  };
}
