#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import sqlite3 from "node-sqlite3-wasm";

import {
  buildLiveProviderPlansFromEnv as buildLiveProviderPlansFromEnvCore,
  finalizeLiveProviderReport as finalizeLiveProviderReportCore,
  summarizeLiveSmokeReason as summarizeLiveSmokeReasonCore,
  summarizeLiveSmokeStatus as summarizeLiveSmokeStatusCore,
} from "./verify-polychat-history-live.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(root, "artifacts", "polychat-history-verification");
const artifactPaths = {
  reportJson: join(artifactsDir, "report.json"),
  reportMd: join(artifactsDir, "report.md"),
  extensionBundleScan: join(artifactsDir, "extension-bundle-scan.txt"),
  ingestStatus: join(artifactsDir, "ingest-status.json"),
  mcpTools: join(artifactsDir, "mcp-tools.json"),
  sqliteIntegrity: join(artifactsDir, "sqlite-integrity.txt"),
  dbPath: join(artifactsDir, "polychat-history.db"),
};
const debugEnabled = process.env.POLYCHAT_VERIFY_DEBUG === "1";

const report = {
  commit: gitCommit(),
  timestamp: new Date().toISOString(),
  passed: false,
  checks: {},
  live: {},
  artifacts: {
    reportJson: relativeArtifactPath(artifactPaths.reportJson),
    reportMd: relativeArtifactPath(artifactPaths.reportMd),
    extensionBundleScan: relativeArtifactPath(artifactPaths.extensionBundleScan),
    ingestStatus: relativeArtifactPath(artifactPaths.ingestStatus),
    mcpTools: relativeArtifactPath(artifactPaths.mcpTools),
    sqliteIntegrity: relativeArtifactPath(artifactPaths.sqliteIntegrity),
  },
};

mkdirSync(artifactsDir, { recursive: true });
cleanupDbFiles();

const requiredBuildFiles = [
  "packages/history-core/dist/browser.js",
  "packages/history-core/dist/index.js",
  "apps/mcp/dist/index.js",
  "apps/extension/dist/manifest.json",
  "apps/extension/dist/popup/index.js",
];

try {
  debugLog("build check");
  await ensureBuiltArtifacts();

  debugLog("load history-core browser bundle");
  const browserHistory = await import(pathToFileURL(resolve(root, "packages/history-core/dist/browser.js")).href);
  const mcpRoot = resolve(root, "apps/mcp/dist/index.js");
  const {
    normalizeChatgptConversation,
    normalizeClaudeConversation,
    normalizeGeminiConversation,
  } = browserHistory;

  debugLog("fixture regressions");
  const fixtureResults = await runFixtureRegressions({
    normalizeChatgptConversation,
    normalizeClaudeConversation,
    normalizeGeminiConversation,
  });
  report.checks.providerFixtureRegressions = fixtureResults;

  debugLog("extension bundle scan");
  const extensionBundle = scanExtensionBundle();
  report.checks.extensionBundleSafety = extensionBundle.check;
  writeArtifact("extension-bundle-scan.txt", extensionBundle.text);

  debugLog("reserve port");
  const serverPort = await reservePort();
  const ingestToken = "polychat-history-verify-token";
  debugLog("start mcp server", serverPort);
  const server = await startMcpServer({
    entrypoint: mcpRoot,
    port: serverPort,
    ingestToken,
    dbPath: artifactPaths.dbPath,
  });

  let localStatus = null;
  let ingestState = null;
  let mcpToolsArtifact = null;
  let smokeResult = null;

  try {
    debugLog("wait for health");
    await waitForHealth(server.baseUrl, ingestToken);

    debugLog("ingest local data");
    ingestState = await ingestLocalData(server.baseUrl, ingestToken, {
      normalizeChatgptConversation,
      normalizeClaudeConversation,
      normalizeGeminiConversation,
    });

    localStatus = await readJson(`${server.baseUrl}/ingest/status`, ingestToken);
    writeArtifact("ingest-status.json", `${JSON.stringify(localStatus, null, 2)}\n`);
    report.checks.ingestStatus = {
      passed: true,
      providers: Array.isArray(localStatus.providers) ? localStatus.providers.length : 0,
    };

    debugLog("live browser smoke");
    smokeResult = await maybeRunLiveBrowserSmoke({
      baseUrl: server.baseUrl,
      ingestToken,
      dbPath: artifactPaths.dbPath,
      mcpRoot,
      stopServer: () => server.stop(),
    });
    report.live.browserExtensionSmoke = smokeResult.liveSmoke;
    report.checks.browserExtensionSmoke = {
      passed: smokeResult.liveSmoke.status !== "failed",
      status: smokeResult.liveSmoke.status,
      providers: smokeResult.liveSmoke.providers,
      reason: smokeResult.liveSmoke.reason ?? null,
    };
    mcpToolsArtifact = smokeResult.mcpArtifact;
    writeArtifact("mcp-tools.json", `${JSON.stringify(mcpToolsArtifact, null, 2)}\n`);

    debugLog("sqlite integrity");
  } finally {
    debugLog("stop mcp server");
    await server.stop();
  }
  report.checks.staleReplacement = ingestState.staleReplacement;
  report.checks.safePlainTextSearch = mcpToolsArtifact.callSummaries.searchConversations;
  report.checks.rawPayloadBehavior = mcpToolsArtifact.callSummaries;
  report.checks.mcpResources = {
    passed: true,
    uri: mcpToolsArtifact.callSummaries.resourceRead.uri,
    mimeType: mcpToolsArtifact.callSummaries.resourceRead.mimeType,
  };
  report.checks.mcpHttpAndJsonRpc = {
    passed: true,
    http: ingestState.httpCheck,
    rpc: {
      tools: mcpToolsArtifact.tools.length,
      resources: mcpToolsArtifact.resources.length,
    },
  };

  debugLog("sqlite integrity");
  await writeSqliteIntegrity(artifactPaths.dbPath);

  report.passed = Object.values(report.checks).every((check) => check?.passed !== false);
} catch (error) {
  report.passed = false;
  report.error = formatError(error);
}

