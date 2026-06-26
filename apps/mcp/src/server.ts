import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { ProviderId } from "@polychat-ai/history-core";

import type { McpAppConfig } from "./config.js";
import { createIngestHandlers } from "./ingest.js";
import type { SqliteDatabase } from "./db.js";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function startHttpServer(config: McpAppConfig, db: SqliteDatabase) {
  const handlers = createIngestHandlers(config, db);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        const response = handlers.health();
        return sendJson(res, response.status, response.body);
      }
      if (req.method === "GET" && url.pathname === "/ingest/status") {
        const provider = url.searchParams.get("provider");
        const response = handlers.status(
          req.headers,
          provider === "chatgpt" || provider === "claude" || provider === "gemini"
            ? (provider as ProviderId)
            : undefined
        );
        return sendJson(res, response.status, response.body);
      }
      if (req.method === "POST" && url.pathname === "/ingest/conversation") {
        const response = handlers.conversation(req.headers, await readJsonBody(req));
        return sendJson(res, response.status, response.body);
      }
      if (req.method === "POST" && url.pathname === "/ingest/batch") {
        const response = handlers.batch(req.headers, await readJsonBody(req));
        return sendJson(res, response.status, response.body);
      }
      sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(config.ingestPort, config.ingestHost);
  return server;
}
