/**
 * Polychat interactive REPL — Ollama-style sequential flow.
 *
 * Architecture (mirrors Ollama exactly):
 *   picker() → sequential, blocking — returns result
 *   chat loop → sequential readline prompt loop
 *
 * When a picker is needed:
 *   1. Close readline (release stdin)
 *   2. Run Ink picker (owns stdin exclusively)
 *   3. Ink exits, returns result
 *   4. Create new readline, re-enter chat loop
 *
 * This is 100% sequential — no concurrent promises, no signal channels.
 */

import React from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import * as tty from "node:tty";
import { createSSEParser, ToolCallAccumulator } from "../utils/stream.js";
import { countEstimatedTokens } from "../utils/token-estimate.js";
import { TOOL_DEFINITIONS, type ApprovalMode, type ToolCall } from "./tools.js";
import { executeTool } from "./executor.js";
import { shouldApprove } from "./approval.js";

// ── ANSI ──────────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const b = (s: string) => `${BOLD}${s}${RESET}`;
const d = (s: string) => `${DIM}${s}${RESET}`;
const g = (s: string) => `${GREEN}${s}${RESET}`;
const c = (s: string) => `${CYAN}${s}${RESET}`;
const y = (s: string) => `${YELLOW}${s}${RESET}`;
const r = (s: string) => `${RED}${s}${RESET}`;

function termWidth() { return process.stdout instanceof tty.WriteStream ? process.stdout.columns || 80 : 80; }

const PROMPT = `${BOLD}${GREEN}>>> ${RESET}`;
const PROMPT_CONT = `${DIM}... ${RESET}`;

// ── Wrapping writer ───────────────────────────────────────────────────────────

class WrappingWriter {
  private col = 0;
  private readonly width = Math.max(20, termWidth() - 2);
  private inThinking = false;

  write(text: string) {
    if (this.inThinking) {
      // Close thinking block with newline before first real content
      process.stdout.write("\x1b[0m\n");
      this.col = 0;
      this.inThinking = false;
    }
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") { process.stdout.write(ch); this.col = 0; }
      else { if (this.col >= this.width) { process.stdout.write("\n"); this.col = 0; } process.stdout.write(ch); this.col++; }
    }
  }

  writeThinking(text: string) {
    if (!this.inThinking) {
      // Open thinking block — dim italic prefix
      process.stdout.write("\x1b[2m\x1b[3m");
      this.inThinking = true;
      this.col = 0;
    }
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") { process.stdout.write(ch); this.col = 0; }
      else { if (this.col >= this.width) { process.stdout.write("\n"); this.col = 0; } process.stdout.write(ch); this.col++; }
    }
  }

  newline() {
    if (this.inThinking) { process.stdout.write("\x1b[0m"); this.inThinking = false; }
    if (this.col > 0) { process.stdout.write("\n"); this.col = 0; }
  }
}

// ── History ───────────────────────────────────────────────────────────────────

const HIST = path.join(os.homedir(), ".polychat", "history");
function loadHistory() {
  try { return fs.readFileSync(HIST, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).slice(-200); }
  catch { return []; }
}
function appendHistory(line: string) {
  try { fs.mkdirSync(path.dirname(HIST), { recursive: true }); fs.appendFileSync(HIST, line.trim() + "\n"); }
  catch { /* history file is best-effort */ }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };
type ModelInfo = { id: string; name: string; owned_by: string };
type ConvInfo = { id: string; title: string };

function providerLabel(o: string) {
  if (o === "chatgpt") return "ChatGPT";
  if (o === "claude") return "Claude";
  if (o === "deepseek") return "DeepSeek";
  return o;
}
function modelLabel(m: ModelInfo) { return `${providerLabel(m.owned_by)} · ${m.name}`; }
function findModel(q: string, models: ModelInfo[]) {
  const lq = q.trim().toLowerCase();
  return models.find((m) => m.id.toLowerCase() === lq || m.name.toLowerCase() === lq || modelLabel(m).toLowerCase() === lq) ?? null;
}

