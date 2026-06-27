import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  parseConversation,
  parseIngestRequest,
  parseMessage,
  renderConversationMarkdown,
  normalizeChatgptConversation,
  normalizeClaudeConversation,
  normalizeGeminiConversation,
} from "../dist/index.js";

const root = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(root, "..", "fixtures", name), "utf8"));

test("parses normalized conversation and message records", () => {
  const conversation = parseConversation({
    id: "conv-1",
    provider: "chatgpt",
    title: "Hello",
    url: "https://chatgpt.com/c/conv-1",
    model: "gpt-5-mini",
    createdAt: "2026-06-24T12:00:00.000Z",
    updatedAt: "2026-06-24T12:00:01.000Z",
    lastSyncedAt: "2026-06-24T12:01:00.000Z",
    raw: { hello: "world" },
  });
  const message = parseMessage({
    id: "msg-1",
    provider: "chatgpt",
    conversationId: conversation.id,
    role: "user",
    content: "hi",
    model: null,
    parentId: null,
    nodeId: "node-1",
    createdAt: null,
    updatedAt: null,
    raw: { foo: "bar" },
  });
  const request = parseIngestRequest({ conversation, messages: [message] });
  assert.equal(request.conversation.id, "conv-1");
  assert.equal(request.messages[0].content, "hi");
});

test("renders conversation markdown", () => {
  const request = parseIngestRequest({
    conversation: {
      id: "conv-1",
      provider: "claude",
      title: "TCP vs UDP",
      url: "https://claude.ai/chat/conv-1",
      model: "claude-sonnet-4-6",
      createdAt: "2026-06-24T13:00:00.000Z",
      updatedAt: "2026-06-24T13:05:00.000Z",
      lastSyncedAt: "2026-06-24T13:06:00.000Z",
      raw: {},
    },
    messages: [
      {
        id: "m1",
        provider: "claude",
        conversationId: "conv-1",
        role: "user",
        content: "Explain TCP and UDP.",
        model: null,
        parentId: null,
        nodeId: null,
        createdAt: null,
        updatedAt: null,
        raw: {},
      },
    ],
  });
  const markdown = renderConversationMarkdown(request.conversation, request.messages);
  assert.match(markdown, /^# TCP vs UDP/m);
  assert.match(markdown, /Provider: claude/);
  assert.match(markdown, /## User/);
});

test("renders raw structured content when message text is empty", () => {
  const request = parseIngestRequest({
    conversation: {
      id: "conv-raw",
      provider: "gemini",
      title: null,
      url: "https://gemini.google.com/app/conv-raw",
      model: null,
      createdAt: null,
      updatedAt: null,
      lastSyncedAt: "2026-06-24T13:06:00.000Z",
      raw: {},
    },
    messages: [
      {
        id: "m1",
        provider: "gemini",
        conversationId: "conv-raw",
        role: "assistant",
        content: "",
        model: null,
        parentId: null,
        nodeId: null,
        createdAt: null,
        updatedAt: null,
        raw: { parts: [{ type: "image", alt: "Diagram" }] },
      },
    ],
  });
  const markdown = renderConversationMarkdown(request.conversation, request.messages);
  assert.match(markdown, /Diagram/);
});

test("renders media and artifact markers for opaque structured content", () => {
  const request = parseIngestRequest({
    conversation: {
      id: "conv-media",
      provider: "gemini",
      title: null,
      url: "https://gemini.google.com/app/conv-media",
      model: null,
      createdAt: null,
      updatedAt: null,
      lastSyncedAt: "2026-06-24T13:06:00.000Z",
      raw: {},
    },
    messages: [
      {
        id: "m1",
        provider: "gemini",
        conversationId: "conv-media",
        role: "assistant",
        content: "",
        model: null,
        parentId: null,
        nodeId: null,
        createdAt: null,
        updatedAt: null,
        raw: { parts: [{ type: "image", src: "data:image/png;base64,AAAA" }, { kind: "artifact" }] },
      },
    ],
  });
  const markdown = renderConversationMarkdown(request.conversation, request.messages);
  assert.match(markdown, /\[Image\]/);
});

test("normalizes chatgpt fixture", () => {
  const raw = fixture("chatgpt-conversation.json");
  const normalized = normalizeChatgptConversation(raw);
  assert.equal(normalized.conversation.provider, "chatgpt");
  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.messages[0].role, "user");
});

test("normalizes chatgpt branch fixtures and keeps regenerated nodes", () => {
  const raw = fixture("chatgpt-branch-conversation.json");
  const normalized = normalizeChatgptConversation(raw);
  assert.equal(normalized.conversation.provider, "chatgpt");
  assert.equal(normalized.messages.length, 3);
  assert.match(normalized.messages.map((message) => message.content).join("\n"), /regeneration/);
});

test("normalizes chatgpt structured content placeholders", () => {
  const raw = fixture("chatgpt-rich-conversation.json");
  const normalized = normalizeChatgptConversation(raw);
  assert.equal(normalized.conversation.provider, "chatgpt");
  assert.equal(normalized.messages.length, 2);
  assert.match(normalized.messages[1].content, /\[Image\]/);
  assert.match(normalized.messages[1].content, /\[File\]/);
  assert.match(normalized.messages[1].content, /\[Artifact\]/);
});

test("normalizes claude fixture", () => {
  const raw = fixture("claude-conversation.json");
  const normalized = normalizeClaudeConversation(raw);
  assert.equal(normalized.conversation.provider, "claude");
  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.messages[1].role, "assistant");
});

test("normalizes claude human sender as user", () => {
  const normalized = normalizeClaudeConversation({
    uuid: "claude-human-sender",
    messages: [
      {
        uuid: "claude-human-message",
        sender: "human",
        text: "Draft the memo from these notes.",
      },
    ],
  });
  assert.equal(normalized.messages[0].role, "user");
});

test("normalizes gemini fixture", () => {
  const raw = fixture("gemini-conversation.json");
  const normalized = normalizeGeminiConversation(raw);
  assert.equal(normalized.conversation.provider, "gemini");
  assert.equal(normalized.messages.length, 2);
});

test("normalizes gemini body text fallback", () => {
  const normalized = normalizeGeminiConversation({
    id: "gemini-body",
    title: "Body text only",
    bodyText: "Hello from body text",
  });
  assert.equal(normalized.conversation.provider, "gemini");
  assert.equal(normalized.messages.length, 1);
  assert.equal(normalized.messages[0].content, "Hello from body text");
});

test("normalizes gemini wiz fallback with messy content", () => {
  const raw = fixture("gemini-wiz-conversation.json");
  const normalized = normalizeGeminiConversation(raw);
  assert.equal(normalized.conversation.provider, "gemini");
  assert.equal(normalized.messages.length, 2);
  assert.match(normalized.messages[0].content, /TCP and UDP/);
  assert.match(normalized.messages[1].content, /\[Image\]/);
  assert.match(normalized.messages[1].content, /Protocol chart/);
  assert.match(normalized.messages[1].content, /TCP is reliable/);
});

test("ignores gemini shell body text on conversation pages", () => {
  const normalized = normalizeGeminiConversation({
    id: "gemini-shell",
    title: "Google Gemini",
    url: "https://gemini.google.com/app/c_6926b059bcc655bf",
    bodyText: "plus\nmic\narrow_upward\n[Image]\nGoogle Account\nSoham Bhagat",
  });
  assert.equal(normalized.conversation.provider, "gemini");
  assert.equal(normalized.messages.length, 0);
});
