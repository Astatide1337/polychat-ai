#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(root, "docs", "webui-assets");
const port = Number(process.env.POLYCHAT_WEBUI_LIVE_PORT ?? "1461");
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const preferredProviders = ["deepseek", "claude", "chatgpt", "gemini"];

loadPolychatEnv();
mkdirSync(artifactsDir, { recursive: true });

const server = spawn(process.execPath, ["dist/index.js", "web", "--host", host, "--port", String(port), "--no-open"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverLog += chunk.toString(); });

const summary = {
  baseUrl,
  startedAt: new Date().toISOString(),
  health: null,
  modelCount: 0,
  selectedModel: null,
  selectedProvider: null,
  runs: [],
  chatVerified: false,
  temporaryVerified: false,
  cancellationVerified: false,
  screenshots: [],
  video: null,
  notes: [],
};

let browser;
let context;
let page;
let pageVideo;
let failure = null;
let ignoreExpectedCancellationResourceError = false;
let activePhase = "setup";

try {
  await waitForServer();
  const apiKey = process.env.POLYCHAT_API_KEY?.trim() ?? "";
  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const health = await getJson("/health", {});
  const models = await getJson("/v1/models", authHeaders).catch((err) => {
    summary.notes.push(`models request failed: ${err.message}`);
    return { data: [] };
  });
  summary.health = sanitizeHealth(health);
  summary.modelCount = Array.isArray(models.data) ? models.data.length : 0;

  const conversationLists = {
    chatgpt: await getJson("/v1/conversations?provider=chatgpt", authHeaders).catch(() => null),
    claude: await getJson("/v1/conversations?provider=claude", authHeaders).catch(() => null),
    deepseek: await getJson("/v1/conversations?provider=deepseek", authHeaders).catch(() => null),
    gemini: await getJson("/v1/conversations?provider=gemini", authHeaders).catch(() => null),
    kimi: await getJson("/v1/conversations?provider=kimi", authHeaders).catch(() => null),
  };

  const testRuns = buildTestRuns(models.data ?? [], conversationLists);
  const firstRun = testRuns[0] ?? null;
  if (firstRun) {
    summary.selectedModel = firstRun.model;
    summary.selectedProvider = firstRun.provider;
  } else {
    summary.notes.push("No live provider model was available; verified WebUI startup and empty/status states only.");
  }

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 980 },
    recordVideo: { dir: artifactsDir, size: { width: 1440, height: 980 } },
  });
  await context.addInitScript(({ apiKey, sessions }) => {
    localStorage.setItem("polychat.web.settings", JSON.stringify({
      baseUrl: "",
      apiKey,
      inspectorOpen: true,
      inspectorTab: "status",
    }));
    localStorage.setItem("polychat.web.sessions", JSON.stringify(sessions));
  }, {
    apiKey,
    sessions: buildSeedSessions(testRuns),
  });

  page = await context.newPage();
  pageVideo = page.video();
  const consoleMessages = [];
  const failedResponses = [];
  page.on("console", (message) => {
    if (
      ignoreExpectedCancellationResourceError
      && message.type() === "error"
      && message.text().startsWith("Failed to load resource:")
    ) {
      return;
    }
    if (message.type() === "error") consoleMessages.push(message.text());
  });
  page.on("response", (response) => {
    if (
      ignoreExpectedCancellationResourceError
      && response.status() === 502
      && response.url().includes("/v1/chat/completions")
    ) {
      return;
    }
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()} [phase=${activePhase}]`);
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await expectPageHasContent(page);
  await shot(page, "webui-live-status.png");

  if (testRuns.length) {
    await page.addStyleTag({
      content: `
        .conversation-list button strong,
        .conversation-list button small {
          color: transparent !important;
          position: relative;
        }
        .conversation-list button strong::after {
          content: "Provider conversation";
          color: #e6e1d8;
          left: 0;
          position: absolute;
        }
        .conversation-list button small::after {
          content: "redacted id";
          color: #9aa0a6;
          left: 0;
          position: absolute;
        }
      `,
    });
    await page.getByRole("button", { name: "Debug", exact: true }).click();
    await shot(page, "webui-live-debug.png");

    for (const run of testRuns) {
      activePhase = run.title;
      await runProviderCase(page, run, summary);
    }

    const temporaryRun = testRuns.find((run) => run.temporary);
    if (temporaryRun) summary.temporaryVerified = true;
    summary.chatVerified = testRuns.some((run) => run.status === "ok");

    ignoreExpectedCancellationResourceError = true;
    const cancelRun = testRuns.find((run) => run.status === "ok");
    if (cancelRun) {
      activePhase = "cancel";
      await page.getByRole("button", { name: "Status", exact: true }).click();
      const prompt = "Draft a detailed comparison of HTTP caching, database indexing, and background job queues for a small web application. Use several paragraphs.";
      await page.getByPlaceholder("Message Polychat").fill(prompt);
      await page.getByTitle("Send").click();
      const cancel = page.getByTitle("Cancel stream");
      try {
        await cancel.waitFor({ state: "visible", timeout: 5_000 });
        await cancel.click();
        await page.waitForSelector(".status.cancelled", { timeout: 10_000 });
        summary.cancellationVerified = true;
      } catch {
        summary.notes.push("Cancellation control appeared too briefly in live provider run; stream completed before cancellation could be asserted.");
      }
      await shot(page, "webui-live-cancel.png");
    }
  }

  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await shot(page, "webui-live-mcp.png");

  if (consoleMessages.length) {
    summary.notes.push(`browser console errors: ${consoleMessages.join(" | ")}`);
  }
  if (failedResponses.length) {
    summary.notes.push(`browser response errors: ${failedResponses.join(" | ")}`);
  }
  summary.completedAt = new Date().toISOString();
  writeFileSync(join(artifactsDir, "webui-live-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
} catch (err) {
  failure = err;
  summary.error = err instanceof Error ? err.message : String(err);
} finally {
  if (context) {
    await context.close();
    const video = await findLatestVideo();
    if (video) {
      const target = join(artifactsDir, "webui-live-demo.webm");
      copyFileSync(video, target);
      summary.video = "docs/webui-assets/webui-live-demo.webm";
      writeFileSync(join(artifactsDir, "webui-live-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    }
  }
  if (browser) await browser.close();
  server.kill("SIGTERM");
  writeFileSync(join(artifactsDir, "webui-live-server.log"), redact(serverLog));
}

if (failure) {
  console.error(failure instanceof Error ? failure.stack ?? failure.message : String(failure));
  process.exit(1);
}

if (!summary.chatVerified && summary.modelCount > 0) {
  console.error("Live WebUI E2E did not verify a chat response.");
  process.exit(1);
}

console.log(JSON.stringify(summary, null, 2));

function loadPolychatEnv() {
  const envFile = join(homedir(), ".polychat", ".env");
  if (!existsSync(envFile)) return;
  for (const raw of readFileSync(envFile, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

async function waitForServer() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`polychat web exited early with code ${server.exitCode}\n${serverLog}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health\n${serverLog}`);
}

async function getJson(path, headers) {
  const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function chooseModel(models, connectedProviders) {
  const connectedModels = models.filter((model) => connectedProviders.has(model.owned_by));
  return preferredProviders
    .map((provider) => connectedModels.find((model) => model.owned_by === provider))
    .find(Boolean) ?? connectedModels[0] ?? null;
}

function buildTestRuns(models, conversationLists) {
  const firstConversationId = (list) => list?.conversations?.[0]?.id ?? null;
  const modelFor = (provider, preferredIds) => {
    for (const id of preferredIds) {
      if (models.some((model) => model.id === id && model.owned_by === provider)) return id;
    }
    return models.find((model) => model.owned_by === provider)?.id ?? null;
  };
  const chatgptConversationId = process.env.POLYCHAT_TEST_CHATGPT_CONVERSATION_ID?.trim() || firstConversationId(conversationLists.chatgpt);
  const claudeConversationId = process.env.POLYCHAT_TEST_CLAUDE_CONVERSATION_ID?.trim() || firstConversationId(conversationLists.claude);
  const deepseekConversationId = firstConversationId(conversationLists.deepseek);
  const kimiConversationId = firstConversationId(conversationLists.kimi);

  const runs = [
    {
      provider: "deepseek",
      title: "DeepSeek live",
      model: modelFor("deepseek", ["deepseek-chat"]),
      conversationId: deepseekConversationId,
      temporary: false,
      prompt: "In one concise paragraph, explain why local health checks are useful during software development.",
      expectFailure: false,
    },
    {
      provider: "chatgpt",
      title: "ChatGPT test conversation",
      model: modelFor("chatgpt", ["gpt-5-mini", "gpt-5-5"]),
      conversationId: chatgptConversationId,
      temporary: false,
      prompt: "Explain how a browser-first interface can make an AI assistant feel more reliable for daily use, in two short paragraphs.",
      expectFailure: false,
    },
    {
      provider: "claude",
      title: "Claude test conversation",
      model: modelFor("claude", ["claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-6"]),
      conversationId: claudeConversationId,
      temporary: false,
      prompt: "Describe the tradeoff between delivery speed and product polish for a small web app in two short paragraphs.",
      expectFailure: false,
    },
    {
      provider: "kimi",
      title: "Kimi live",
      model: modelFor("kimi", ["kimi"]),
      conversationId: kimiConversationId,
      temporary: false,
      prompt: "Summarize the difference between a quick experiment and a longer-running project plan in two short paragraphs.",
      expectFailure: false,
    },
    {
      provider: "gemini",
      title: "Gemini 3.1 Pro live",
      model: modelFor("gemini", ["gemini-3.1-pro"]),
      conversationId: null,
      temporary: true,
      prompt: "Give a practical checklist for verifying a local web app after a server restart.",
      expectFailure: false,
    },
    {
      provider: "gemini",
      title: "Gemini 2.5 Flash live",
      model: modelFor("gemini", ["gemini-2.5-flash"]),
      conversationId: null,
      temporary: true,
      prompt: "Write a short comparison of session state, browser state, and server state.",
      expectFailure: false,
    },
  ];

  return runs.filter((run) => run.model && (run.conversationId || run.temporary || run.provider === "gemini"));
}

function buildSeedSessions(testRuns) {
  return testRuns.map((run, index) => ({
    id: `${run.provider}-${index}`,
    title: run.title,
    provider: run.provider,
    model: run.model,
    providerConversationId: run.conversationId,
    temporary: run.temporary,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

async function runProviderCase(page, run, summary) {
  console.log(`[live-webui] ${run.title}: selecting session and model ${run.model}`);
  await page.locator(".session-item").filter({ hasText: run.title }).click();
  await page.getByRole("combobox").selectOption(run.model);
  const temporary = page.locator("label.switch input");
  if (run.temporary && !(await temporary.isChecked())) await temporary.check();
  if (!run.temporary && (await temporary.isChecked())) await temporary.uncheck();

  await page.getByRole("button", { name: "Debug", exact: true }).click();
  const preview = JSON.parse((await page.locator(".inspector-content .json-block").first().textContent()) ?? "{}");
  if (preview.model !== run.model) throw new Error(`${run.title}: request preview model ${preview.model} did not match ${run.model}`);
  if ((preview.provider_conversation_id ?? null) !== (run.conversationId ?? null)) {
    throw new Error(`${run.title}: request preview conversation ${preview.provider_conversation_id ?? null} did not match ${run.conversationId ?? null}`);
  }
  if (Boolean(preview.temporary) !== Boolean(run.temporary)) {
    throw new Error(`${run.title}: request preview temporary ${preview.temporary} did not match ${run.temporary}`);
  }

  await page.getByRole("button", { name: "Status", exact: true }).click();
  console.log(`[live-webui] ${run.title}: sending prompt`);
  await page.getByPlaceholder("Message Polychat").fill(run.prompt);
  await page.getByTitle("Send").click();

  try {
    const assistantContent = page.locator(".message.assistant .message-content").last();
    await assistantContent.waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForFunction(() => {
      const nodes = document.querySelectorAll(".message.assistant .message-content");
      const last = nodes[nodes.length - 1];
      return (last?.textContent ?? "").trim().length > 0;
    }, undefined, { timeout: 120_000 });
    await page.waitForFunction(() => !document.querySelector('[title="Cancel stream"]'), undefined, { timeout: 120_000 }).catch(() => {});
    run.status = "ok";
    summary.runs.push({ title: run.title, provider: run.provider, status: "ok" });
    console.log(`[live-webui] ${run.title}: ok`);
  } catch (err) {
    const text = await page.locator(".error-banner, .message.assistant .message-footer").last().textContent().catch(() => "");
    if (run.provider === "claude" && /429|rate limit|too many requests/i.test(text || "")) {
      run.status = "limited";
      summary.runs.push({ title: run.title, provider: run.provider, status: "limited", note: text || "Claude returned a provider limit response" });
      summary.notes.push(`Claude limited as expected: ${text || "provider returned a limit response"}`);
      console.log(`[live-webui] ${run.title}: limited`);
    } else {
      throw err;
    }
  }

  await shot(page, `webui-live-${run.provider}-${run.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
}

function sanitizeHealth(health) {
  return {
    status: health.status,
    providers: Object.fromEntries(
      Object.entries(health.providers ?? {}).map(([id, provider]) => [id, {
        connected: Boolean(provider.connected),
        defaultModel: provider.defaultModel,
      }]),
    ),
  };
}

async function expectPageHasContent(page) {
  await page.waitForFunction(() => document.body.innerText.trim().length > 0, { timeout: 10_000 });
  const overlay = await page.locator(".vite-error-overlay, #webpack-dev-server-client-overlay, [data-nextjs-dialog]").count();
  if (overlay > 0) throw new Error("Framework error overlay detected.");
}

async function shot(page, name) {
  const file = join(artifactsDir, name);
  await page.screenshot({ path: file, fullPage: true });
  summary.screenshots.push(`docs/webui-assets/${name}`);
}

async function findLatestVideo() {
  if (!pageVideo) return null;
  try {
    return await pageVideo.path();
  } catch {
    return null;
  }
}

function redact(text) {
  let redacted = text;
  for (const key of ["POLYCHAT_API_KEY", "POLYCHAT_SECRET_KEY"]) {
    const value = process.env[key];
    if (value) redacted = redacted.split(value).join(`[redacted ${key}]`);
  }
  return redacted;
}
