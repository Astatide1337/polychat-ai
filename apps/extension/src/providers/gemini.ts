import {
  normalizeGeminiConversation,
  type ConversationSummary,
  type ProviderAdapter,
} from "@polychat-ai/history-core/browser";

type GeminiListEntry = Array<unknown>;

type GeminiSession = {
  accessToken: string;
  buildLabel: string;
  sessionId: string;
};

function extractGeminiTokens(html: string): GeminiSession {
  const accessTokenMatch = /"SNlM0e":"([^"]+)"/.exec(html);
  const buildLabelMatch = /"cfb2h":"([^"]+)"/.exec(html);
  const sessionIdMatch = /"FdrFJe":"([^"]+)"/.exec(html);
  return {
    accessToken: accessTokenMatch?.[1] ?? "",
    buildLabel: buildLabelMatch?.[1] ?? "boq_assistant-bard-web-server_20240717.22_p0",
    sessionId: sessionIdMatch?.[1] ?? "",
  };
}

async function loadGeminiSession(): Promise<GeminiSession> {
  const response = await fetch("https://gemini.google.com/app", {
    credentials: "include",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Gemini app page failed: ${response.status}`);
  }
  const html = await response.text();
  const session = extractGeminiTokens(html);
  if (!session.accessToken) {
    throw new Error("Could not extract Gemini app token");
  }
  return session;
}

function isoSeconds(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seconds = typeof value[0] === "number" ? value[0] : Number(value[0]);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

async function fetchChatList(session: GeminiSession, pinned: boolean): Promise<GeminiListEntry[]> {
  const payload = JSON.stringify([13, null, [pinned ? 1 : 0, null, 1]]);
  const freq = JSON.stringify([[["MaZiqc", payload, null, "generic"]]]);
  const url = new URL("https://gemini.google.com/_/BardChatUi/data/batchexecute");
  url.searchParams.set("rpcids", "MaZiqc");
  url.searchParams.set("hl", "en");
  url.searchParams.set("rt", "c");
  url.searchParams.set("source-path", "/app");
  if (session.buildLabel) url.searchParams.set("bl", session.buildLabel);
  if (session.sessionId) url.searchParams.set("f.sid", session.sessionId);
  url.searchParams.set("_reqid", String(Math.floor(100000 + Math.random() * 900000)));
  const response = await fetch(
    url.toString(),
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        accept: "*/*",
      },
      body: new URLSearchParams({ "f.req": freq, at: session.accessToken }).toString(),
    }
  );
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }
  const text = await response.text();
  const entries: GeminiListEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ")]}'" || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown[];
      for (const part of parsed) {
        if (!Array.isArray(part)) continue;
        const body = part[2];
        if (typeof body !== "string") continue;
        const decoded = JSON.parse(body) as unknown[];
        const chatList = decoded[2];
        if (Array.isArray(chatList)) {
          for (const item of chatList) {
            if (Array.isArray(item)) entries.push(item as GeminiListEntry);
          }
        }
      }
    } catch {
      continue;
    }
  }
  return entries;
}

async function batchExecute(session: GeminiSession, rpcid: string, payload: unknown): Promise<unknown[]> {
  const freq = JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]);
  const url = new URL("https://gemini.google.com/_/BardChatUi/data/batchexecute");
  url.searchParams.set("rpcids", rpcid);
  url.searchParams.set("hl", "en");
  url.searchParams.set("rt", "c");
  url.searchParams.set("source-path", "/app");
  if (session.buildLabel) url.searchParams.set("bl", session.buildLabel);
  if (session.sessionId) url.searchParams.set("f.sid", session.sessionId);
  url.searchParams.set("_reqid", String(Math.floor(100000 + Math.random() * 900000)));
  const response = await fetch(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      accept: "*/*",
    },
    body: new URLSearchParams({ "f.req": freq, at: session.accessToken }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Gemini ${rpcid} request failed: ${response.status}`);
  }
  return parseBatchResponse(await response.text());
}

function parseBatchResponse(text: string): unknown[] {
  const parts: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ")]}'" || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown[];
      if (Array.isArray(parsed)) parts.push(...parsed);
    } catch {
      continue;
    }
  }
  return parts;
}

function getNested(value: unknown, path: Array<string | number>, fallback: unknown = null): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current) || key < 0 || key >= current.length) return fallback;
      current = current[key];
      continue;
    }
    if (!current || typeof current !== "object" || !(key in current)) return fallback;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? fallback;
}

