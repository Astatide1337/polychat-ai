import type { ProviderId } from "./types.js";

function stableValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function stableStringify(value: unknown): string {
  return stableValue(value);
}

export function sha256Hex(value: unknown): string {
  const text = stableStringify(value);
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  return seeds
    .map((seed) => fnv1aHex(text, seed))
    .join("");
}

export function shortId(prefix: string, value: unknown, length = 16): string {
  return `${prefix}_${sha256Hex(value).slice(0, length)}`;
}

export function scopedId(provider: ProviderId, ...parts: unknown[]): string {
  return shortId(provider, [provider, ...parts], 20);
}

function fnv1aHex(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
