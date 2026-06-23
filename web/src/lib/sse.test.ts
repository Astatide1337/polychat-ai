import { describe, expect, it } from "vitest";
import { parseSseFrame } from "./sse";

describe("parseSseFrame", () => {
  it("parses OpenAI content deltas", () => {
    const events = parseSseFrame('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    expect(events).toEqual([{ type: "content", value: "hello" }]);
  });

  it("parses thinking and tool calls", () => {
    const events = parseSseFrame('data: {"choices":[{"delta":{"thinking":"hmm","tool_calls":[{"id":"1","type":"function","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\n');
    expect(events[0]).toEqual({ type: "thinking", value: "hmm" });
    expect(events[1]).toMatchObject({ type: "tool_calls" });
  });

  it("handles done frames", () => {
    expect(parseSseFrame("data: [DONE]\n\n")).toEqual([{ type: "done" }]);
  });
});