function stringsFromMediaList(value: unknown, label: string, urlPath: Array<string | number>, altPath?: Array<string | number>): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const url = getNested(entry, urlPath);
    if (typeof url !== "string" || !url.trim()) return [];
    const alt = altPath ? getNested(entry, altPath) : null;
    const suffix = typeof alt === "string" && alt.trim() ? ` ${alt.trim()}` : "";
    return [`[${label} ${index + 1}]${suffix}`];
  });
}

function parseCandidateContent(candidate: unknown, cid: string, rid: string, rcid: string): { text: string; raw: unknown } {
  const textParts: string[] = [];
  const text = getNested(candidate, [1, 0]);
  if (typeof text === "string" && text.trim()) textParts.push(text.trim());
  const cardText = getNested(candidate, [22, 0]);
  if (typeof cardText === "string" && cardText.trim() && !textParts.includes(cardText.trim())) {
    textParts.push(cardText.trim());
  }
  const thoughts = getNested(candidate, [37, 0, 0]);
  if (typeof thoughts === "string" && thoughts.trim()) textParts.push(thoughts.trim());

  textParts.push(
    ...stringsFromMediaList(getNested(candidate, [12, 1], []), "Image", [0, 0, 0], [0, 4]),
    ...stringsFromMediaList(getNested(candidate, [12, 7, 0], []), "Generated Image", [0, 3, 3], [0, 3, 2]),
    ...stringsFromMediaList(getNested(candidate, [12, 0, "8", 0], []), "Generated Image", [0, 3, 3], [0, 3, 2])
  );

  const videoUrls = getNested(candidate, [12, 59, 0, 0, 0, 0, 7]);
  if (Array.isArray(videoUrls) && videoUrls.some((entry) => typeof entry === "string" && entry.trim())) {
    textParts.push("[Media] Generated video");
  }
  const mediaData = getNested(candidate, [12, 86]);
  if (Array.isArray(mediaData) && mediaData.length > 0) {
    textParts.push("[Media] Generated audio");
  }

  return {
    text: textParts.join("\n").trim(),
    raw: { cid, rid, rcid, candidate },
  };
}

async function readConversation(session: GeminiSession, id: string): Promise<unknown> {
  const parts = await batchExecute(session, "hNvQHb", [id, 1000, null, 1, [1], [4], null, 1]);
  const messages: Array<Record<string, unknown>> = [];
  let rawBody: unknown = null;

  for (const part of parts) {
    const bodyText = getNested(part, [2]);
    if (typeof bodyText !== "string") continue;
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      continue;
    }
    rawBody = body;
    const turns = getNested(body, [0]);
    if (!Array.isArray(turns)) continue;
    const blocks: Array<Array<Record<string, unknown>>> = [];
    for (const turn of turns) {
      const rid = String(getNested(turn, [0, 1], ""));
      const block: Array<Record<string, unknown>> = [];
      const userText = getNested(turn, [2, 0, 0]);
      if (typeof userText === "string" && userText.trim()) {
        block.push({
          id: `${id}:${rid || blocks.length}:user`,
          role: "user",
          content: userText,
          raw: turn,
        });
      }
      const candidates = getNested(turn, [3, 0]);
      if (Array.isArray(candidates)) {
        const candidateTexts = candidates.flatMap((candidate) => {
          const rcid = String(getNested(candidate, [0], ""));
          if (!rcid) return [];
          const parsed = parseCandidateContent(candidate, id, rid, rcid);
          return parsed.text
            ? [{
                id: `${id}:${rid || blocks.length}:${rcid}`,
                role: "assistant",
                content: parsed.text,
                raw: parsed.raw,
              }]
            : [];
        });
        block.push(...candidateTexts);
      }
      if (block.length > 0) blocks.push(block);
    }
    messages.push(...blocks.reverse().flat());
    break;
  }

  return {
    id,
    cid: id,
    url: `https://gemini.google.com/app/${id}`,
    messages,
    raw: rawBody,
  };
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  async listConversations() {
    const session = await loadGeminiSession();
    const entries = [...(await fetchChatList(session, true)), ...(await fetchChatList(session, false))];
    const seen = new Set<string>();
    return entries
      .map((item) => {
        const id = (typeof item[0] === "string" && item[0].trim()) || crypto.randomUUID();
        if (seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          provider: "gemini" as const,
          title: typeof item[1] === "string" && item[1].trim() ? item[1] : null,
          url: `https://gemini.google.com/app/${id}`,
          model: null,
          createdAt: isoSeconds(item[5]),
          updatedAt: isoSeconds(item[5]),
          lastSyncedAt: new Date().toISOString(),
          raw: item,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  },
  async getConversation(id: string) {
    const session = await loadGeminiSession();
    const raw = await readConversation(session, id);
    const normalized = normalizeGeminiConversation(raw);
    return normalized;
  },
};
