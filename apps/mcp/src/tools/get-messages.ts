import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";
import { omitRaw } from "./format.js";

export function getMessagesTool(
  db: SqliteDatabase,
  input: { provider: ProviderId; conversationId: string; includeRaw?: boolean }
) {
  const messages = db.getMessages(input.provider, input.conversationId);
  return {
    messages: input.includeRaw ? messages : messages.map(omitRaw),
  };
}
