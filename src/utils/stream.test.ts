import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolCallAccumulator } from "./stream.js";

describe("ToolCallAccumulator", () => {
  it("accumulates a single tool call from streaming deltas", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] });
    acc.feed({ tool_calls: [{ index: 0, function: { arguments: "{\"comma" } }] });
    acc.feed({ tool_calls: [{ index: 0, function: { arguments: "nd\":\"ls\"}" } }] });
    const calls = acc.finish();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "call_1");
    assert.equal(calls[0].function.name, "bash");
    assert.equal(calls[0].function.arguments, "{\"command\":\"ls\"}");
  });

  it("returns empty array when no tool_calls were fed", () => {
    const acc = new ToolCallAccumulator();
    const calls = acc.finish();
    assert.equal(calls.length, 0);
  });

  it("handles multiple tool calls (different indices)", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } }] });
    acc.feed({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "bash", arguments: "" } }] });
    acc.feed({ tool_calls: [{ index: 0, function: { arguments: "{\"path\":\"/tmp\"}" } }] });
    acc.feed({ tool_calls: [{ index: 1, function: { arguments: "{\"command\":\"ls\"}" } }] });
    const calls = acc.finish();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].function.name, "read");
    assert.equal(calls[1].function.name, "bash");
  });

  it("ignores content-only deltas", () => {
    const acc = new ToolCallAccumulator();
    acc.feed({ content: "hello" });
    acc.feed({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] });
    acc.feed({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] });
    const calls = acc.finish();
    assert.equal(calls.length, 1);
  });
});
