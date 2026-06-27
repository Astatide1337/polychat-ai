import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveProviderPlan,
  buildLiveProviderPlansFromEnv,
  finalizeLiveProviderReport,
  summarizeLiveSmokeReason,
  summarizeLiveSmokeStatus,
} from "../scripts/verify-polychat-history-live.mjs";

function provider(overrides = {}) {
  return {
    provider: "chatgpt",
    conversationId: "conv-1",
    messages: 12,
    mcpGetConversation: true,
    mcpGetMessages: true,
    searchHit: true,
    rawHiddenByDefault: true,
    status: "passed",
    reason: null,
    ...overrides,
  };
}

test("buildLiveProviderPlan requires both conversation id and search phrase", () => {
  assert.deepEqual(buildLiveProviderPlan("chatgpt", "", ""), {
    provider: "chatgpt",
    conversationId: null,
    messages: 0,
    mcpGetConversation: false,
    mcpGetMessages: false,
    searchHit: false,
    rawHiddenByDefault: false,
    status: "skipped",
    reason: "not configured",
  });

  assert.equal(buildLiveProviderPlan("chatgpt", "conv-1", "").status, "failed");
  assert.equal(buildLiveProviderPlan("chatgpt", "", "search phrase").status, "failed");
  assert.equal(buildLiveProviderPlan("chatgpt", "conv-1", "").reason, "missing search phrase");
  assert.equal(buildLiveProviderPlan("chatgpt", "", "search phrase").reason, "missing conversation id");
  assert.equal(buildLiveProviderPlan("chatgpt", "conv-1", "search phrase").status, "configured");
});

test("buildLiveProviderPlansFromEnv supports partial live configuration", () => {
  const plans = buildLiveProviderPlansFromEnv({
    POLYCHAT_TEST_CHATGPT_CONVERSATION_ID: "conv-1",
    POLYCHAT_TEST_CHATGPT_SEARCH_PHRASE: "search phrase",
  });

  assert.equal(plans[0].status, "configured");
  assert.equal(plans[1].status, "skipped");
  assert.equal(plans[2].status, "skipped");
});

test("summaries reflect skipped, partial, passed, and failed live smoke states", () => {
  assert.equal(summarizeLiveSmokeStatus([provider({ status: "skipped", reason: "not configured" })]), "skipped");
  assert.equal(
    summarizeLiveSmokeStatus([
      provider({ status: "passed" }),
      provider({ provider: "claude", status: "skipped", reason: "not configured" }),
    ]),
    "partial"
  );
  assert.equal(summarizeLiveSmokeStatus([provider({ status: "passed" })]), "passed");
  assert.equal(summarizeLiveSmokeStatus([provider({ status: "failed", reason: "boom" })]), "failed");

  assert.equal(summarizeLiveSmokeReason([provider({ status: "skipped", reason: "not configured" })]), "live provider env vars not configured");
  assert.equal(
    summarizeLiveSmokeReason([provider({ status: "failed", reason: "missing search phrase" })]),
    "chatgpt: missing search phrase"
  );
  assert.equal(
    summarizeLiveSmokeReason([
      provider({ status: "passed" }),
      provider({ provider: "claude", status: "skipped", reason: "not configured" }),
    ]),
    "skipped providers: claude"
  );
});

test("finalizeLiveProviderReport redacts unprocessed configured providers as failures", () => {
  assert.deepEqual(finalizeLiveProviderReport(null), {
    status: "skipped",
    reason: "not configured",
    conversationId: null,
    messages: 0,
    mcpGetConversation: false,
    mcpGetMessages: false,
    searchHit: false,
    rawHiddenByDefault: false,
  });

  assert.equal(finalizeLiveProviderReport(provider({ status: "configured", reason: null })).status, "failed");
  assert.equal(
    finalizeLiveProviderReport(provider({ status: "configured", reason: null })).reason,
    "live provider verification was not completed"
  );
  assert.equal(finalizeLiveProviderReport(provider()).status, "passed");
});
