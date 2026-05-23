import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeTool } from "./executor.js";

const TMP = path.join(os.tmpdir(), "polychat-executor-test");

describe("Tool executor", () => {
  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  // ── bash ────────────────────────────────────────────────────────
  it("bash: captures stdout", async () => {
    const result = await executeTool("bash", { command: "echo hello" });
    assert.equal(result.is_error, false);
    assert.ok(result.content.includes("hello"));
  });

  it("bash: captures stderr", async () => {
    const result = await executeTool("bash", { command: "echo oops >&2" });
    assert.equal(result.is_error, false);
    assert.ok(result.content.includes("oops"));
  });

  it("bash: returns error on non-zero exit", async () => {
    const result = await executeTool("bash", { command: "exit 1" });
    assert.equal(result.is_error, true);
  });

  // ── read ────────────────────────────────────────────────────────
  it("read: returns file contents", async () => {
    const filePath = path.join(TMP, "read-test.txt");
    fs.writeFileSync(filePath, "hello world");
    const result = await executeTool("read", { path: filePath });
    assert.equal(result.is_error, false);
    assert.equal(result.content, "hello world");
  });

  it("read: returns error for missing file", async () => {
    const result = await executeTool("read", { path: "/tmp/no-such-file-polychat-test" });
    assert.equal(result.is_error, true);
    assert.ok(result.content.includes("ENOENT") || result.content.includes("not found") || result.content.includes("No such"));
  });

  // ── write ───────────────────────────────────────────────────────
  it("write: creates file with content", async () => {
    const filePath = path.join(TMP, "write-test.txt");
    const result = await executeTool("write", { path: filePath, content: "written!" });
    assert.equal(result.is_error, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), "written!");
  });

  it("write: creates parent directories", async () => {
    const filePath = path.join(TMP, "sub", "dir", "write-test.txt");
    const result = await executeTool("write", { path: filePath, content: "nested!" });
    assert.equal(result.is_error, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), "nested!");
  });

  it("write: overwrites existing file", async () => {
    const filePath = path.join(TMP, "overwrite-test.txt");
    fs.writeFileSync(filePath, "old");
    const result = await executeTool("write", { path: filePath, content: "new" });
    assert.equal(result.is_error, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), "new");
  });

  // ── edit ────────────────────────────────────────────────────────
  it("edit: replaces exact text in a file", async () => {
    const filePath = path.join(TMP, "edit-test.txt");
    fs.writeFileSync(filePath, "foo bar baz");
    const result = await executeTool("edit", {
      path: filePath,
      oldText: "bar",
      newText: "qux",
    });
    assert.equal(result.is_error, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), "foo qux baz");
  });

  it("edit: returns error if oldText not found", async () => {
    const filePath = path.join(TMP, "edit-missing.txt");
    fs.writeFileSync(filePath, "hello world");
    const result = await executeTool("edit", {
      path: filePath,
      oldText: "not_found",
      newText: "replacement",
    });
    assert.equal(result.is_error, true);
    assert.ok(result.content.includes("not found") || result.content.includes("not present") || result.content.includes("No match"));
  });

  it("edit: returns error if oldText matches multiple times", async () => {
    const filePath = path.join(TMP, "edit-dup.txt");
    fs.writeFileSync(filePath, "aaa bbb aaa");
    const result = await executeTool("edit", {
      path: filePath,
      oldText: "aaa",
      newText: "ccc",
    });
    assert.equal(result.is_error, true);
    assert.ok(result.content.includes("multiple") || result.content.includes("ambiguous"));
  });

  it("edit: returns error for missing file", async () => {
    const result = await executeTool("edit", {
      path: "/tmp/no-such-file-polychat-edit-test",
      oldText: "x",
      newText: "y",
    });
    assert.equal(result.is_error, true);
  });

  it("executeTool: returns error for unknown tool name", async () => {
    const result = await executeTool("unknown_tool", {});
    assert.equal(result.is_error, true);
    assert.ok(result.content.includes("Unknown"));
  });
});
