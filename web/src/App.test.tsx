import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function streamResponse() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return Response.json({
          status: "ok",
          providers: {
            claude: { connected: true, session_valid: true, defaultModel: "claude-sonnet-4-6" },
            chatgpt: { connected: false, session_valid: null, defaultModel: "gpt-5-mini" },
          },
        });
      }
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "claude-sonnet-4-6", object: "model", owned_by: "claude" }],
        });
      }
      if (url.includes("/v1/conversations")) {
        return Response.json({ provider: "claude", supported: true, conversations: [] });
      }
      if (url.endsWith("/v1/chat/completions")) {
        return new Response(streamResponse(), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.endsWith("/v1/mcp/servers") || url.endsWith("/v1/mcp/tools")) {
        return Response.json({ object: "list", data: [] });
      }
      return Response.json({}, { status: 404 });
    }));
  });

  it("renders health and grouped models", async () => {
    render(<App />);
    expect(await screen.findByText("Polychat")).toBeInTheDocument();
    expect((await screen.findAllByText("claude-sonnet-4-6")).length).toBeGreaterThan(0);
    expect(await screen.findByText("1 connected")).toBeInTheDocument();
  });

  it("sends a streamed message", async () => {
    render(<App />);
    const textarea = await screen.findByPlaceholderText("Message Polychat");
    await userEvent.type(textarea, "Explain TCP and UDP");
    await userEvent.click(screen.getByTitle("Send"));
    await waitFor(() => expect(screen.getByText("Hello world")).toBeInTheDocument());
  });
});
