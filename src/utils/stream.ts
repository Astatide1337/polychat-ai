export interface ParsedSSEEvent {
  event?: string;
  data: unknown;
  raw: string;
}

/**
 * Create a per-call SSE parser. Each call returns a fresh closure so
 * multiple concurrent requests don't share state.
 */
export function createSSEParser(): (raw: string) => ParsedSSEEvent[] {
  let pending = "";
  return function parseSSEChunk(raw: string): ParsedSSEEvent[] {
    pending += raw.replace(/\r\n/g, "\n");
    const events: ParsedSSEEvent[] = [];
    let boundaryIndex = pending.indexOf("\n\n");
    while (boundaryIndex !== -1) {
      const frame = pending.slice(0, boundaryIndex);
      pending = pending.slice(boundaryIndex + 2);
      const event = parseFrame(frame);
      if (event) events.push(event);
      boundaryIndex = pending.indexOf("\n\n");
    }
    return events;
  };
}

function parseFrame(frame: string): ParsedSSEEvent | null {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];
  let eventName: string | undefined;
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0 && !eventName) return null;
  const rawData = dataLines.join("\n");
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    // Not JSON — keep raw text
  }
  return { event: eventName, data, raw: frame };
}
