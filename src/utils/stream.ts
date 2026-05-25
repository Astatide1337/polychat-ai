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

// ── Tool call accumulator ─────────────────────────────────────────────────────

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function: {
    name?: string;
    arguments?: string;
  };
}

export interface AccumulatedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export class ToolCallAccumulator {
  private calls = new Map<number, AccumulatedToolCall>();

  feed(delta: { tool_calls?: StreamToolCallDelta[] }): void {
    if (!delta.tool_calls) return;
    for (const tc of delta.tool_calls) {
      const idx = tc.index;
      let existing = this.calls.get(idx);
      if (!existing) {
        existing = { id: "", type: "function", function: { name: "", arguments: "" } };
        this.calls.set(idx, existing);
      }
      if (tc.id) existing.id = tc.id;
      if (tc.type) existing.type = tc.type as "function";
      if (tc.function) {
        if (tc.function.name) existing.function.name = tc.function.name;
        if (tc.function.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  finish(): AccumulatedToolCall[] {
    const result: AccumulatedToolCall[] = [];
    const indices = [...this.calls.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const call = this.calls.get(idx)!;
      if (call.id && call.function.name) {
        result.push(call);
      }
    }
    this.calls.clear();
    return result;
  }
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
      dataLines.push(line.slice(5).trim());
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