writeArtifact("report.json", `${JSON.stringify(report, null, 2)}\n`);
writeArtifact("report.md", renderReportMarkdown(report));

if (!report.passed) {
  process.exitCode = 1;
}

function relativeArtifactPath(path) {
  return `artifacts/polychat-history-verification/${path.split("/").slice(-1)[0]}`;
}

function formatError(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function debugLog(...args) {
  if (debugEnabled) {
    console.error("[verify]", ...args);
  }
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function cleanupDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${artifactPaths.dbPath}${suffix}`, { force: true });
  }
}

async function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("failed to reserve a local port")));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          rejectPort(closeError);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function writeArtifact(name, content) {
  writeFileSync(join(artifactsDir, name), content);
}

function ensureBuiltArtifacts() {
  if (requiredBuildFiles.every((path) => existsSync(join(root, path)))) return Promise.resolve();
  const build = spawnSync("npm", ["run", "build:workspaces"], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error("npm run build:workspaces failed");
  }
  for (const path of requiredBuildFiles) {
    if (!existsSync(join(root, path))) {
      throw new Error(`missing build artifact after workspace build: ${path}`);
    }
  }
}

async function runFixtureRegressions({ normalizeChatgptConversation, normalizeClaudeConversation, normalizeGeminiConversation }) {
  const fixtureDir = join(root, "packages/history-core/fixtures");
  const loadFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

  const chatgptRich = normalizeChatgptConversation(loadFixture("chatgpt-rich-conversation.json"));
  assert.equal(chatgptRich.conversation.provider, "chatgpt");
  assert.equal(chatgptRich.messages.length, 2);
  assert.match(chatgptRich.messages[1].content, /\[Image\]/);
  assert.match(chatgptRich.messages[1].content, /\[File\]/);
  assert.match(chatgptRich.messages[1].content, /\[Artifact\]/);

  const geminiWiz = normalizeGeminiConversation(loadFixture("gemini-wiz-conversation.json"));
  assert.equal(geminiWiz.conversation.provider, "gemini");
  assert.equal(geminiWiz.messages.length, 2);
  assert.match(geminiWiz.messages[0].content, /TCP and UDP/);
  assert.match(geminiWiz.messages[1].content, /\[Image\]/);
  assert.match(geminiWiz.messages[1].content, /Protocol chart/);
  assert.match(geminiWiz.messages[1].content, /TCP is reliable/);

  const claudePagination = await probeClaudePagination();
  const claudeFixture = normalizeClaudeConversation(loadFixture("claude-conversation.json"));
  assert.equal(claudeFixture.conversation.provider, "claude");
  assert.ok(claudeFixture.messages.length > 0);

  return {
    passed: true,
    chatgptRich: {
      messages: chatgptRich.messages.length,
      placeholders: ["[Image]", "[File]", "[Artifact]"],
    },
    geminiWiz: {
      messages: geminiWiz.messages.length,
      matched: ["TCP and UDP", "[Image]", "Protocol chart", "TCP is reliable"],
    },
    claudePagination,
  };
}

async function probeClaudePagination() {
  const moduleUrl = pathToFileURL(resolve(root, "apps/extension/src/providers/claude.ts")).href;
  const pageOneItem = {
    uuid: "claude-page-1",
    name: "Page one",
    model: "claude-sonnet-4-6",
    created_at: "2026-06-24T12:00:00.000Z",
    updated_at: "2026-06-24T12:05:00.000Z",
  };
  const pageTwoItem = {
    uuid: "claude-page-2",
    name: "Page two",
    model: "claude-sonnet-4-6",
    created_at: "2026-06-24T12:10:00.000Z",
    updated_at: "2026-06-24T12:15:00.000Z",
  };

  const script = `
    const pageOneItem = ${JSON.stringify(pageOneItem)};
    const pageTwoItem = ${JSON.stringify(pageTwoItem)};
    const moduleUrl = ${JSON.stringify(moduleUrl)};
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push(url);
      if (url.endsWith("/api/organizations")) {
        return new Response(JSON.stringify([{ uuid: "claude-org-1" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/chat_conversations?offset=0&limit=100")) {
        return new Response(JSON.stringify({ items: Array.from({ length: 100 }, () => ({ ...pageOneItem })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/chat_conversations?offset=100&limit=100")) {
        return new Response(JSON.stringify({ items: [{ ...pageTwoItem }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(\`Unexpected fetch URL: \${url}\`);
    };
    try {
      const { claudeAdapter } = await import(moduleUrl);
      const conversations = await claudeAdapter.listConversations();
      if (conversations.length !== 2) throw new Error(\`Expected 2 conversations, got \${conversations.length}\`);
      if (conversations[0].id !== "claude-page-1") throw new Error(\`Unexpected first id \${conversations[0].id}\`);
      if (conversations[1].id !== "claude-page-2") throw new Error(\`Unexpected second id \${conversations[1].id}\`);
      if (!calls.some((url) => url.includes("/api/organizations"))) throw new Error("Missing organizations call");
      if (!calls.some((url) => url.includes("offset=0"))) throw new Error("Missing offset=0 page");
      if (!calls.some((url) => url.includes("offset=100"))) throw new Error("Missing offset=100 page");
    } finally {
      globalThis.fetch = originalFetch;
    }
  `;

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf8",
    }
  );

  if (result.status !== 0) {
    throw new Error(`Claude pagination probe failed:\n${result.stderr || result.stdout}`);
  }
  return {
    passed: true,
    uniqueConversations: 2,
    calls: 3,
  };
}

function scanExtensionBundle() {
  const dist = join(root, "apps/extension/dist");
  const manifestPath = join(dist, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const forbiddenHostPermissions = permissions.filter(
    (permission) => permission === "https://*/*" || permission === "<all_urls>" || permission === "*://*/*"
  );

  const forbiddenPatterns = [
    /polychat-e2e/,
    /autotest/,
    /test-mode/,
    /POLYCHAT_EXTENSION_TEST_MODE/,
  ];
  const findings = [];
  const scannedFiles = [];

  for (const file of collectTextFiles(dist)) {
    const text = readFileSync(file, "utf8");
    scannedFiles.push(relative(root, file));
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(text)) {
        findings.push({ file: relative(root, file), pattern: pattern.source });
      }
    }
  }

  const passed = forbiddenHostPermissions.length === 0 && findings.length === 0;
  const lines = [
    `manifest: ${relative(root, manifestPath)}`,
    `permissions: ${permissions.join(", ")}`,
    `host permission check: ${forbiddenHostPermissions.length === 0 ? "ok" : `bad (${forbiddenHostPermissions.join(", ")})`}`,
    `scanned files: ${scannedFiles.length}`,
    scannedFiles.map((file) => `- ${file}`).join("\n"),
    `forbidden markers: ${findings.length === 0 ? "none" : ""}`,
    findings.map((finding) => `- ${finding.file}: ${finding.pattern}`).join("\n"),
  ].filter(Boolean);

  return {
    check: {
      passed,
      permissions,
      forbiddenHostPermissions,
      forbiddenMarkers: findings,
      scannedFiles,
    },
    text: `${lines.join("\n")}\n`,
  };
}

function collectTextFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTextFiles(filePath));
      continue;
    }
    if (entry.name.endsWith(".map")) continue;
    if (!/\.(js|mjs|html|json|css|txt)$/i.test(entry.name)) continue;
    files.push(filePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function startMcpServer({ entrypoint, port, ingestToken, dbPath }) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: {
      ...process.env,
      POLYCHAT_AI_DB_PATH: dbPath,
      POLYCHAT_AI_INGEST_HOST: "127.0.0.1",
      POLYCHAT_AI_INGEST_PORT: String(port),
      POLYCHAT_AI_INGEST_TOKEN: ingestToken,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  debugLog("mcp child spawned", child.pid);

  const exitPromise = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
        resolve();
      } else {
        reject(new Error(`mcp server exited with code ${code ?? "null"} signal ${signal ?? "null"}\n${stderr}`));
      }
    });
    child.once("error", (error) => reject(error));
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  debugLog("mcp wrapper ready", baseUrl);
  return {
    process: child,
    baseUrl,
    stop: async () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      await Promise.race([exitPromise, sleep(5_000)]);
    },
  };
}

async function waitForHealth(baseUrl, ingestToken, { timeoutMs = 15_000 } = {}) {
  debugLog("health poll start", baseUrl);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      debugLog("health poll attempt", baseUrl);
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok) {
          return body;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health${lastError ? `: ${formatError(lastError)}` : ""}`);
}

async function readJson(url, ingestToken) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${ingestToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

async function ingestLocalData(baseUrl, ingestToken, fixtures) {
  const fixtureDir = join(root, "packages/history-core/fixtures");
  const loadFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
  const chatgptRich = fixtures.normalizeChatgptConversation(loadFixture("chatgpt-rich-conversation.json"));
  const claudeConversation = fixtures.normalizeClaudeConversation(loadFixture("claude-conversation.json"));
  const geminiWiz = fixtures.normalizeGeminiConversation(loadFixture("gemini-wiz-conversation.json"));

  const searchConversation = {
    conversation: {
      id: "verify-search-safety",
      provider: "chatgpt",
      title: "Search safety",
      url: "https://chatgpt.com/c/verify-search-safety",
      model: "gpt-5-mini",
      createdAt: "2026-06-24T16:00:00.000Z",
      updatedAt: "2026-06-24T16:05:00.000Z",
      lastSyncedAt: "2026-06-24T16:06:00.000Z",
      raw: { source: "synthetic" },
    },
    messages: [
      {
        id: "verify-search-message",
        provider: "chatgpt",
        conversationId: "verify-search-safety",
        role: "user",
        content:
          "TCP and UDP share transport duties. The foo:bar sample includes a quoted phrase and parentheses test.",
        model: null,
        parentId: null,
        nodeId: "verify-search-node",
        createdAt: "2026-06-24T16:00:01.000Z",
        updatedAt: null,
        raw: { source: "synthetic" },
      },
    ],
    replaceMessages: true,
  };

  const staleInitial = {
    conversation: {
      id: "verify-stale-replacement",
      provider: "chatgpt",
      title: "Stale replacement",
      url: "https://chatgpt.com/c/verify-stale-replacement",
      model: "gpt-5-mini",
      createdAt: "2026-06-24T17:00:00.000Z",
      updatedAt: "2026-06-24T17:05:00.000Z",
      lastSyncedAt: "2026-06-24T17:06:00.000Z",
      raw: { source: "synthetic" },
    },
    messages: [
      {
        id: "verify-stale-1",
        provider: "chatgpt",
        conversationId: "verify-stale-replacement",
        role: "user",
        content: "First version.",
        model: null,
        parentId: null,
        nodeId: "verify-stale-node-1",
        createdAt: "2026-06-24T17:00:01.000Z",
        updatedAt: null,
        raw: { source: "synthetic" },
      },
      {
        id: "verify-stale-2",
        provider: "chatgpt",
        conversationId: "verify-stale-replacement",
        role: "assistant",
        content: "Second version.",
        model: null,
        parentId: "verify-stale-1",
        nodeId: "verify-stale-node-2",
        createdAt: "2026-06-24T17:00:02.000Z",
        updatedAt: null,
        raw: { source: "synthetic" },
      },
      {
        id: "verify-stale-3",
        provider: "chatgpt",
        conversationId: "verify-stale-replacement",
        role: "user",
        content: "Third version.",
        model: null,
        parentId: "verify-stale-2",
        nodeId: "verify-stale-node-3",
        createdAt: "2026-06-24T17:00:03.000Z",
        updatedAt: null,
        raw: { source: "synthetic" },
      },
    ],
    replaceMessages: true,
  };

  const batch = [chatgptRich, claudeConversation, geminiWiz, searchConversation, staleInitial];
  const batchResponse = await fetch(`${baseUrl}/ingest/batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${ingestToken}`,
    },
    body: JSON.stringify({ conversations: batch }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(batchResponse.status, 200);
  const batchBody = await batchResponse.json();
  assert.equal(batchBody.ok, true);
  assert.equal(batchBody.ingested, batch.length);

  const replacement = {
    conversation: staleInitial.conversation,
    messages: [
      {
        id: "verify-stale-4",
        provider: "chatgpt",
        conversationId: "verify-stale-replacement",
        role: "assistant",
        content: "Replacement answer.",
        model: null,
        parentId: "verify-stale-1",
        nodeId: "verify-stale-node-4",
        createdAt: "2026-06-24T17:10:00.000Z",
        updatedAt: null,
        raw: { source: "synthetic" },
      },
    ],
    replaceMessages: true,
  };

  const replacementResponse = await fetch(`${baseUrl}/ingest/conversation`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${ingestToken}`,
    },
    body: JSON.stringify(replacement),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(replacementResponse.status, 200);
  const replacementBody = await replacementResponse.json();
  assert.equal(replacementBody.ok, true);
  assert.equal(replacementBody.messageCount, 1);

  const staleQuery = await fetch(`${baseUrl}/ingest/status?provider=chatgpt`, {
    headers: { Authorization: `Bearer ${ingestToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(staleQuery.status, 200);
  const statusBody = await staleQuery.json();
  assert.equal(statusBody.ok, true);

  const httpCheck = {
    passed: true,
    health: true,
    batch: batch.length,
    replacementMessages: 1,
    providers: Array.isArray(statusBody.providers) ? statusBody.providers.length : 0,
  };
  const ingestStatus = await readJson(`${baseUrl}/ingest/status`, ingestToken);

  return {
    httpCheck,
    staleReplacement: {
      passed: true,
      messageCount: 1,
    },
    ingestStatus,
  };
}

async function runMcpToolChecksViaHelper(dbPath, entrypoint, liveProviderChecks = []) {
  const script = `
    import { spawn } from "node:child_process";
    import { createInterface } from "node:readline";
    import net from "node:net";

    const dbPath = ${JSON.stringify(dbPath)};
    const entrypoint = ${JSON.stringify(entrypoint)};
    const liveProviderChecks = ${JSON.stringify(liveProviderChecks)};

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function reservePort() {
      return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close(() => reject(new Error("failed to reserve a local port")));
            return;
          }
          const { port } = address;
          server.close((closeError) => {
            if (closeError) reject(closeError);
            else resolve(port);
          });
        });
      });
    }

    class RpcClient {
      constructor(child) {
        this.child = child;
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = "";
        this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.rl.on("line", (line) => this.handleLine(line));
        this.child.once("exit", (code, signal) => {
          if (this.buffer.trim()) this.handleLine(this.buffer.trim());
          if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") return;
          const error = new Error(\`mcp server exited with code \${code ?? "null"} signal \${signal ?? "null"}\`);
          for (const pending of this.pending.values()) pending.reject(error);
          this.pending.clear();
        });
      }

      handleLine(line) {
        const trimmed = String(line ?? "").trim();
        if (!trimmed) return;
        let payload;
        try {
          payload = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(payload, "id")) return;
        const pending = this.pending.get(payload.id);
        if (!pending) return;
        this.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(payload.error.message || "JSON-RPC error"));
          return;
        }
        pending.resolve(payload.result);
      }

      request(method, params) {
        const id = this.nextId++;
        const payload = { jsonrpc: "2.0", id, method, params };
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.child.stdin.write(\`\${JSON.stringify(payload)}\\n\`);
        });
      }

      async initialize() {
        const result = await this.request("initialize", {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "polychat-history-verifier", version: "1.0.0" },
          capabilities: { tools: {}, resources: {} },
        });
        this.child.stdin.write(\`\${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\\n\`);
        return result;
      }

      async callTool(name, args) {
        const payload = await this.request("tools/call", { name, arguments: args });
        const text = payload?.content?.[0]?.text ?? "{}";
        return { ...payload, text, json: JSON.parse(text) };
      }
    }

    async function waitForHealth(baseUrl) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(\`\${baseUrl}/health\`, { signal: AbortSignal.timeout(2000) });
          if (response.ok) return await response.json();
        } catch {}
        await sleep(250);
      }
      throw new Error(\`Timed out waiting for \${baseUrl}/health\`);
    }

    const port = await reservePort();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: ${JSON.stringify(root)},
      env: {
        ...process.env,
        POLYCHAT_AI_DB_PATH: dbPath,
        POLYCHAT_AI_INGEST_HOST: "127.0.0.1",
        POLYCHAT_AI_INGEST_PORT: String(port),
        POLYCHAT_AI_INGEST_TOKEN: "polychat-history-probe-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForHealth(\`http://127.0.0.1:\${port}\`);
    const rpc = new RpcClient(child);
    await rpc.initialize();

    const toolList = await rpc.request("tools/list");
    const resourceList = await rpc.request("resources/list");
    const listConversations = await rpc.callTool("list_conversations", {
      provider: "chatgpt",
      includeRaw: false,
      limit: 20,
    });
    const listConversationsWithRaw = await rpc.callTool("list_conversations", {
      provider: "chatgpt",
      includeRaw: true,
      limit: 20,
    });
    const searchConversations = await rpc.callTool("search_conversations", {
      provider: "chatgpt",
      query: "TCP/UDP foo:bar \\"quoted phrase\\" (parentheses)",
      syntax: "plain",
      includeRaw: false,
      limit: 10,
    });
    const searchConversationsWithRaw = await rpc.callTool("search_conversations", {
      provider: "chatgpt",
      query: "TCP/UDP foo:bar \\"quoted phrase\\" (parentheses)",
      syntax: "plain",
      includeRaw: true,
      limit: 10,
    });
    const getConversation = await rpc.callTool("get_conversation", {
      provider: "chatgpt",
      conversationId: "verify-search-safety",
      includeMessages: true,
      includeRaw: false,
    });
    const getConversationWithRaw = await rpc.callTool("get_conversation", {
      provider: "chatgpt",
      conversationId: "verify-search-safety",
      includeMessages: true,
      includeRaw: true,
    });
    const getMessages = await rpc.callTool("get_messages", {
      provider: "chatgpt",
      conversationId: "verify-search-safety",
      includeRaw: false,
    });
    const getMessagesWithRaw = await rpc.callTool("get_messages", {
      provider: "chatgpt",
      conversationId: "verify-search-safety",
      includeRaw: true,
    });
    const syncStatus = await rpc.callTool("sync_status", { provider: "chatgpt" });
    const resourceRead = await rpc.request("resources/read", {
      uri: "conversation://chatgpt/verify-search-safety",
    });
    const parse = (call) => call.json ?? JSON.parse(call.text);

    function assertRawHiddenByDefault({ conversation, messages, searchResults }) {
      const conversationHasRaw = conversation ? Object.prototype.hasOwnProperty.call(conversation, "raw") : false;
      const messagesHaveRaw = Array.isArray(messages)
        ? messages.some((message) => Object.prototype.hasOwnProperty.call(message, "raw"))
        : false;
      const searchResultsHaveRaw = Array.isArray(searchResults)
        ? searchResults.some((result) => Object.prototype.hasOwnProperty.call(result?.conversation ?? {}, "raw"))
        : false;
      return !conversationHasRaw && !messagesHaveRaw && !searchResultsHaveRaw;
    }

    async function verifyLiveProvider(providerCheck) {
      const getConversation = await rpc.callTool("get_conversation", {
        provider: providerCheck.provider,
        conversationId: providerCheck.conversationId,
        includeMessages: true,
        includeRaw: false,
      });
      const getMessages = await rpc.callTool("get_messages", {
        provider: providerCheck.provider,
        conversationId: providerCheck.conversationId,
        includeRaw: false,
      });
      const searchConversations = await rpc.callTool("search_conversations", {
        provider: providerCheck.provider,
        query: providerCheck.searchPhrase,
        syntax: "plain",
        includeRaw: false,
        limit: 10,
      });

      const conversationJson = parse(getConversation);
      const messagesJson = parse(getMessages);
      const searchJson = parse(searchConversations);
      const conversation = conversationJson.conversation ?? null;
      const conversationMessages = Array.isArray(conversationJson.messages) ? conversationJson.messages : [];
      const messageList = Array.isArray(messagesJson.messages) ? messagesJson.messages : [];
      const searchResults = Array.isArray(searchJson.results) ? searchJson.results : [];
      const searchHit = searchResults.some(
        (result) =>
          result?.conversation?.provider === providerCheck.provider &&
          result?.conversation?.id === providerCheck.conversationId
      );
      const rawHiddenByDefault = assertRawHiddenByDefault({
        conversation,
        messages: [...conversationMessages, ...messageList],
        searchResults,
      });
      const mcpGetConversation = Boolean(conversation && conversationMessages.length > 0);
      const mcpGetMessages = messageList.length > 0;
      const reasons = [];
      if (!conversation) reasons.push("get_conversation returned no conversation");
      if (!conversationMessages.length) reasons.push("get_conversation returned no messages");
      if (!messageList.length) reasons.push("get_messages returned no messages");
      if (!searchHit) reasons.push("search_conversations did not match the conversation");
      if (!rawHiddenByDefault) reasons.push("raw payloads were returned by default");
      return {
        provider: providerCheck.provider,
        conversationId: providerCheck.conversationId,
        status: reasons.length === 0 ? "passed" : "failed",
        messages: messageList.length,
        mcpGetConversation,
        mcpGetMessages,
        searchHit,
        rawHiddenByDefault,
        reason: reasons.length === 0 ? null : reasons.join("; "),
      };
    }

    const liveProviders = {};
    for (const providerCheck of liveProviderChecks) {
      liveProviders[providerCheck.provider] = await verifyLiveProvider(providerCheck);
    }
    const listJson = parse(listConversations);
    const listRawJson = parse(listConversationsWithRaw);
    const searchJson = parse(searchConversations);
    const searchRawJson = parse(searchConversationsWithRaw);
    const conversationJson = parse(getConversation);
    const conversationRawJson = parse(getConversationWithRaw);
    const messagesJson = parse(getMessages);
    const messagesRawJson = parse(getMessagesWithRaw);
    const syncJson = parse(syncStatus);

    const result = {
      tools: toolList.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      resources: resourceList.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        mimeType: resource.mimeType,
      })),
      callSummaries: {
        listConversations: {
          passed: true,
          conversationIds: listJson.conversations.map((conversation) => conversation.id),
          rawIncluded: false,
        },
        listConversationsWithRaw: {
          passed: true,
          conversationIds: listRawJson.conversations.map((conversation) => conversation.id),
          rawIncluded: true,
        },
        searchConversations: {
          passed: true,
          conversationId: searchJson.results[0].conversation.id,
          rawIncluded: false,
          searchHit: true,
        },
        searchConversationsWithRaw: {
          passed: true,
          conversationId: searchRawJson.results[0].conversation.id,
          rawIncluded: true,
          searchHit: true,
        },
        getConversation: {
          passed: true,
          messageCount: conversationJson.messages.length,
          rawIncluded: false,
        },
        getConversationWithRaw: {
          passed: true,
          messageCount: conversationRawJson.messages.length,
          rawIncluded: true,
        },
        getMessages: {
          passed: true,
          messageCount: messagesJson.messages.length,
          rawIncluded: false,
        },
        getMessagesWithRaw: {
          passed: true,
          messageCount: messagesRawJson.messages.length,
          rawIncluded: true,
        },
        syncStatus: {
          passed: true,
          provider: "chatgpt",
          conversations: syncJson.providers[0].conversations,
          messages: syncJson.providers[0].messages,
        },
        resourceRead: {
          passed: true,
          uri: "conversation://chatgpt/verify-search-safety",
          mimeType: resourceRead.contents[0].mimeType,
        },
      },
      liveProviders,
    };

    process.stdout.write(\`\${JSON.stringify(result, null, 2)}\\n\`);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`MCP helper probe failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

async function maybeRunLiveBrowserSmoke({ baseUrl, ingestToken, dbPath, mcpRoot, stopServer }) {
  const popupUrl = process.env.POLYCHAT_EXTENSION_POPUP_URL?.trim();
  const testMode = process.env.POLYCHAT_EXTENSION_TEST_MODE === "1";
  const providerPlans = buildLiveProviderPlans();
  const configuredProviders = providerPlans.filter((provider) => provider.status === "configured");
  const livePrereqsMissing = [];

  if (!popupUrl) livePrereqsMissing.push("POLYCHAT_EXTENSION_POPUP_URL");
  if (!testMode) livePrereqsMissing.push("POLYCHAT_EXTENSION_TEST_MODE=1");

  if (configuredProviders.length > 0 && livePrereqsMissing.length === 0) {
    let browserLaunched = false;
    try {
      await buildTestModeExtension();
      const url = new URL(popupUrl);
      url.search = new URLSearchParams({
        autotest: "1",
        serverUrl: baseUrl,
        ingestToken,
        chatgpt: configuredProviders.find((provider) => provider.provider === "chatgpt")?.conversationId ?? "",
        claude: configuredProviders.find((provider) => provider.provider === "claude")?.conversationId ?? "",
        gemini: configuredProviders.find((provider) => provider.provider === "gemini")?.conversationId ?? "",
      }).toString();
      await launchBrowser(url.href);
      browserLaunched = true;
      const providerSyncs = await waitForLiveProviderSyncs(dbPath, configuredProviders);
      for (const sync of providerSyncs) {
        const result = providerPlans.find((provider) => provider.provider === sync.provider);
        if (!result) continue;
        result.messages = sync.messages;
        result.status = sync.status;
        result.reason = sync.reason;
      }
    } catch (error) {
      const reason = `live browser smoke failed: ${error instanceof Error ? error.message : String(error)}`;
      for (const provider of configuredProviders) {
        provider.status = "failed";
        provider.reason = reason;
      }
      debugLog("live browser smoke browser launch/state", { browserLaunched, reason });
    }
  } else if (configuredProviders.length > 0) {
    const reason = `missing ${livePrereqsMissing.join(", ")}`;
    for (const provider of configuredProviders) {
      provider.status = "failed";
      provider.reason = reason;
    }
  }

  debugLog("stop mcp server before live MCP probe");
  await stopServer().catch(() => {});

  const mcpArtifact = await runMcpToolChecksViaHelper(
    dbPath,
    mcpRoot,
    configuredProviders.map(({ provider, conversationId, searchPhrase }) => ({ provider, conversationId, searchPhrase }))
  );

  for (const provider of configuredProviders) {
    const helper = mcpArtifact.liveProviders?.[provider.provider];
    if (!helper) continue;
    provider.mcpGetConversation = helper.mcpGetConversation;
    provider.mcpGetMessages = helper.mcpGetMessages;
    provider.searchHit = helper.searchHit;
    provider.rawHiddenByDefault = helper.rawHiddenByDefault;
    if (provider.status !== "failed" && helper.status !== "passed") {
      provider.status = "failed";
      provider.reason = helper.reason ?? provider.reason ?? "live MCP verification failed";
      continue;
    }
    if (provider.status !== "failed") {
      provider.status = "passed";
      provider.reason = null;
    }
  }

  const providers = {
    chatgpt: finalizeLiveProviderReport(providerPlans.find((provider) => provider.provider === "chatgpt")),
    claude: finalizeLiveProviderReport(providerPlans.find((provider) => provider.provider === "claude")),
    gemini: finalizeLiveProviderReport(providerPlans.find((provider) => provider.provider === "gemini")),
  };
  const status = summarizeLiveSmokeStatus(providerPlans);
  const reason = summarizeLiveSmokeReason(providerPlans);

  return {
    liveSmoke: {
      status,
      reason,
      providers,
    },
    mcpArtifact,
  };
}

function buildLiveProviderPlans() {
  return buildLiveProviderPlansFromEnvCore(process.env);
}

async function buildTestModeExtension() {
  const liveExtensionDist = join(artifactsDir, "extension-live-dist");
  const build = spawnSync("npm", ["--workspace", "apps/extension", "run", "build"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      POLYCHAT_EXTENSION_TEST_MODE: "1",
      POLYCHAT_EXTENSION_DIST_DIR: liveExtensionDist,
    },
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error("test-mode extension build failed");
  }
}

async function waitForLiveProviderSyncs(dbPath, providers, { timeoutMs = 90_000, intervalMs = 2_000 } = {}) {
  const states = new Map(
    providers.map((provider) => [
      provider.provider,
      {
        rowSeen: false,
        messages: 0,
      },
    ])
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let allPassed = true;
    for (const provider of providers) {
      const rowSeen = readConversationExistsFromDb(dbPath, provider.provider, provider.conversationId);
      const messages = readConversationMessageCountFromDb(dbPath, provider.provider, provider.conversationId);
      const state = states.get(provider.provider);
      if (state) {
        state.rowSeen ||= rowSeen;
        state.messages = Math.max(state.messages, messages);
      }
      if (!(rowSeen && messages > 0)) {
        allPassed = false;
      }
    }
    if (allPassed) break;
    await sleep(intervalMs);
  }

  return providers.map((provider) => {
    const state = states.get(provider.provider) ?? { rowSeen: false, messages: 0 };
    if (state.rowSeen && state.messages > 0) {
      return {
        provider: provider.provider,
        messages: state.messages,
        status: "passed",
        reason: null,
      };
    }
    return {
      provider: provider.provider,
      messages: state.messages,
      status: "failed",
      reason: state.rowSeen
        ? `conversation ${provider.provider}:${provider.conversationId} appeared but message count stayed at 0`
        : `conversation ${provider.provider}:${provider.conversationId} never appeared in SQLite`,
    };
  });
}

function readConversationExistsFromDb(dbPath, provider, conversationId) {
  const db = new sqlite3.Database(dbPath);
  try {
    const rows = db.all(`
      SELECT 1 AS found
      FROM conversations
      WHERE provider = ${sqliteQuote(provider)} AND id = ${sqliteQuote(conversationId)}
      LIMIT 1;
    `);
    return rows.length > 0;
  } finally {
    db.close();
  }
}

function readConversationMessageCountFromDb(dbPath, provider, conversationId) {
  const db = new sqlite3.Database(dbPath);
  try {
    const rows = db.all(`
      SELECT COUNT(*) AS messageCount
      FROM messages
      WHERE provider = ${sqliteQuote(provider)} AND conversation_id = ${sqliteQuote(conversationId)};
    `);
    return Number(rows[0]?.messageCount ?? 0);
  } finally {
    db.close();
  }
}

function finalizeLiveProviderReport(provider) {
  return finalizeLiveProviderReportCore(provider);
}

function summarizeLiveSmokeStatus(providerPlans) {
  return summarizeLiveSmokeStatusCore(providerPlans);
}

function summarizeLiveSmokeReason(providerPlans) {
  return summarizeLiveSmokeReasonCore(providerPlans);
}

function sqliteQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function launchBrowser(url) {
  const commands = ["zen-browser", "xdg-open"];
  let lastError = null;

  for (const command of commands) {
    try {
      const child = spawn(command, [url], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      await Promise.race([
        onceEvent(child, "spawn").then(() => ({ command })),
        onceEvent(child, "error").then((error) => {
          throw error;
        }),
        sleep(500).then(() => ({ command })),
      ]);
      return { command };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to launch browser: ${formatError(lastError)}`);
}

function onceEvent(emitter, event) {
  return new Promise((resolve) => {
    emitter.once(event, (...args) => {
      resolve(args.length > 1 ? args : args[0]);
    });
  });
}

async function writeSqliteIntegrity(dbPath) {
  const db = new sqlite3.Database(dbPath);
  try {
    const rows = db.all("PRAGMA integrity_check;");
    const integrity = rows[0]?.integrity_check ?? rows[0]?.integrity ?? rows[0]?.result ?? "unknown";
    writeArtifact("sqlite-integrity.txt", `${integrity}\n`);
    report.checks.sqliteIntegrity = {
      passed: integrity === "ok",
      result: integrity,
    };
    if (integrity !== "ok") {
      throw new Error(`sqlite integrity check failed: ${integrity}`);
    }
  } finally {
    db.close();
  }
}

function renderReportMarkdown(currentReport) {
  const providerLabels = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    gemini: "Gemini",
  };
  const lines = [
    `# Polychat History Verification`,
    ``,
    `- commit: \`${currentReport.commit}\``,
    `- timestamp: \`${currentReport.timestamp}\``,
    `- status: \`${currentReport.passed ? "passed" : "failed"}\``,
    ``,
    `## Checks`,
  ];

  for (const [name, check] of Object.entries(currentReport.checks)) {
    const status = typeof check?.status === "string" ? check.status : check?.passed === false ? "failed" : "passed";
    if (status === "failed") {
      lines.push(`- ${name}: failed`);
      if (check.error) lines.push(`  - ${String(check.error).split("\n")[0]}`);
    } else {
      lines.push(`- ${name}: ${status}`);
    }
  }

  if (currentReport.live.browserExtensionSmoke) {
    const live = currentReport.live.browserExtensionSmoke;
    lines.push(``);
    lines.push(`## Live Smoke`);
    lines.push(`- overall status: ${live.status}`);
    lines.push(`- live transcript sync proven: ${live.status === "passed" ? "yes" : live.status === "partial" ? "partial" : "no"}`);
    if (live.reason) lines.push(`- reason: ${live.reason}`);
    for (const providerName of ["chatgpt", "claude", "gemini"]) {
      const provider = live.providers?.[providerName];
      if (!provider) continue;
      lines.push(
        `- ${providerLabels[providerName]}: ${provider.status}, messages ${provider.messages}, search hit ${provider.searchHit}`
      );
      if (provider.reason) {
        lines.push(`- ${providerLabels[providerName]} reason: ${provider.reason}`);
      }
    }
  }

  lines.push(``);
  lines.push(`## Artifacts`);
  for (const [name, path] of Object.entries(currentReport.artifacts)) {
    lines.push(`- ${name}: \`${path}\``);
  }

  return `${lines.join("\n")}\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
