import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";
import { omitRaw } from "./format.js";

export function searchConversationsTool(
  db: SqliteDatabase,
  input: {
    query: string;
    provider?: ProviderId;
    limit?: number;
    includeRaw?: boolean;
    syntax?: "plain" | "fts";
  }
) {
  return {
    results: db.searchConversations(input.query, input.provider, input.limit ?? 10, input.syntax ?? "plain").map(
      (result) => ({
        conversation: input.includeRaw ? result.conversation : omitRaw(result.conversation),
        matches: result.matches,
      })
    ),
  };
}
