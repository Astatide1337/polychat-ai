import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(resolve(root, "..", "packages/history-core", "fixtures", name), "utf8"));

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("claude provider pagination keeps fetching until the next page is short", async () => {
  const pageOneFixture = fixture("claude-paginated-page-1.json");
  const pageTwoFixture = fixture("claude-paginated-page-2.json");
  const pageOneItem = pageOneFixture.items[0];
  const pageTwoItem = pageTwoFixture.items[0];
  assert.ok(pageOneItem);
  assert.ok(pageTwoItem);

  const moduleUrl = new URL("../apps/extension/src/providers/claude.ts", import.meta.url).href;
  const script = `
    const pageOneItem = ${JSON.stringify(pageOneItem)};
    const pageTwoItem = ${JSON.stringify(pageTwoItem)};
    const moduleUrl = ${JSON.stringify(moduleUrl)};
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push(url);
      if (url.endsWith("/api/organizations")) {
        return new Response(JSON.stringify([{ uuid: "claude-org-1" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/chat_conversations?offset=0&limit=100")) {
        return new Response(JSON.stringify({ items: Array.from({ length: 100 }, () => ({ ...pageOneItem })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/chat_conversations?offset=100&limit=100")) {
        return new Response(JSON.stringify({ items: [{ ...pageTwoItem }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(\`Unexpected fetch URL: \${url}\`);
    };
    try {
      const { claudeAdapter } = await import(moduleUrl);
      const conversations = await claudeAdapter.listConversations();
      if (conversations.length !== 2) throw new Error(\`Expected 2 conversations, got \${conversations.length}\`);
      if (conversations[0].id !== "claude-page-1") throw new Error(\`Unexpected first id \${conversations[0].id}\`);
      if (conversations[1].id !== "claude-page-2") throw new Error(\`Unexpected second id \${conversations[1].id}\`);
      if (!calls.some((url) => url.includes("/api/organizations"))) throw new Error("Missing organizations call");
      if (!calls.some((url) => url.includes("offset=0"))) throw new Error("Missing offset=0 page");
      if (!calls.some((url) => url.includes("offset=100"))) throw new Error("Missing offset=100 page");
    } finally {
      globalThis.fetch = originalFetch;
    }
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: resolve(root, ".."),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Claude pagination probe failed:\n${result.stderr || result.stdout}`);
  }
});
