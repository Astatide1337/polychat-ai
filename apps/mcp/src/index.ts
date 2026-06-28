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
                  name: "list_polychat_conversations",
                  description: "Browse synced conversation history. Returns paginated list of conversations across ChatGPT, Claude, or Gemini with titles, models, and timestamps. Use provider filter to narrow by source, cursor for pagination.",
                  annotations: { title: "List Polychat conversations", readOnlyHint: true },
                  inputSchema: {
                    type: "object",
                    properties: {
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"], description: "Filter by provider (omit for all)" },
                      limit: { type: "number", description: "Max results (default 50)" },
                      cursor: { type: "string", description: "Pagination cursor from previous response" },
                      includeRaw: { type: "boolean", description: "Include raw provider data" },
                    },
                  },
                },
                {
                  name: "search_conversations",
                  description: "Full-text search across all synced conversation transcripts. Returns matching conversations with highlighted snippets. Supports plain text or SQLite FTS5 syntax for advanced queries.",
                  annotations: { title: "Search conversation transcripts", readOnlyHint: true },
                  inputSchema: {
                    type: "object",
                    properties: {
                      query: { type: "string", description: "Search query (plain text or FTS5 syntax)" },
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"], description: "Limit search to a specific provider" },
                      limit: { type: "number", description: "Max results (default 10)" },
                      syntax: { type: "string", enum: ["plain", "fts"], description: "Search syntax: plain for basic, fts for advanced SQLite FTS5 queries" },
                      includeRaw: { type: "boolean", description: "Include raw provider data" },
                    },
                    required: ["query"],
                  },
                },
                {
                  name: "get_conversation",
                  description: "Retrieve a full conversation by provider and ID. Optionally include all messages in a single call. Use the markdown resource URI conversation://{provider}/{id} for a formatted transcript.",
                  annotations: { title: "Get conversation details", readOnlyHint: true },
                  inputSchema: {
                    type: "object",
                    properties: {
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"], description: "Provider the conversation belongs to" },
                      conversationId: { type: "string", description: "Provider-native conversation ID" },
                      includeMessages: { type: "boolean", description: "Include all messages in response" },
                      includeRaw: { type: "boolean", description: "Include raw provider data" },
                    },
                    required: ["provider", "conversationId"],
                  },
                },
                {
                  name: "get_messages",
                  description: "Load all messages for a specific conversation. Returns ordered message array with roles (user/assistant/system) and content. Use get_conversation if you also need conversation metadata.",
                  annotations: { title: "Get conversation messages", readOnlyHint: true },
                  inputSchema: {
                    type: "object",
                    properties: {
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"], description: "Provider the conversation belongs to" },
                      conversationId: { type: "string", description: "Provider-native conversation ID" },
                      includeRaw: { type: "boolean", description: "Include raw provider data" },
                    },
                    required: ["provider", "conversationId"],
                  },
                },
                {
                  name: "sync_status",
                  description: "Get per-provider sync statistics: total conversation count, message count, and last sync timestamp. Omit provider to get all providers at once.",
                  annotations: { title: "View sync status", readOnlyHint: true },
                  inputSchema: {
                    type: "object",
                    properties: {
                      provider: { type: "string", enum: ["chatgpt", "claude", "gemini"], description: "Filter by provider (omit for all)" },
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
            name === "list_polychat_conversations"
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
