import { beforeEach, describe, expect, it } from "vitest";
import { loadSessions, loadSettings, saveSessions, saveSettings } from "./storage";
import type { ChatSession } from "./types";

describe("storage", () => {
  beforeEach(() => localStorage.clear());

  it("persists sessions", () => {
    const session: ChatSession = {
      id: "s1",
      title: "Stored chat",
      provider: "claude",
      model: "claude-sonnet-4-6",
      providerConversationId: "c1",
      temporary: false,
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    saveSessions([session]);
    expect(loadSessions()).toEqual([session]);
  });

  it("loads settings with defaults", () => {
    saveSettings({ baseUrl: "http://localhost:1443", apiKey: "secret", inspectorOpen: false, inspectorTab: "debug" });
    expect(loadSettings()).toMatchObject({ baseUrl: "http://localhost:1443", inspectorTab: "debug" });
  });
});
