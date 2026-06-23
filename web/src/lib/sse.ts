import type { ChatCompletionResponse, ToolCall } from "./types";

export type SseEvent =
  | { type: "content"; value: string }
  | { type: "thinking"; value: string }
  | { type: "tool_calls"; value: ToolCall[] }
  | { type: "debug"; value: unknown }
  | { type: "done" };

export function parseSseFrame(frame: string): SseEvent[] {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data) return [];
  if (data === "[DONE]") return [{ type: "done" }];

  const parsed = JSON.parse(data) as ChatCompletionResponse;
  const events: SseEvent[] = [];
  if (parsed.provider_debug !== undefined) events.push({ type: "debug", value: parsed.provider_debug });

  for (const choice of parsed.choices ?? []) {
    const delta = choice.delta ?? choice.message;
    if (delta?.thinking) events.push({ type: "thinking", value: delta.thinking });
    if (delta?.content) events.push({ type: "content", value: delta.content });
    if (delta?.tool_calls?.length) events.push({ type: "tool_calls", value: delta.tool_calls });
  }

  return events;
}

export async function consumeSse(
  response: Response,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("Streaming response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      for (const event of parseSseFrame(frame)) onEvent(event);
      separator = buffer.indexOf("\n\n");
    }
  }

  const tail = buffer.trim();
  if (tail) {
    for (const event of parseSseFrame(tail)) onEvent(event);
  }
}
