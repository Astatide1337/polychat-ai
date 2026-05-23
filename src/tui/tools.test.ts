import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS } from "./tools.js";

describe("Tool definitions", () => {
  it("defines exactly 4 tools: bash, read, write, edit", () => {
    const names = TOOL_DEFINITIONS.map((t: any) => t.function.name);
    assert.deepEqual(names.sort(), ["bash", "edit", "read", "write"]);
  });

  it("each tool has a name, description, and parameters schema", () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.type === "function");
      assert.ok(tool.function.name);
      assert.ok(tool.function.description);
      assert.ok(tool.function.parameters.type === "object");
      assert.ok(tool.function.parameters.properties);
    }
  });

  it("bash tool requires a command string parameter", () => {
    const bash = TOOL_DEFINITIONS.find((t: any) => t.function.name === "bash")!;
    assert.ok(bash.function.parameters.properties.command);
    assert.deepEqual(bash.function.parameters.required, ["command"]);
  });

  it("read tool requires a path string parameter", () => {
    const read = TOOL_DEFINITIONS.find((t: any) => t.function.name === "read")!;
    assert.ok(read.function.parameters.properties.path);
    assert.deepEqual(read.function.parameters.required, ["path"]);
  });

  it("write tool requires path and content string parameters", () => {
    const write = TOOL_DEFINITIONS.find((t: any) => t.function.name === "write")!;
    assert.ok(write.function.parameters.properties.path);
    assert.ok(write.function.parameters.properties.content);
    assert.deepEqual(write.function.parameters.required, ["path", "content"]);
  });

  it("edit tool requires path, oldText, and newText string parameters", () => {
    const edit = TOOL_DEFINITIONS.find((t: any) => t.function.name === "edit")!;
    assert.ok(edit.function.parameters.properties.path);
    assert.ok(edit.function.parameters.properties.oldText);
    assert.ok(edit.function.parameters.properties.newText);
    assert.deepEqual(edit.function.parameters.required, ["path", "oldText", "newText"]);
  });
});
