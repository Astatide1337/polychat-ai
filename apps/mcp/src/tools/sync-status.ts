import type { ProviderId } from "@polychat-ai/history-core";

import type { SqliteDatabase } from "../db.js";

export function syncStatusTool(db: SqliteDatabase, input: { provider?: ProviderId }) {
  return {
    providers: db.syncStatus(input.provider),
  };
}