// ── Ink Picker ────────────────────────────────────────────────────────────────

export interface PickerItem { id: string; label: string; description?: string; }

const MAX_VIS = 10;

function PickerUI({ title, items, onDone }: { title: string; items: PickerItem[]; onDone: (id: string | null) => void }) {
  const { exit } = useApp();
  const [cursor, setCursor] = React.useState(0);
  const [filter, setFilter] = React.useState("");
  const [scroll, setScroll] = React.useState(0);

  const filtered = filter
    ? items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase()) || (i.description ?? "").toLowerCase().includes(filter.toLowerCase()))
    : items;
  const max = Math.max(0, filtered.length - 1);
  const cur = Math.min(cursor, max);

  // keep cursor in view
  React.useEffect(() => {
    setScroll((s) => cur < s ? cur : cur >= s + MAX_VIS ? cur - MAX_VIS + 1 : s);
  }, [cur]);

  const done = (id: string | null) => { onDone(id); exit(); };

  useInput((inp, key) => {
    if (key.escape || (key.ctrl && inp === "c")) { done(null); return; }
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(max, c + 1)); return; }
    if (key.return) { done(filtered[cur]?.id ?? null); return; }
    if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); setCursor(0); setScroll(0); return; }
    if (!key.ctrl && !key.meta && inp?.length === 1) { setFilter((f) => f + inp); setCursor(0); setScroll(0); }
  });

  const visible = filtered.slice(scroll, scroll + MAX_VIS);
  const above = scroll;
  const below = Math.max(0, filtered.length - scroll - MAX_VIS);

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Box>
        <Text bold>{title}  </Text>
        {filter ? <Text color="white">{filter}</Text> : <Text color="gray" italic>Type to filter...</Text>}
      </Box>
      <Text> </Text>
      {filtered.length === 0 && <Text color="gray">  (no matches)</Text>}
      {above > 0 && <Text color="gray">  ↑ {above} more above</Text>}
      {visible.map((item) => {
        const gi = scroll + visible.indexOf(item);
        const sel = gi === cur;
        return (
          <Box key={item.id} flexDirection="column">
            <Text>{sel ? <Text color="green" bold>{"▸ "}</Text> : "  "}<Text bold={sel}>{item.label}</Text></Text>
            {item.description ? <Text color="gray">{"    " + item.description}</Text> : null}
          </Box>
        );
      })}
      {below > 0 && <Text color="gray">  ↓ {below} more below</Text>}
      <Text> </Text>
      <Text color="gray">↑/↓ navigate  •  enter select  •  esc cancel</Text>
    </Box>
  );
}

/**
 * Show the Ink picker. Caller MUST ensure readline is already closed before
 * calling this, so Ink has exclusive stdin access.
 */
/** Flush any bytes sitting in stdin's read buffer (e.g. a buffered \r). */
async function drainStdin(): Promise<void> {
  return new Promise<void>((resolve) => {
    const drain = () => {};
    process.stdin.resume();
    process.stdin.on("data", drain);
    setImmediate(() => {
      process.stdin.removeListener("data", drain);
      process.stdin.pause();
      resolve();
    });
  });
}

async function runPicker(title: string, items: PickerItem[]): Promise<string | null> {
  if (items.length === 0) return null;
  // Flush any buffered Enter keypress before Ink reads stdin
  await drainStdin();

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const onDone = (id: string | null) => {
      if (settled) return;
      settled = true;
      instance.unmount();
      resolve(id);
    };
    const instance = render(<PickerUI title={title} items={items} onDone={onDone} />, { exitOnCtrlC: false });
  });
}

// ── Readline factory ──────────────────────────────────────────────────────────

function makeRl(history: string[]) {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
    history: history.slice().reverse(),
    prompt: PROMPT,
  });
}

// ── Main REPL ─────────────────────────────────────────────────────────────────

