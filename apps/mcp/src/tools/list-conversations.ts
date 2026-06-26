import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";
import { omitRaw } from "./format.js";

export function listConversationsTool(
  db: SqliteDatabase,
  input: { provider?: ProviderId; limit?: number; cursor?: string; includeRaw?: boolean }
) {
  const result = db.listConversations(input.provider, input.limit ?? 50, input.cursor);
  return {
    conversations: input.includeRaw ? result.conversations : result.conversations.map(omitRaw),
    nextCursor: result.nextCursor,
  };
}
