import type { IncomingHttpHeaders } from "node:http";

import {
  parseConversation,
  parseIngestRequest,
  type IngestRequest,
  type ProviderId,
} from "@polychat-ai/history-core";

import type { McpAppConfig } from "./config.js";
import { SqliteDatabase } from "./db.js";

export type HttpResponse = {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
};

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body };
}

function unauthorized(): HttpResponse {
  return json(401, { ok: false, error: "invalid_or_missing_ingest_token" });
}

function authorize(headers: IncomingHttpHeaders, config: McpAppConfig): boolean {
  if (!config.ingestToken) return false;
  const auth = headers.authorization ?? headers.Authorization;
  if (typeof auth !== "string") return false;
  return auth === `Bearer ${config.ingestToken}`;
}

export function createIngestHandlers(config: McpAppConfig, db: SqliteDatabase) {
  return {
    health(): HttpResponse {
      return json(200, {
        ok: true,
        dbPath: config.dbPath,
        ingestConfigured: Boolean(config.ingestToken),
      });
    },
    status(headers: IncomingHttpHeaders, provider?: ProviderId): HttpResponse {
      if (!authorize(headers, config)) return unauthorized();
      return json(200, {
        ok: true,
        providers: db.syncStatus(provider),
      });
    },
    conversation(headers: IncomingHttpHeaders, body: unknown): HttpResponse {
      if (!authorize(headers, config)) return unauthorized();
      const request = parseIngestRequest(body);
      db.ingestConversation(request);
      return json(200, {
        ok: true,
        conversation: request.conversation,
        messageCount: request.messages.length,
      });
    },
    batch(headers: IncomingHttpHeaders, body: unknown): HttpResponse {
      if (!authorize(headers, config)) return unauthorized();
      const requests = Array.isArray(body)
        ? body.map(parseIngestRequest)
        : Array.isArray((body as { conversations?: unknown })?.conversations)
          ? ((body as { conversations: unknown[] }).conversations.map(parseIngestRequest))
          : [];
      if (requests.length === 0) {
        return json(400, { ok: false, error: "missing_conversations" });
      }
      db.ingestBatch(requests);
      return json(200, {
        ok: true,
        ingested: requests.length,
      });
    },
    parseConversation,
  };
}