export async function startRepl(initialModel: string): Promise<void> {
  const serverUrl = process.env.POLYCHAT_SERVER_URL ?? "http://127.0.0.1:1443";

  // ── Shared mutable state (survives picker round-trips) ────────────────────────
  const messages: ChatMessage[] = [];
  let currentModel = initialModel;
  let currentProvider = "unknown";
  let activeConversationId: string | null = null;
  let activeConversationTitle: string | null = null;
  let models: ModelInfo[] = [];
  let streaming = false;
  let streamAbort: AbortController | null = null;
  let approvalMode: ApprovalMode = "cautious";
  let maxToolRounds = 20;
  let toolLoopAborted = false;
  const history = loadHistory();  // loaded once, kept in memory

  // ── Connect ──────────────────────────────────────────────────────────────────
  process.stdout.write(b("Polychat") + " — connecting...\r");
  try {
    const [healthRes, modelsRes] = await Promise.all([fetch(`${serverUrl}/health`), fetch(`${serverUrl}/v1/models`)]);
    if (!healthRes.ok) throw new Error("server unavailable");
    if (modelsRes.ok) {
      const payload = await modelsRes.json() as { data?: Array<{ id: string; name?: string; owned_by?: string }> };
      models = payload.data?.map((m) => ({ id: m.id, name: m.name ?? m.id, owned_by: m.owned_by ?? "unknown" })) ?? [];
      if (models.length && !models.some((m) => m.id === currentModel)) currentModel = models[0].id;
    }
    currentProvider = models.find((m) => m.id === currentModel)?.owned_by ?? "unknown";
  } catch {
    process.stdout.write("\r\x1b[K" + r("✗ Cannot connect to Polychat server.") + " Run " + b("polychat serve") + " first.\n\n");
    process.exit(1);
  }

  // ── Banner ────────────────────────────────────────────────────────────────────
  process.stdout.write("\r\x1b[K");
  const rule = d("─".repeat(Math.min(termWidth(), 60)));
  const currentModelInfo = models.find((m) => m.id === currentModel);
  const modelDisplay = currentModelInfo ? c(modelLabel(currentModelInfo)) : c(currentModel);
  process.stdout.write(rule + "\n" + b("Polychat") + " — " + modelDisplay + "\n" + rule + "\n");
  process.stdout.write(d('Type /? for help. Use """ for multi-line input. Ctrl+D to exit.') + "\n\n");

  // ── Sequential chat loop — recreated after each picker ────────────────────────
  // Ollama pattern: picker returns → readline starts fresh. No concurrency.
  while (true) {

    const result = await chatLoop(serverUrl, {
      messages, models, history,
      get currentModel() { return currentModel; },
      set currentModel(v) { currentModel = v; },
      get currentProvider() { return currentProvider; },
      set currentProvider(v) { currentProvider = v; },
      get activeConversationId() { return activeConversationId; },
      set activeConversationId(v) { activeConversationId = v; },
      get activeConversationTitle() { return activeConversationTitle; },
      set activeConversationTitle(v) { activeConversationTitle = v; },
      get streaming() { return streaming; },
      set streaming(v) { streaming = v; },
      get streamAbort() { return streamAbort; },
      set streamAbort(v) { streamAbort = v; },
      get approvalMode() { return approvalMode; },
      set approvalMode(v) { approvalMode = v; },
      get maxToolRounds() { return maxToolRounds; },
      set maxToolRounds(v) { maxToolRounds = v; },
      get toolLoopAborted() { return toolLoopAborted; },
      set toolLoopAborted(v) { toolLoopAborted = v; },
    });


    if (result.kind === "exit") { process.stdout.write("\n"); process.exit(0); }

    // PICKER: readline is already closed. Run Ink picker with exclusive stdin.
    const selected = await runPicker(result.title, result.items);
    // Drain the Enter keypress that closed the picker so it doesn't leak
    // into the next readline session.
    await drainStdin();
    // Ink calls stdin.unref() on unmount — re-ref so the process stays alive.
    process.stdin.ref();
    result.onResult(selected);
  }
}

// ── Chat loop ─────────────────────────────────────────────────────────────────

