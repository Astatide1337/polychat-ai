import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";

export function listConversationsTool(
  db: SqliteDatabase,
  input: { provider?: ProviderId; limit?: number; cursor?: string }
) {
  return db.listConversations(input.provider, input.limit ?? 50, input.cursor);
}
