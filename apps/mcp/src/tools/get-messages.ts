import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";

export function getMessagesTool(
  db: SqliteDatabase,
  input: { provider: ProviderId; conversationId: string }
) {
  return {
    messages: db.getMessages(input.provider, input.conversationId),
  };
}
