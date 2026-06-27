export function buildLiveProviderPlansFromEnv(env = process.env) {
  return [
    buildLiveProviderPlan(
      "chatgpt",
      env.POLYCHAT_TEST_CHATGPT_CONVERSATION_ID?.trim() || "",
      env.POLYCHAT_TEST_CHATGPT_SEARCH_PHRASE?.trim() || ""
    ),
    buildLiveProviderPlan(
      "claude",
      env.POLYCHAT_TEST_CLAUDE_CONVERSATION_ID?.trim() || "",
      env.POLYCHAT_TEST_CLAUDE_SEARCH_PHRASE?.trim() || ""
    ),
    buildLiveProviderPlan(
      "gemini",
      env.POLYCHAT_TEST_GEMINI_CONVERSATION_ID?.trim() || "",
      env.POLYCHAT_TEST_GEMINI_SEARCH_PHRASE?.trim() || ""
    ),
  ];
}

export function buildLiveProviderPlan(provider, conversationId, searchPhrase) {
  const normalizedConversationId = String(conversationId ?? "").trim();
  const normalizedSearchPhrase = String(searchPhrase ?? "").trim();
  const base = {
    provider,
    conversationId: normalizedConversationId || null,
    messages: 0,
    mcpGetConversation: false,
    mcpGetMessages: false,
    searchHit: false,
    rawHiddenByDefault: false,
    status: "skipped",
    reason: "not configured",
  };

  if (!normalizedConversationId && !normalizedSearchPhrase) {
    return base;
  }
  if (!normalizedConversationId || !normalizedSearchPhrase) {
    return {
      ...base,
      status: "failed",
      reason: normalizedConversationId ? "missing search phrase" : "missing conversation id",
    };
  }
  return {
    ...base,
    status: "configured",
    reason: null,
    searchPhrase: normalizedSearchPhrase,
  };
}

export function finalizeLiveProviderReport(provider) {
  if (!provider) {
    return {
      status: "skipped",
      reason: "not configured",
      conversationId: null,
      messages: 0,
      mcpGetConversation: false,
      mcpGetMessages: false,
      searchHit: false,
      rawHiddenByDefault: false,
    };
  }

  return {
    status: provider.status === "configured" ? "failed" : provider.status,
    reason:
      provider.status === "configured"
        ? "live provider verification was not completed"
        : provider.reason,
    conversationId: provider.conversationId,
    messages: provider.messages,
    mcpGetConversation: provider.mcpGetConversation,
    mcpGetMessages: provider.mcpGetMessages,
    searchHit: provider.searchHit,
    rawHiddenByDefault: provider.rawHiddenByDefault,
  };
}

export function summarizeLiveSmokeStatus(providerPlans) {
  const statuses = providerPlans.map((provider) => (provider.status === "configured" ? "failed" : provider.status));
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.every((status) => status === "skipped")) return "skipped";
  if (statuses.some((status) => status === "skipped")) return "partial";
  return "passed";
}

export function summarizeLiveSmokeReason(providerPlans) {
  const failedReasons = providerPlans
    .filter((provider) => provider.status === "failed")
    .map((provider) => `${provider.provider}: ${provider.reason}`)
    .filter(Boolean);
  if (failedReasons.length > 0) {
    return failedReasons.join("; ");
  }
  const configured = providerPlans.filter((provider) => provider.status === "configured");
  if (configured.length > 0) {
    return "live provider verification was not completed";
  }
  const activeOrSkipped = providerPlans.filter((provider) => provider.status !== "skipped");
  if (activeOrSkipped.length === 0) {
    return "live provider env vars not configured";
  }
  const skipped = providerPlans.filter((provider) => provider.status === "skipped").map((provider) => provider.provider);
  if (skipped.length > 0) {
    return `skipped providers: ${skipped.join(", ")}`;
  }
  return null;
}