type ChatLoopResult =
  | { kind: "exit" }
  | { kind: "picker"; title: string; items: PickerItem[]; onResult: (id: string | null) => void };

interface LoopState {
  messages: ChatMessage[];
  models: ModelInfo[];
  history: string[];
  currentModel: string;
  currentProvider: string;
  activeConversationId: string | null;
  activeConversationTitle: string | null;
  streaming: boolean;
  streamAbort: AbortController | null;
  approvalMode: ApprovalMode;
  maxToolRounds: number;
  toolLoopAborted: boolean;
}

async function chatLoop(serverUrl: string, state: LoopState): Promise<ChatLoopResult> {
  const rl = makeRl(state.history);

  // Ctrl+C: interrupt stream or tool loop or print hint
  rl.on("SIGINT", () => {
    if (state.streaming && state.streamAbort) {
      state.streamAbort.abort();
      state.toolLoopAborted = true;
      process.stdout.write("\n" + y("(interrupted)") + "\n\n");
      rl.prompt();
      return;
    }
    if (state.toolLoopAborted === false) {
      state.toolLoopAborted = true;
      process.stdout.write("\n" + y("(agentic loop interrupted)") + "\n\n");
      rl.prompt();
      return;
    }
    process.stdout.write("\n" + d("Use /bye or Ctrl+D to exit.") + "\n\n");
    rl.prompt();
  });

  // This promise resolves when we want to leave the loop (picker or exit)
  let resolveLoop!: (result: ChatLoopResult) => void;
  const loopDone = new Promise<ChatLoopResult>((res) => { resolveLoop = res; });
  let leaving = false;

  // Close handler: only fires on Ctrl+D / rl.close() with no picker pending
  rl.on("close", () => {
    if (!leaving) resolveLoop({ kind: "exit" });
  });

  function requestPicker(title: string, items: PickerItem[], onResult: (id: string | null) => void) {
    leaving = true;
    // Close readline — releases stdin for Ink
    rl.close();
    resolveLoop({ kind: "picker", title, items, onResult });
  }

  // ── Slash helpers ─────────────────────────────────────────────────────────────

  function printHelp() {
    process.stdout.write(`\n${d("Commands:")}\n`);
    const cmds: [string, string][] = [
      ["/help, /?", "show this help"],
      ["/model [id]", "switch model (picker if no id given)"],
      ["/models", "pick a model"],
      ["/conversations", "pick a provider conversation"],
      ["/new", "start a new conversation"],
      ["/clear", "clear conversation context"],
      ["/bye, /quit", "exit"],
    ];
    for (const [cmd, desc] of cmds) process.stdout.write(`  ${g(cmd.padEnd(22))} ${d(desc)}\n`);
    process.stdout.write(`\n${d("Keyboard shortcuts:")}\n`);
    const shortcuts: [string, string][] = [
      ["Ctrl+C", "interrupt stream / tool loop / clear input"],
      ["Ctrl+D", "exit"],
      ["Ctrl+L", "clear screen"],
      ["Up/Down", "history navigation"],
      ["Ctrl+W/U/K", "delete word / to start / to end"],
      ['"""', "multi-line input mode"],
    ];
    for (const [key, desc] of shortcuts) process.stdout.write(`  ${c(key.padEnd(22))} ${d(desc)}\n`);
    process.stdout.write("\n");
  }

  async function refreshModels() {
    const res = await fetch(`${serverUrl}/v1/models`);
    if (!res.ok) throw new Error(`models request failed: ${res.status}`);
    const payload = await res.json() as { data?: Array<{ id: string; name?: string; owned_by?: string }> };
    const fresh = payload.data?.map((m) => ({ id: m.id, name: m.name ?? m.id, owned_by: m.owned_by ?? "unknown" })) ?? [];
    state.models.splice(0, state.models.length, ...fresh);
    if (state.models.length && !state.models.some((m) => m.id === state.currentModel)) {
      state.currentModel = state.models[0].id;
    }
    state.currentProvider = state.models.find((m) => m.id === state.currentModel)?.owned_by ?? "unknown";
  }

  async function pickModel() {
    process.stdout.write(d("Refreshing models...") + "\r");
    try {
      await refreshModels();
      process.stdout.write("\r\x1b[K");
    } catch {
      process.stdout.write("\r\x1b[K" + r("Failed to refresh models.") + "\n\n");
      return;
    }
    const items = state.models.map((m) => ({ id: m.id, label: m.id, description: `${m.name}  (${providerLabel(m.owned_by)})` }));
    if (items.length === 0) { process.stdout.write(d("No connected provider models found.") + "\n\n"); return; }
    requestPicker("Select model", items, (selected) => {
      if (!selected) return;
      const found = state.models.find((m) => m.id === selected);
      if (found) { state.currentModel = found.id; state.currentProvider = found.owned_by; }
    });
  }

  async function pickConversation() {
    process.stdout.write(d("Loading conversations...") + "\r");
    try {
      const res = await fetch(`${serverUrl}/v1/conversations?provider=${encodeURIComponent(state.currentProvider)}`);
      const payload = await res.json() as { supported?: boolean; conversations?: ConvInfo[]; reason?: string };
      process.stdout.write("\r\x1b[K");
      if (!payload.supported) { process.stdout.write(y(`Conversation browsing not supported for ${providerLabel(state.currentProvider)}.`) + "\n\n"); return; }
      const convos = payload.conversations ?? [];
      if (convos.length === 0) { process.stdout.write(d("No conversations found.") + "\n\n"); return; }
      const items = convos.map((cv) => ({ id: cv.id, label: cv.title || "Untitled", description: cv.id.slice(0, 12) + "..." }));
      requestPicker(`Conversations (${providerLabel(state.currentProvider)})`, items, (selected) => {
        if (!selected) return;
        const conv = convos.find((cv) => cv.id === selected);
        if (conv) { state.activeConversationId = conv.id; state.activeConversationTitle = conv.title; }
      });
    } catch { process.stdout.write("\r\x1b[K" + r("Failed to load conversations.") + "\n\n"); }
  }

  async function newConversation() {
    process.stdout.write(d("Creating new conversation...") + "\r");
    try {
      const res = await fetch(`${serverUrl}/v1/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: state.currentProvider, model: state.currentModel }) });
      const payload = await res.json() as { supported?: boolean; conversation?: ConvInfo };
      process.stdout.write("\r\x1b[K");
      if (payload.supported && payload.conversation) {
        state.activeConversationId = payload.conversation.id;
        state.activeConversationTitle = payload.conversation.title;
        process.stdout.write(d("New conversation: ") + c(payload.conversation.title) + "\n\n");
      } else {
        process.stdout.write(d("Starting stateless session.") + "\n\n");
      }
      state.messages.length = 0;
    } catch { process.stdout.write("\r\x1b[K" + d("Starting stateless session.") + "\n\n"); state.activeConversationId = null; state.activeConversationTitle = null; state.messages.length = 0; }
  }

  async function handleSlash(line: string) {
    const parts = line.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();
    const arg = parts.slice(1).join(" ").trim();
    switch (cmd) {
      case "": case "?": case "help": printHelp(); break;
      case "model": case "models":
        if (arg) {
          const found = findModel(arg, state.models);
          if (!found) process.stdout.write(y(`Unknown model: ${arg}`) + "\n" + d("Run /models to see available models.") + "\n\n");
          else { state.currentModel = found.id; state.currentProvider = found.owned_by; process.stdout.write(d("Switched to ") + c(modelLabel(found)) + "\n\n"); }
        } else {
          await pickModel();
        }
        break;
      case "conversations": await pickConversation(); break;
      case "new": await newConversation(); break;
      case "clear": state.messages.length = 0; state.activeConversationId = null; state.activeConversationTitle = null; process.stdout.write(d("Conversation context cleared.") + "\n\n"); break;
case "mode": { const modes: ApprovalMode[] = ["auto", "cautious", "ask"]; if (arg && modes.includes(arg as ApprovalMode)) { state.approvalMode = arg as ApprovalMode; process.stdout.write(d("Approval mode: ") + c(state.approvalMode) + "\n"); if (state.approvalMode === "auto") { process.stdout.write(y("\u26a0 All tool calls will execute without confirmation.") + "\n"); } process.stdout.write("\n"); } else { process.stdout.write(d("Current mode: ") + c(state.approvalMode) + "\n"); process.stdout.write(d("Usage: /mode auto | cautious | ask") + "\n\n"); } break; }
case "tools": process.stdout.write(d("Available tools:") + "\n"); for (const tool of TOOL_DEFINITIONS) { process.stdout.write("  " + g(tool.function.name.padEnd(8)) + " " + d(tool.function.description.split(".")[0]) + "\n"); } process.stdout.write("\n"); break;
case "maxrounds": { const n = parseInt(arg, 10); if (arg && !isNaN(n) && n > 0) { state.maxToolRounds = n; process.stdout.write(d("Max tool rounds: ") + c(String(state.maxToolRounds)) + "\n\n"); } else { process.stdout.write(d("Current max: ") + c(String(state.maxToolRounds)) + "\n"); process.stdout.write(d("Usage: /maxrounds <number>") + "\n\n"); } break; }
      case "bye": case "quit": case "exit": process.stdout.write("\n"); process.exit(0); break;
      default: process.stdout.write(y(`Unknown command: /${cmd}`) + "  " + d("Type /? for help.") + "\n\n");
    }
  }

  // ── Streaming ─────────────────────────────────────────────────────────────────

  async function sendMessage(content: string) {
    state.messages.push({ role: "user", content });
    appendHistory(content);
    state.history.push(content);
    process.stdout.write("\n");
    state.toolLoopAborted = false;

    for (let round = 0; round < state.maxToolRounds; round++) {
      if (state.toolLoopAborted) {
        state.toolLoopAborted = false;
        process.stdout.write(y("(agentic loop interrupted)") + "\n\n");
        break;
      }

      const abort = new AbortController();
      state.streamAbort = abort;
      state.streaming = true;
      const writer = new WrappingWriter();
      const t0 = Date.now();
      let thinking = "";
      let full = "";
      let toolCallAcc = new ToolCallAccumulator();
      let hadToolCalls = false;

      try {
        const res = await fetch(`${serverUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: state.currentModel,
            messages: state.messages,
            stream: true,
            tools: TOOL_DEFINITIONS,
            providerConversationId: state.activeConversationId,
          }),
          signal: abort.signal,
        });

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
          process.stdout.write(r(`\u2717 ${err.error?.message ?? `Server error: ${res.status}`}`) + "\n\n");
          state.messages.pop();
          return;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const parse = createSSEParser();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parse(dec.decode(value, { stream: true }))) {
            if (event.data === "[DONE]" || !event.data || typeof event.data !== "object") continue;
            const delta = (event.data as any).choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.tool_calls) { hadToolCalls = true; toolCallAcc.feed(delta); }
            if (delta.thinking) { writer.writeThinking(delta.thinking); thinking += delta.thinking; }
            if (delta.content) { writer.write(delta.content); full += delta.content; }
          }
        }

        writer.newline();

        if (hadToolCalls) {
          const toolCalls = toolCallAcc.finish();
          if (toolCalls.length > 0) {
            state.messages.push({ role: "assistant", content: full || "", tool_calls: toolCalls });
            for (const tc of toolCalls) {
              const name = tc.function.name;
              let args: Record<string, string>;
              try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
              const argsPreview = tc.function.arguments.length > 120
                ? tc.function.arguments.slice(0, 120) + "..." : tc.function.arguments;
              process.stdout.write(y(`\u27e1 ${name}`) + d(` ${argsPreview}`) + "\n");
              if (!shouldApprove(name, { mode: state.approvalMode })) {
                const approved = await askApproval(name, args);
                if (!approved) {
                  process.stdout.write(d("  \u2717 Denied.") + "\n\n");
                  state.messages.push({ role: "tool", tool_call_id: tc.id, name, content: "Tool call denied by user." });
                  continue;
                }
              }
              process.stdout.write(d("  \u22ee Executing...\r"));
              const result = await executeTool(name, args);
              const resultPreview = result.content.length > 500
                ? result.content.slice(0, 500) + d(`\n  ... (${result.content.length} chars total)`) : result.content;
              const resultColor = result.is_error ? r : d;
              process.stdout.write("\r\x1b[K");
              for (const line of resultPreview.split("\n")) { process.stdout.write(resultColor(`  ${line}`) + "\n"); }
              process.stdout.write("\n");
              state.messages.push({ role: "tool", tool_call_id: tc.id, name, content: result.is_error ? `Error: ${result.content}` : result.content });
            }
            continue;
          }
        }

        const elapsed = (Date.now() - t0) / 1000;
        const responseTokens = countEstimatedTokens(full);
        const thinkingTokens = countEstimatedTokens(thinking);
        const totalTokens = responseTokens + thinkingTokens;
        const tokensPerSec = elapsed > 0 ? (totalTokens / elapsed).toFixed(1) : "0";
        const thinkingNote = thinkingTokens > 0 ? ` \u00b7 ${thinkingTokens} thinking tok` : "";
        if (round > 0) {
          process.stdout.write(d(`\u25cf ${elapsed.toFixed(1)}s \u00b7 round ${round + 1}/${state.maxToolRounds}`) + "\n\n");
        } else {
          process.stdout.write(d(`\n\u25cf ${elapsed.toFixed(1)}s \u00b7 ${responseTokens} response tok${thinkingNote} \u00b7 ${tokensPerSec} tok/s`) + "\n\n");
        }
        if (full) state.messages.push({ role: "assistant", content: full });
        break;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          writer.newline(); process.stdout.write("\n" + y("(interrupted)") + "\n\n");
        } else {
          writer.newline(); process.stdout.write(r(`\u2717 ${err instanceof Error ? err.message : String(err)}`) + "\n\n");
          if (round === 0) state.messages.pop();
        }
        break;
      } finally {
        state.streaming = false;
        state.streamAbort = null;
      }
    }
  }

  function askApproval(toolName: string, args: Record<string, string>): Promise<boolean> {
    return new Promise((resolve) => {
      const prompt = `  ${y("Allow")} ${toolName}? ${d(JSON.stringify(args).slice(0, 100))} [y/N] `;
      rl.question(prompt, (answer) => { resolve(answer.trim().toLowerCase() === "y"); });
    });
  }

