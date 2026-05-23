import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldApprove } from "./approval.js";

describe("Approval system", () => {
  it("auto mode: approves all tools", () => {
    assert.equal(shouldApprove("bash", { mode: "auto" }), true);
    assert.equal(shouldApprove("read", { mode: "auto" }), true);
    assert.equal(shouldApprove("write", { mode: "auto" }), true);
    assert.equal(shouldApprove("edit", { mode: "auto" }), true);
  });

  it("cautious mode: auto-approves read, requires prompt for others", () => {
    assert.equal(shouldApprove("read", { mode: "cautious" }), true);
    assert.equal(shouldApprove("bash", { mode: "cautious" }), false);
    assert.equal(shouldApprove("write", { mode: "cautious" }), false);
    assert.equal(shouldApprove("edit", { mode: "cautious" }), false);
  });

  it("ask mode: requires prompt for all tools", () => {
    assert.equal(shouldApprove("read", { mode: "ask" }), false);
    assert.equal(shouldApprove("bash", { mode: "ask" }), false);
    assert.equal(shouldApprove("write", { mode: "ask" }), false);
    assert.equal(shouldApprove("edit", { mode: "ask" }), false);
  });

  it("unknown tools require prompt in all non-auto modes", () => {
    assert.equal(shouldApprove("unknown", { mode: "cautious" }), false);
    assert.equal(shouldApprove("unknown", { mode: "ask" }), false);
  });
});
