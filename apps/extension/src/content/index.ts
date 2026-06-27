import { detectProvider } from "../providers/registry.js";

type SnapshotResponse = {
  provider: "chatgpt" | "claude" | "gemini" | null;
  url: string;
  title: string;
  conversationId: string | null;
  messages: Array<{
    role: "user" | "assistant" | "system" | "tool" | "unknown";
    content: string;
    raw?: unknown;
  }>;
  raw: unknown;
};

type MessageRole = SnapshotResponse["messages"][number]["role"];

function detectConversationId(url: string): string | null {
  const chatMatch = /\/c\/([A-Za-z0-9-]+)/.exec(url);
  if (chatMatch) return chatMatch[1];
  const claudeMatch = /\/chat\/([A-Za-z0-9-]+)/.exec(url);
  if (claudeMatch) return claudeMatch[1];
  const geminiMatch = /\/app\/([A-Za-z0-9-_]+)/.exec(url);
  if (geminiMatch && geminiMatch[1] && geminiMatch[1] !== "app") return decodeURIComponent(geminiMatch[1]);
  const genericMatch = /[?&]conversation_id=([^&]+)/.exec(url);
  if (genericMatch) return decodeURIComponent(genericMatch[1]);
  return null;
}

function getNodeChildren(node: Node): Node[] {
  if (node instanceof Document) {
    return node.body ? Array.from(node.body.childNodes) : [];
  }
  if (node instanceof ShadowRoot) {
    return Array.from(node.childNodes);
  }
  if (node instanceof HTMLIFrameElement) {
    try {
      return node.contentDocument?.body ? Array.from(node.contentDocument.body.childNodes) : [];
    } catch {
      return [];
    }
  }
  if (node instanceof Element) {
    const children = Array.from(node.childNodes);
    const shadowChildren = node.shadowRoot ? Array.from(node.shadowRoot.childNodes) : [];
    return [...children, ...shadowChildren];
  }
  return [];
}

function collectTextFromNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (!(node instanceof Element)) return "";
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript") return "";
  if (tag === "img") {
    return (
      element.getAttribute("alt")?.trim() ||
      element.getAttribute("aria-label")?.trim() ||
      element.getAttribute("title")?.trim() ||
      "[Image]"
    );
  }
  if (element.getAttribute("role") === "img") {
    return element.getAttribute("aria-label")?.trim() || "[Image]";
  }
  const label = element.getAttribute("aria-label")?.trim();
  const pieces: string[] = [];
  for (const child of getNodeChildren(element)) {
    const value = collectTextFromNode(child);
    if (value.trim()) pieces.push(value.trim());
  }
  if (pieces.length > 0) return pieces.join("\n").trim();
  return label ?? element.textContent?.trim() ?? "";
}

function collectTreeText(node: Node): string {
  const pieces: string[] = [];
  for (const child of getNodeChildren(node)) {
    const value = collectTextFromNode(child);
    if (value.trim()) pieces.push(value.trim());
  }
  return pieces.join("\n").trim();
}

function walkTree(node: Node, visit: (element: Element) => void): void {
  for (const child of getNodeChildren(node)) {
    if (child instanceof Element) {
      visit(child);
      walkTree(child, visit);
    }
  }
}

function normalizeGeminiText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function looksLikeGeminiConversationText(text: string): boolean {
  const normalized = normalizeGeminiText(text);
  if (normalized.length < 20) return false;
  if (/^https?:\/\//i.test(normalized)) return false;
  if (/Conversation with Gemini/i.test(normalized) && /What can I help with/i.test(normalized)) return false;
  if (/(?:^|\s)(?:plus|mic|arrow_upward)(?:\s|$)/i.test(normalized) && /Google Account/i.test(normalized)) {
    return false;
  }
  if (
    /Prompt:|Core Task:|Content Directives:|Example Thought Process|Draft Response Start:|Welcome -|^The "/i.test(
      normalized
    )
  ) {
    return false;
  }
  if (
    /^(Plus|Ultra|Custom|Expanded|Spark|Omni|all|default|learning|pet|NONE|word|Try it|Gemini 3 Pro|Gemini 3|Nano Banana 2|3 Pro)$/i.test(
      normalized
    )
  ) {
    return false;
  }
  const wordCount = normalized.split(/\s+/).length;
  if (wordCount < 4 && normalized.length < 40) return false;
  if (!/[.!?]/.test(normalized) && wordCount < 6 && normalized.length < 60) return false;
  return true;
}