// ── Multi-line ────────────────────────────────────────────────────────────────

  async function readMultiline(first: string): Promise<string> {
    const lines: string[] = []; if (first.trim()) lines.push(first.trim());
    while (true) {
      const line = await new Promise<string | null>((res) => rl.question(PROMPT_CONT, res));
      if (line === null) break;
      if (line.trimEnd().endsWith('"""')) { const before = line.slice(0, line.lastIndexOf('"""')).trimEnd(); if (before) lines.push(before); break; }
      lines.push(line);
    }
    return lines.join("\n");
  }

  // ── Line loop ─────────────────────────────────────────────────────────────────

  rl.prompt();

  (async () => {
    for await (const rawLine of rl) {
      if (leaving) break;
      const trimmed = String(rawLine).trim();
      if (!trimmed) { rl.prompt(); continue; }

      if (trimmed.startsWith("/")) {
        await handleSlash(trimmed);
        if (leaving) break;
        rl.prompt();
        continue;
      }

      if (trimmed.startsWith('"""')) {
        const after = trimmed.slice(3).trim();
        const content = (after.endsWith('"""') && after.length > 3) ? after.slice(0, -3).trim() : await readMultiline(after);
        if (content.trim()) { rl.pause(); await sendMessage(content.trim()); rl.resume(); }
        rl.prompt();
        continue;
      }

      rl.pause();
      await sendMessage(trimmed);
      rl.resume();
      rl.prompt();
    }
  })();

  return loopDone;
}
