import { renderConversationMarkdown, type ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";

export function loadConversationMarkdown(
  db: SqliteDatabase,
  provider: ProviderId,
  conversationId: string
): string | null {
  const conversation = db.getConversation(provider, conversationId);
  if (!conversation) return null;
  const messages = db.getMessages(provider, conversationId);
  return renderConversationMarkdown(conversation, messages);
}
