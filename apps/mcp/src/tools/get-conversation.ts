import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";
import { omitRaw } from "./format.js";

export function getConversationTool(
  db: SqliteDatabase,
  input: {
    provider: ProviderId;
    conversationId: string;
    includeMessages?: boolean;
    includeRaw?: boolean;
  }
) {
  const conversation = db.getConversation(input.provider, input.conversationId);
  if (!conversation) {
    return { conversation: null, messages: [] };
  }
  const sanitizedConversation = input.includeRaw ? conversation : omitRaw(conversation);
  return input.includeMessages === false
    ? { conversation: sanitizedConversation }
    : {
        conversation: sanitizedConversation,
        messages: (input.includeRaw
          ? db.getMessages(input.provider, input.conversationId)
          : db.getMessages(input.provider, input.conversationId).map(omitRaw)),
      };
}
