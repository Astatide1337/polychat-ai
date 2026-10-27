import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sqlite from "node-sqlite3-wasm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secret = "ab".repeat(32);
const salt = "cd".repeat(32);
const key = scryptSync(`${secret}:${salt}`, "polychat-session-key", 32);

function encode(value) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decode(value) {
  const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 16));
  cipher.setAuthTag(value.subarray(16, 32));
  return JSON.parse(Buffer.concat([cipher.update(value.subarray(32)), cipher.final()]));
}

// Exercise a completed OAuth fallback without opening a browser, binding a port,
// or contacting a provider. All tokens and session contents are synthetic.
const preload = `
import http from "node:http";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
let callback;
http.createServer = (handler) => {
  callback = handler;
  return { listen() {}, close() {} };
};
childProcess.spawn = (command, args) => {
  const value = args.find((arg) => String(arg).startsWith("https://"));
  if (!value || !["open", "cmd", "xdg-open"].includes(command)) {
    throw new Error("Unexpected subprocess in login fixture");
  }
  writeFileSync(process.env.LOGIN_OAUTH_MARKER, "attempted");
  const auth = new URL(value);
  const redirect = new URL(auth.searchParams.get("redirect_uri"));
  redirect.searchParams.set("code", "fixture-code");
  redirect.searchParams.set("state", auth.searchParams.get("state"));
  queueMicrotask(() => callback({ url: redirect.pathname + redirect.search }, {
    writeHead() {}, end() {},
  }));
  return { unref() {} };
};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === "https://chatgpt.com/api/auth/session") {
    return Response.json({ accessToken: "fixture-cookie-access-token" });
  }
  if (!["https://platform.claude.com/v1/oauth/token", "https://auth.openai.com/oauth/token"].includes(url)) {
    throw new Error("Unexpected network request in login fixture");
  }
  return Response.json({ access_token: "fixture-oauth-token", refresh_token: "fixture-refresh-token", expires_in: 3600 });
};
syncBuiltinESMExports();
`;

function fixture(provider, withProfile) {
  const home = mkdtempSync(join(tmpdir(), "polychat-login-"));
  const configDir = join(home, ".polychat");
  mkdirSync(join(configDir, "sessions"), { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    defaultModel: "claude-sonnet-4-6",
    sessionSalt: salt,
    server: { host: "127.0.0.1", port: 1443 },
    providers: Object.fromEntries(Object.entries({
      chatgpt: "gpt-5-5", claude: "claude-sonnet-4-6", deepseek: "deepseek-v4-flash",
      gemini: "gemini-2.5-flash", kimi: "kimi",
    }).map(([name, defaultModel]) => [name, { connected: true, defaultModel, temporary: false }])),
  }));
  const session = join(configDir, "sessions", `${provider}.enc`);
  const original = encode({ cookies: [{ name: "fixture-existing", value: "preserved" }], origins: [] });
  writeFileSync(session, original);
  if (withProfile) {
    const profile = join(home, ".mozilla", "firefox", "fixture.default");
    mkdirSync(profile, { recursive: true });
    const db = new sqlite.Database(join(profile, "cookies.sqlite"));
    const domain = provider === "claude" ? ".claude.ai" : ".chatgpt.com";
    const name = provider === "claude" ? "sessionKey" : "__Secure-next-auth.session-token";
    db.exec(`CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER);
      INSERT INTO moz_cookies VALUES ('${domain}', '${name}', 'fixture-cookie-value-long-enough-for-login', '/', 4102444800, 1, 1, 0);`);
    db.close();
  }
  const hook = join(home, "preload.mjs");
  const marker = join(home, "oauth-attempted");
  writeFileSync(hook, preload);
  const result = spawnSync(process.execPath, ["--import", hook, join(root, "dist", "index.js"), "login", provider], {
    cwd: home,
    env: {
      PATH: dirname(process.execPath), HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      POLYCHAT_SECRET_KEY: secret, LOGIN_OAUTH_MARKER: marker, NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { home, session, original, marker, result };
}

for (const provider of ["claude", "chatgpt"]) {
  test(`${provider} login preserves an existing cookie session when browser authentication is unavailable`, (t) => {
    const f = fixture(provider, false);
    try {
      const stored = readFileSync(f.session);
      t.diagnostic(JSON.stringify({ provider, exit: f.result.status, preserved: stored.equals(f.original), oauthAttempted: existsSync(f.marker), storedType: decode(stored).type ?? "cookies" }));
      assert.equal(stored.equals(f.original), true, "Existing cookie session must remain unchanged");
      assert.equal(f.result.status, 1);
      assert.match(f.result.stderr, /authenticated Firefox or Zen session/i);
      assert.equal(existsSync(f.marker), false, "Unsupported OAuth must not begin");
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test(`${provider} login still captures an authenticated browser cookie session`, () => {
    const f = fixture(provider, true);
    try {
      assert.equal(f.result.status, 0);
      const stored = decode(readFileSync(f.session));
      assert.equal(stored.type, undefined);
      assert.ok(stored.cookies.some((cookie) => cookie.value === "fixture-cookie-value-long-enough-for-login"));
      assert.equal(existsSync(f.marker), false);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
}