function summarizeGeminiValue(value: unknown, seen: Set<unknown> = new Set()): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "";
    seen.add(value);
    return value
      .map((entry) => summarizeGeminiValue(entry, seen))
      .filter((entry) => entry.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "";
    seen.add(value);
    const record = value as Record<string, unknown>;
    const textCandidates = [
      record.text,
      record.content,
      record.caption,
      record.description,
      record.alt,
      record.title,
      record.name,
      record.filename,
      record.file_name,
      record.label,
    ];
    for (const candidate of textCandidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    const kind =
      typeof record.type === "string"
        ? record.type.toLowerCase()
        : typeof record.kind === "string"
          ? record.kind.toLowerCase()
          : typeof record.mimeType === "string"
            ? record.mimeType.toLowerCase()
            : typeof record.mime_type === "string"
              ? record.mime_type.toLowerCase()
              : "";
    const url = typeof record.url === "string" ? record.url.toLowerCase() : "";
    const src = typeof record.src === "string" ? record.src.toLowerCase() : "";
    const mediaHint = `${kind} ${url} ${src}`;
    if (
      mediaHint.includes("image") ||
      mediaHint.includes("photo") ||
      mediaHint.includes("picture") ||
      mediaHint.includes("screenshot") ||
      mediaHint.includes("thumbnail") ||
      mediaHint.startsWith("data:image/")
    ) {
      return "[Image]";
    }
    if (
      mediaHint.includes("artifact") ||
      mediaHint.includes("canvas") ||
      mediaHint.includes("board") ||
      mediaHint.includes("workspace") ||
      mediaHint.includes("chart") ||
      mediaHint.includes("diagram")
    ) {
      return "[Artifact]";
    }
    if (
      mediaHint.includes("file") ||
      mediaHint.includes("document") ||
      mediaHint.includes("attachment") ||
      mediaHint.includes("pdf") ||
      mediaHint.includes("csv") ||
      mediaHint.includes("sheet") ||
      mediaHint.includes("spreadsheet")
    ) {
      return "[File]";
    }
    for (const key of ["parts", "items", "content", "message", "text", "body", "bodyText", "value", "children"]) {
      const nested = record[key];
      if (nested === undefined || nested === null) continue;
      const nestedText = summarizeGeminiValue(nested, seen);
      if (nestedText.trim()) return nestedText;
    }
  }
  return "";
}

function parseGeminiWizData(raw: string): unknown | null {
  if (!raw.startsWith("%.@.")) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 4; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = raw.slice(4, index + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          try {
            return Function(`"use strict"; return (${candidate});`)();
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function findGeminiRows(value: unknown): unknown[][] | null {
  const seen = new WeakSet<object>();
  let best: unknown[][] | null = null;

  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      const looksLikeRows =
        current.length >= 8 &&
        current.every((item) => Array.isArray(item) && item.length >= 7 && typeof item[0] !== "undefined");
      if (looksLikeRows && (!best || current.length > best.length)) {
        best = current as unknown[][];
      }
      for (const item of current) visit(item);
      return;
    }

    for (const item of Object.values(current)) visit(item);
  };

  visit(value);
  return best;
}

function getGeminiRows(value: unknown): unknown[][] | null {
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const directRows = (first as Record<string, unknown>)[1];
      if (
        Array.isArray(directRows) &&
        directRows.length >= 8 &&
        directRows.every((item) => Array.isArray(item) && item.length >= 7)
      ) {
        return directRows as unknown[][];
      }
    }
  }
  return findGeminiRows(value);
}

