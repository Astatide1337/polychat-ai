import { expect, test } from "@playwright/test";

async function mockApi(page: import("@playwright/test").Page, mode: "normal" | "empty" | "auth" = "normal") {
  await page.route("**/health", async (route) => {
    await route.fulfill({
      json: {
        status: "ok",
        providers: mode === "empty"
          ? {
              claude: { connected: false, session_valid: null, defaultModel: "claude-sonnet-4-6" },
              chatgpt: { connected: false, session_valid: null, defaultModel: "gpt-5-mini" },
            }
          : {
              claude: { connected: true, session_valid: true, defaultModel: "claude-sonnet-4-6" },
              chatgpt: { connected: false, session_valid: null, defaultModel: "gpt-5-mini" },
            },
      },
    });
  });
  await page.route("**/v1/models", async (route) => {
    if (mode === "auth") {
      await route.fulfill({ status: 401, json: { error: { message: "Unauthorized", code: "invalid_api_key" } } });
      return;
    }
    await route.fulfill({
      json: {
        object: "list",
        data: mode === "empty" ? [] : [
          { id: "claude-sonnet-4-6", object: "model", owned_by: "claude" },
          { id: "gpt-5-mini", object: "model", owned_by: "chatgpt" },
        ],
      },
    });
  });
  await page.route("**/v1/conversations?provider=*", async (route) => {
    await route.fulfill({
      json: {
        provider: "claude",
        supported: true,
        conversations: [{ id: "conv_1", provider: "claude", title: "Existing provider chat", modelId: "claude-sonnet-4-6" }],
      },
    });
  });
  await page.route("**/v1/mcp/servers", async (route) => route.fulfill({ json: { object: "list", data: [] } }));
  await page.route("**/v1/mcp/tools", async (route) => route.fulfill({ json: { object: "list", data: [] } }));
  let completionCount = 0;
  await page.route("**/v1/chat/completions", async (route) => {
    completionCount += 1;
    const body = route.request().postDataJSON();
    if (completionCount === 3) {
      expect(body.messages).toEqual([
        { role: "user", content: "First turn" },
        { role: "assistant", content: "Streaming response" },
        { role: "user", content: "Second turn" },
      ]);
    }
    await route.fulfill({
      headers: { "Content-Type": "text/event-stream" },
      body: [
        'data: {"choices":[{"delta":{"content":"Streaming"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":" response"}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    });
  });
}

test("WebUI loads health, models, debug, and MCP empty state", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator(".brand-row").getByText("Polychat", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox")).toContainText("claude-sonnet-4-6");
  await expect(page.getByText("1 connected")).toBeVisible();
  await page.getByRole("button", { name: /Debug/ }).click();
  await expect(page.getByText("Existing provider chat")).toBeVisible();
  await page.getByRole("button", { name: /MCP/ }).click();
  await expect(page.getByText("No MCP servers configured.")).toBeVisible();
});

test("user sends a message and sees streaming response", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByTitle("Toggle inspector").click();
  await page.getByPlaceholder("Message Polychat").fill("Explain the difference between TCP and UDP");
  await page.getByTitle("Send").click({ force: true });
  await expect(page.getByText("Streaming response")).toBeVisible();
});

test("regenerate preserves prior assistant context in a multi-turn chat", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByTitle("Toggle inspector").click();

  await page.getByPlaceholder("Message Polychat").fill("First turn");
  await page.getByTitle("Send").click({ force: true });
  await expect(page.getByText("Streaming response")).toBeVisible();

  await page.getByPlaceholder("Message Polychat").fill("Second turn");
  await page.getByTitle("Send").click({ force: true });
  await expect(page.getByText("Streaming response")).toHaveCount(2);

  await page.getByTitle("Regenerate").last().click();
  await expect(page.getByText("Streaming response")).toHaveCount(2);
});

test("no-provider empty state appears", async ({ page }) => {
  await mockApi(page, "empty");
  await page.goto("/");
  await expect(page.getByText("No providers connected")).toBeVisible();
});

test("auth-required state appears", async ({ page }) => {
  await mockApi(page, "auth");
  await page.goto("/");
  await expect(page.getByText(/API key needed/)).toBeVisible();
  await expect(page.getByPlaceholder("API key")).toBeVisible();
});
