import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDatabase } from "../dist/db.js";
import { createIngestHandlers } from "../dist/ingest.js";
import { MIGRATION_SQL } from "../dist/migrations.js";
import { startHttpServer } from "../dist/server.js";
import { getConversationTool } from "../dist/tools/get-conversation.js";
import { getMessagesTool } from "../dist/tools/get-messages.js";
import { listConversationsTool } from "../dist/tools/list-conversations.js";
import { searchConversationsTool } from "../dist/tools/search-conversations.js";
import { syncStatusTool } from "../dist/tools/sync-status.js";

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "polychat-mcp-"));
  const dbPath = join(dir, "history.db");
  const db = new SqliteDatabase(dbPath);
  db.ensureSchema();
  return {
    dir,
    dbPath,
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeRequest(id, messageId = "msg-1", content = "Explain TCP and UDP.", replaceMessages = true) {
  return {
    conversation: {
      id,
      provider: "chatgpt",
      title: "TCP vs UDP",
      url: `https://chatgpt.com/c/${id}`,
      model: "gpt-5-mini",
      createdAt: "2026-06-24T12:00:00.000Z",
      updatedAt: "2026-06-24T12:05:00.000Z",
      lastSyncedAt: "2026-06-24T12:06:00.000Z",
      raw: { source: "fixture" },
    },
    messages: [
      {
        id: messageId,
        provider: "chatgpt",
        conversationId: id,
        role: "user",
        content,
        model: null,
        parentId: null,
        nodeId: "node-1",
        createdAt: "2026-06-24T12:00:01.000Z",
        updatedAt: null,
        raw: { source: "fixture" },
      },
    ],
    replaceMessages,
  };
}

function makeSummaryRequest(id) {
  const request = makeRequest(id);
  return {
    ...request,
    messages: [],
    replaceMessages: false,
  };
}

test("HTTP ingest endpoints upsert conversation and messages", async () => {
  const { db, dbPath, cleanup } = makeDb();
  const server = startHttpServer(
    {
      dbPath,
      ingestToken: "secret",
      ingestHost: "127.0.0.1",
      ingestPort: 0,
      ingestMaxBodyBytes: 1024 * 1024,
    },
    db
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/ingest/conversation`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
    },
    body: JSON.stringify(makeRequest("conv-1")),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);

  const status = await (await fetch(`${baseUrl}/ingest/status`, { headers: { authorization: "Bearer secret" } })).json();
  assert.equal(status.providers[0].conversations, 1);
  assert.equal(status.providers[0].messages, 1);

  const unauthorizedStatus = await fetch(`${baseUrl}/ingest/status`);
  assert.equal(unauthorizedStatus.status, 401);

  server.close();
  cleanup();
});

test("HTTP ingest rejects oversized request bodies", async () => {
  const { db, dbPath, cleanup } = makeDb();
  const server = startHttpServer(
    {
      dbPath,
      ingestToken: "secret",
      ingestHost: "127.0.0.1",
      ingestPort: 0,
      ingestMaxBodyBytes: 64,
    },
    db
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/ingest/conversation`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
    },
    body: JSON.stringify({
      ...makeRequest("conv-oversized"),
      padding: "x".repeat(1024),
    }),
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error, "payload_too_large");

  server.close();
  cleanup();
});

test("batch ingest and tool helpers reuse the same SQLite data", () => {
  const { db, dbPath, cleanup } = makeDb();
  const config = {
    dbPath,
    ingestToken: "secret",
    ingestHost: "127.0.0.1",
    ingestPort: 0,
    ingestMaxBodyBytes: 1024 * 1024,
  };
  const handlers = createIngestHandlers(config, db);
  const response = handlers.batch(
    { authorization: "Bearer secret" },
    {
      conversations: [
        makeRequest("conv-1"),
        makeRequest("conv-2", "msg-2", "Give an overview of HTTP status codes."),
      ],
    }
  );
  assert.equal(response.status, 200);

  const list = listConversationsTool(db, { provider: "chatgpt", limit: 10 });
  assert.equal(list.conversations.length, 2);
  assert.ok(list.nextCursor === null || typeof list.nextCursor === "string");

  const search = searchConversationsTool(db, { query: "TCP (UDP)!", provider: "chatgpt", limit: 10 });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].matches[0].messageId, "msg-1");

  const rawConversation = getConversationTool(db, {
    provider: "chatgpt",
    conversationId: "conv-1",
    includeMessages: true,
    includeRaw: true,
  });
  assert.ok(rawConversation.conversation);
  assert.ok(rawConversation.conversation.raw);
  assert.ok(rawConversation.messages?.[0].raw);

  const sanitizedConversation = getConversationTool(db, {
    provider: "chatgpt",
    conversationId: "conv-1",
    includeMessages: true,
  });
  assert.equal(sanitizedConversation.conversation?.raw, undefined);
  assert.equal(sanitizedConversation.messages?.[0].raw, undefined);

  const conversation = getConversationTool(db, {
    provider: "chatgpt",
    conversationId: "conv-1",
    includeMessages: true,
  });
  assert.equal(conversation.messages?.length, 1);

  const messages = getMessagesTool(db, { provider: "chatgpt", conversationId: "conv-1" });
  assert.equal(messages.messages.length, 1);

  const status = syncStatusTool(db, { provider: "chatgpt" });
  assert.equal(status.providers[0].conversations, 2);

  db.ingestConversation(makeSummaryRequest("conv-1"));
  assert.equal(db.getMessages("chatgpt", "conv-1").length, 1);

  db.ingestConversation(makeRequest("conv-1", "msg-9", "A regenerated answer replaces the old message."));
  const replaced = db.getMessages("chatgpt", "conv-1");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].id, "msg-9");
  assert.equal(replaced[0].content, "A regenerated answer replaces the old message.");

  cleanup();
});

test("ingest auth rejects missing bearer token", () => {
  const { db, dbPath, cleanup } = makeDb();
  const handlers = createIngestHandlers(
    {
      dbPath,
      ingestToken: "secret",
      ingestHost: "127.0.0.1",
      ingestPort: 0,
    },
    db
  );
  const response = handlers.conversation({}, makeRequest("conv-1"));
  assert.equal(response.status, 401);
  cleanup();
});

test("migration sql includes the transcript tables and fts index", () => {
  assert.match(MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS conversations/);
  assert.match(MIGRATION_SQL, /CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts/);
});