function extractGeminiWizMessages(): { messages: SnapshotResponse["messages"]; rows: unknown[][] } {
  const raw = (window as typeof window & {
    WIZ_global_data?: { TSDtV?: string };
  }).WIZ_global_data?.TSDtV;
  if (typeof raw !== "string" || !raw.startsWith("%.@.")) return { messages: [], rows: [] };

  const parsed = parseGeminiWizData(raw);
  if (!parsed) return { messages: [], rows: [] };

  const rows = getGeminiRows(parsed);
  if (!rows) return { messages: [], rows: [] };

  const candidates = rows
    .map((row, index) => {
      const text = summarizeGeminiValue(row[4]) || summarizeGeminiValue(row);
      if (!text.trim()) return null;
      const normalized = normalizeGeminiText(text);
      if (!looksLikeGeminiConversationText(normalized)) return null;
      return { index, text: normalized, row };
    })
    .filter((item): item is { index: number; text: string; row: unknown[] } => Boolean(item));

  if (candidates.length < 2) return { messages: [], rows: [] };

  const clusters: Array<Array<{ index: number; text: string; row: unknown[] }>> = [];
  let current: Array<{ index: number; text: string; row: unknown[] }> = [candidates[0]];
  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const previous = current[current.length - 1];
    if (candidate.index - previous.index <= 6) {
      current.push(candidate);
      continue;
    }
    if (current.length >= 2) clusters.push(current);
    current = [candidate];
  }
  if (current.length >= 2) clusters.push(current);

  if (clusters.length === 0) return { messages: [], rows: [] };
  const bestCluster = clusters
    .map((cluster) => ({
      cluster,
      score: cluster.reduce((total, entry) => total + entry.text.length, 0) - cluster[cluster.length - 1].index + cluster[0].index,
    }))
    .sort((left, right) => right.score - left.score)[0]?.cluster;

  if (!bestCluster) return { messages: [], rows: [] };

  return {
    messages: bestCluster.map((entry, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: entry.text,
      raw: { row: entry.row, index: entry.index, source: "gemini-wiz" },
    })),
    rows: bestCluster.map((entry) => entry.row),
  };
}

function extractMessages(): SnapshotResponse["messages"] {
  const geminiWizMessages = extractGeminiWizMessages();
  if (geminiWizMessages.messages.length > 0) return geminiWizMessages.messages;

  const candidates: Element[] = [];
  walkTree(document, (element) => {
    if (
      element.hasAttribute("data-message-author-role") ||
      element.tagName.toLowerCase() === "article" ||
      element.getAttribute("role") === "article" ||
      (element.getAttribute("data-testid") ?? "").includes("message")
    ) {
      candidates.push(element);
    }
  });
  const messages = candidates
    .map((node) => {
      const roleAttr =
        node.getAttribute("data-message-author-role") ??
        node.getAttribute("data-role") ??
        node.getAttribute("aria-label") ??
        "";
      const role = roleAttr.includes("assistant")
        ? ("assistant" as MessageRole)
        : roleAttr.includes("user")
          ? ("user" as MessageRole)
          : roleAttr.includes("system")
            ? ("system" as MessageRole)
        : roleAttr.includes("tool")
              ? ("tool" as MessageRole)
              : ("unknown" as MessageRole);
      const content = collectTextFromNode(node);
      return content ? { role, content } : null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (messages.length > 0) return messages;
  const bodyText = (collectTreeText(document) || document.body?.innerText || "").trim();
  if (detectProvider(location.href) === "gemini" && !looksLikeGeminiConversationText(bodyText)) {
    return [];
  }
  return bodyText ? [{ role: "unknown", content: bodyText }] : [];
}

async function snapshot(): Promise<SnapshotResponse> {
  const url = location.href;
  const provider = detectProvider(url);
  if (provider === "gemini") {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const geminiWizMessages = extractGeminiWizMessages();
      if (geminiWizMessages.messages.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const geminiWizMessages = provider === "gemini" ? extractGeminiWizMessages() : { messages: [], rows: [] };
  const messages = geminiWizMessages.messages.length > 0 ? geminiWizMessages.messages : extractMessages();
  return {
    provider,
    url,
    title: document.title,
    conversationId: detectConversationId(url),
    messages,
    raw: {
      bodyText: document.body?.innerText ?? "",
      composedText: collectTreeText(document),
      geminiWiz: provider === "gemini"
        ? {
            messageCount: messages.length,
            rows: geminiWizMessages.rows,
          }
        : undefined,
    },
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (value: unknown) => void) => {
  const typed = message as { type?: string };
  if (typed?.type === "polychat-ai:get-snapshot") {
    snapshot()
      .then((value) => sendResponse(value))
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});

chrome.runtime.sendMessage({
  type: "polychat-ai:page-ready",
  provider: detectProvider(location.href),
  url: location.href,
  title: document.title,
  conversationId: detectConversationId(location.href),
});
