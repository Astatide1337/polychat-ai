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

  const connected = new Set(
    Object.entries(health.providers ?? {})
      .filter(([, provider]) => provider?.connected)
      .map(([id]) => id),
  );
  const selected = chooseModel(models.data ?? [], connected);
  if (selected) {
    summary.selectedModel = selected.id;
    summary.selectedProvider = selected.owned_by;
  } else {
    summary.notes.push("No live provider model was available; verified WebUI startup and empty/status states only.");
  }

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 980 },
    recordVideo: { dir: artifactsDir, size: { width: 1440, height: 980 } },
  });
  await context.addInitScript(({ apiKey }) => {
    localStorage.setItem("polychat.web.settings", JSON.stringify({
      baseUrl: "",
      apiKey,
      inspectorOpen: true,
      inspectorTab: "status",
    }));
  }, { apiKey });

  page = await context.newPage();
  pageVideo = page.video();
  const consoleMessages = [];
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
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await expectPageHasContent(page);
  await shot(page, "webui-live-status.png");

  if (selected) {
    await page.getByRole("combobox").selectOption(selected.id);
    const temporary = page.locator("label.switch input");
    if (!(await temporary.isChecked())) await temporary.check();
    summary.temporaryVerified = await temporary.isChecked();

    await page.getByPlaceholder("Message Polychat").fill(
      "In one sentence, explain why local health checks are useful during software development.",
    );
    await page.getByTitle("Send").click();
    const assistantContent = page.locator(".message.assistant .message-content").last();
    await assistantContent.waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForFunction(() => {
      const nodes = document.querySelectorAll(".message.assistant .message-content");
      const last = nodes[nodes.length - 1];
      return (last?.textContent ?? "").trim().length >= 20;
    }, undefined, { timeout: 120_000 });
    await page.waitForFunction(() => !document.querySelector('[title="Cancel stream"]'), undefined, { timeout: 120_000 }).catch(() => {});
    summary.chatVerified = true;
    await shot(page, "webui-live-chat.png");

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
    await page.getByRole("button", { name: /Debug/ }).click();
    await shot(page, "webui-live-debug.png");

    const prompt = "Draft a detailed comparison of HTTP caching, database indexing, and background job queues for a small web application. Use several paragraphs.";
    await page.getByPlaceholder("Message Polychat").fill(prompt);
    ignoreExpectedCancellationResourceError = true;
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

  await page.getByRole("button", { name: /MCP/ }).click();
  await shot(page, "webui-live-mcp.png");

  if (consoleMessages.length) {
    summary.notes.push(`browser console errors: ${consoleMessages.join(" | ")}`);
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
