import { createInterface } from "node:readline";

import type { ProviderId } from "@polychat-ai/history-core";

import { loadConfig } from "./config.js";
import { SqliteDatabase } from "./db.js";
import { getConversationTool } from "./tools/get-conversation.js";
import { getMessagesTool } from "./tools/get-messages.js";
import { listConversationsTool } from "./tools/list-conversations.js";
import { searchConversationsTool } from "./tools/search-conversations.js";
import { syncStatusTool } from "./tools/sync-status.js";
import { loadConversationMarkdown } from "./resources/conversation-resource.js";
import { startHttpServer } from "./server.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function methodNotFound(id: string | number | null | undefined) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "Method not found" } };
}

function invalidParams(id: string | number | null | undefined, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message } };
}

function ok(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function parseProvider(value: unknown): ProviderId | undefined {
  return value === "chatgpt" || value === "claude" || value === "gemini" ? value : undefined;
}

async function main() {
  const config = loadConfig();
  const db = new SqliteDatabase(config.dbPath);
  db.ensureSchema();
  const server = startHttpServer(config, db);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    try {
      switch (request.method) {
        case "initialize":
          writeJson(
            ok(request.id, {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "polychat-ai", version: "0.1.0" },
              capabilities: { tools: {}, resources: {} },
            })
          );
          break;
        case "tools/list":
          writeJson(
            ok(request.id, {
              tools: [
                {
                  name: "list_conversations",
                  description: "List synced conversations from SQLite storage.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"] },
                      limit: { type: "number" },
                      cursor: { type: "string" },
                      includeRaw: { type: "boolean" },
                    },
                  },
                },
                {
                  name: "search_conversations",
                  description: "Search conversation transcripts.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      query: { type: "string" },
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"] },
                      limit: { type: "number" },
                      syntax: { type: "string", enum: ["plain", "fts"] },
                      includeRaw: { type: "boolean" },
                    },
                    required: ["query"],
                  },
                },
                {
                  name: "get_conversation",
                  description: "Load a conversation and optionally its messages.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"] },
                      conversationId: { type: "string" },
                      includeMessages: { type: "boolean" },
                      includeRaw: { type: "boolean" },
                    },
                    required: ["provider", "conversationId"],
                  },
                },
                {
                  name: "get_messages",
                  description: "Load all messages for a conversation.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"] },
                      conversationId: { type: "string" },
                      includeRaw: { type: "boolean" },
                    },
                    required: ["provider", "conversationId"],
                  },
                },
                {
                  name: "sync_status",
                  description: "Return per-provider sync counters.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"] },
                    },
                  },
                },
              ],
            })
          );
          break;
        case "resources/list": {
          const resourceConversations = db.listConversations(undefined, 1000).conversations;
          writeJson(
            ok(request.id, {
              resources: resourceConversations.map((conversation) => ({
                uri: `conversation://${conversation.provider}/${encodeURIComponent(conversation.id)}`,
                name: conversation.title ?? conversation.id,
                mimeType: "text/markdown",
              })),
            })
          );
          break;
        }
        case "tools/call": {
          const input = (request.params as { name?: string; arguments?: Record<string, unknown> } | undefined) ?? {};
          const name = input.name ?? "";
          const args = input.arguments ?? {};
          const provider = parseProvider(args.provider);
          const result =
            name === "list_conversations"
              ? listConversationsTool(db, {
                  provider,
                  limit: typeof args.limit === "number" ? args.limit : undefined,
                  cursor: typeof args.cursor === "string" ? args.cursor : undefined,
                  includeRaw: args.includeRaw === undefined ? undefined : Boolean(args.includeRaw),
                })
              : name === "search_conversations"
                ? typeof args.query === "string" && args.query.trim()
                  ? searchConversationsTool(db, {
                      query: args.query,
                      provider,
                      limit: typeof args.limit === "number" ? args.limit : undefined,
                      syntax: args.syntax === "fts" ? "fts" : "plain",
                      includeRaw: args.includeRaw === undefined ? undefined : Boolean(args.includeRaw),
                    })
                  : invalidParams(request.id, "search_conversations requires query")
                : name === "get_conversation"
                  ? provider && typeof args.conversationId === "string" && args.conversationId.trim()
                    ? getConversationTool(db, {
                      provider,
                      conversationId: args.conversationId,
                      includeMessages: args.includeMessages === undefined ? undefined : Boolean(args.includeMessages),
                      includeRaw: args.includeRaw === undefined ? undefined : Boolean(args.includeRaw),
                    })
                    : invalidParams(request.id, "get_conversation requires provider and conversationId")
                  : name === "get_messages"
                  ? provider && typeof args.conversationId === "string" && args.conversationId.trim()
                    ? getMessagesTool(db, {
                      provider,
                      conversationId: args.conversationId,
                      includeRaw: args.includeRaw === undefined ? undefined : Boolean(args.includeRaw),
                    })
                    : invalidParams(request.id, "get_messages requires provider and conversationId")
                  : name === "sync_status"
                      ? syncStatusTool(db, { provider })
                      : null;
          if (!result) {
            writeJson(methodNotFound(request.id));
          } else if (typeof result === "object" && result !== null && "error" in result) {
            writeJson(result);
          } else {
            writeJson(ok(request.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }));
          }
          break;
        }
        case "resources/read": {
          const input = (request.params as { uri?: string } | undefined) ?? {};
          const match = /^conversation:\/\/(chatgpt|claude|gemini)\/(.+)$/.exec(input.uri ?? "");
          if (!match) {
            writeJson(invalidParams(request.id, "Unsupported resource URI"));
            break;
          }
          const markdown = loadConversationMarkdown(db, match[1] as ProviderId, decodeURIComponent(match[2]));
          if (!markdown) {
            writeJson(invalidParams(request.id, "Conversation not found"));
            break;
          }
          writeJson(ok(request.id, { contents: [{ uri: input.uri, mimeType: "text/markdown", text: markdown }] }));
          break;
        }
        case "notifications/initialized":
          break;
        default:
          writeJson(methodNotFound(request.id));
      }
    } catch (error) {
      writeJson({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  process.on("SIGINT", () => {
    server.close();
    db.close();
    rl.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.close();
    db.close();
    rl.close();
    process.exit(0);
  });
}

void main();
