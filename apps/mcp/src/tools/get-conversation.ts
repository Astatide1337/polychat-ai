import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";

export function getConversationTool(
  db: SqliteDatabase,
  input: { provider: ProviderId; conversationId: string; includeMessages?: boolean }
) {
  const conversation = db.getConversation(input.provider, input.conversationId);
  if (!conversation) {
    return { conversation: null, messages: [] };
  }
  return input.includeMessages === false
    ? { conversation }
    : { conversation, messages: db.getMessages(input.provider, input.conversationId) };
}
