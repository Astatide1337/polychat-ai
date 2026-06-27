type GeminiWizMessage = {
  role: "user" | "assistant";
  content: string;
  raw: unknown;
};

type GeminiWizResult = {
  messages: GeminiWizMessage[];
  rows: unknown[][];
};

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

export function extractGeminiWizDataFromHtml(html: string): string | null {
  const match = /"TSDtV":"((?:[^"\\]|\\.)*)"/.exec(html);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

export function extractGeminiWizMessagesFromData(raw: string): GeminiWizResult {
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
