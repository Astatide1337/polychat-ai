type ContentRecord = Record<string, unknown>;

function isObject(value: unknown): value is ContentRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function labelFromRecord(record: ContentRecord): string {
  const candidates = [
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
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function kindFromRecord(record: ContentRecord): string {
  const kind =
    record.type ??
    record.kind ??
    record.mimeType ??
    record.mime_type ??
    record.contentType ??
    record.content_type;
  return typeof kind === "string" ? kind.toLowerCase() : "";
}

function summarizeRecord(record: ContentRecord, seen: Set<unknown>): string {
  const text = labelFromRecord(record);
  if (text) return text;

  const kind = kindFromRecord(record);
  const url = typeof record.url === "string" ? record.url.toLowerCase() : "";
  const source = typeof record.src === "string" ? record.src.toLowerCase() : "";
  const mediaHint = `${kind} ${url} ${source}`;
  const hasImageMarker =
    mediaHint.includes("image") ||
    mediaHint.includes("photo") ||
    mediaHint.includes("picture") ||
    mediaHint.includes("screenshot") ||
    mediaHint.includes("thumbnail") ||
    mediaHint.startsWith("data:image/");
  if (hasImageMarker) return "[Image]";

  const hasFileMarker =
    mediaHint.includes("file") ||
    mediaHint.includes("document") ||
    mediaHint.includes("attachment") ||
    mediaHint.includes("pdf") ||
    mediaHint.includes("csv") ||
    mediaHint.includes("sheet") ||
    mediaHint.includes("spreadsheet");
  if (hasFileMarker) return "[File]";

  const hasArtifactMarker =
    mediaHint.includes("artifact") ||
    mediaHint.includes("canvas") ||
    mediaHint.includes("board") ||
    mediaHint.includes("workspace") ||
    mediaHint.includes("document") && mediaHint.includes("generated") ||
    mediaHint.includes("chart") ||
    mediaHint.includes("diagram");
  if (hasArtifactMarker) return "[Artifact]";

  const hasMediaMarker =
    mediaHint.includes("video") ||
    mediaHint.includes("audio") ||
    mediaHint.includes("gif") ||
    mediaHint.includes("animation");
  if (hasMediaMarker) return "[Media]";

  const nestedKeys = [
    "parts",
    "items",
    "messages",
    "segments",
    "blocks",
    "attachments",
    "annotations",
    "content",
    "message",
    "text",
    "body",
    "bodyText",
    "value",
    "children",
    "data",
    "payload",
  ];
  for (const key of nestedKeys) {
    const nested = record[key];
    if (nested === undefined || nested === null) continue;
    const nestedText = summarizeContent(nested, seen);
    if (nestedText.trim()) return nestedText;
  }

  return "";
}

export function summarizeContent(value: unknown, seen: Set<unknown> = new Set()): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "";
    seen.add(value);
    return value
      .map((part) => summarizeContent(part, seen))
      .filter((part) => part.trim().length > 0)
      .join("\n");
  }
  if (isObject(value)) {
    if (seen.has(value)) return "";
    seen.add(value);
    return summarizeRecord(value, seen);
  }
  return "";
}
