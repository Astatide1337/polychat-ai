# Polychat — Agent Coding Guide

This document is the single authoritative reference for AI agents working in this codebase.
Read it completely before touching any file.

---

## Project Overview

Polychat is an Ollama-like, OpenAI-compatible API server that proxies requests to browser-backed
AI subscriptions (DeepSeek, Claude, ChatGPT, Gemini, Kimi) without requiring API keys.
It has two independent runtime components:

| Component | Language | Entry Point | Purpose |
|-----------|----------|-------------|---------|
| TypeScript CLI + TUI | TypeScript (ESM) | `src/index.ts` | Login, session capture, interactive TUI |
| Rust API server | Rust | `rust/server/src/main.rs` | OpenAI-compatible HTTP API, served at runtime |

These are **separate binaries**. The TypeScript side handles login via CDP (Chromium), Firefox
profile reading, or OAuth PKCE. The Rust side handles all runtime API traffic. They share the
session files at `~/.polychat/sessions/`.

**The TypeScript HTTP server has been deleted.** The Rust server on port 1443 handles everything.
`polychat serve` spawns the Rust binary; `polychat chat` auto-spawns it if not running.

---

## Repository Layout

```
src/
  browser/        Browser login: CDP (cdp.ts), Firefox profile (profile.ts), OAuth PKCE (oauth.ts)
                  Browser detection (detect.ts), executable resolution (executable.ts)
  commands/       CLI commands: login, logout, serve, models, status, session, chat
  config/         Config loading from ~/.polychat/config.json
  providers/      TypeScript provider implementations:
                    chatgpt.ts, claude.ts, deepseek.ts, kimi.ts, gemini.ts
  session/        AES-256-GCM session encryption/decryption
 tui/ Ink-based interactive TUI (React), tool execution (bash/read/write/edit), approval system
  utils/          Binary resolution (binary.ts), PoW solver (deepseek-pow.ts), SSE parser, token estimator

rust/server/src/
  main.rs         Startup: load config, self-test, session scan, graceful shutdown
  config.rs       ~/.polychat/config.json and .env loading
  session.rs      AES-256-GCM encrypt/decrypt, session file I/O, OAuth session support
  auth.rs         Bearer token middleware (POLYCHAT_API_KEY)
  router.rs       axum Router, middleware stack
  providers/
 mod.rs Provider trait, shared types + helpers (ReceiverStream, merge_set_cookies, collect_set_cookies)
    deepseek.rs   DeepSeek HTTPS provider (PoW + token auth)
    claude.rs     Claude HTTPS provider (cookie auth)
    chatgpt.rs    ChatGPT HTTPS provider + cookie jar + PoW
kimi.rs Kimi cookie provider (kimi-auth cookie + v2 Connect RPC list_conversations)
gemini.rs Gemini web provider (SNlM0e token from BardChatUi, conversation continuity via metadata)
 sse.rs Shared SSE stream parser (reserved for future provider consolidation)
  routes/
    completions.rs POST /v1/chat/completions — streaming and non-streaming
    models.rs     GET /v1/models
    conversations.rs GET/POST /v1/conversations
    health.rs     GET /health
    generate.rs   POST /api/generate (Ollama-compatible)
    sessions.rs   POST/DELETE /v1/sessions/:provider (transport envelope)
  tools/
    inject.rs     System-prompt tool-call injection
    parser.rs     <<<<...>>>> streaming tool-call detector
  pow/
    keccak.rs     DeepSeekHashV1 — non-standard Keccak variant (see below)
    solver.rs     PoW challenge fetch + solve

test/ Production readiness test suite (production-readiness.test.mjs)
docs/             Provider API research notes (deepseek-api.md, chatgpt-api.md, claude-api.md, kimi-api.md)

---

## Build and Run

### TypeScript

```bash
npm run build        # tsup → dist/index.js (ESM)
node dist/index.js   # CLI entry
```

### Rust

```bash
cd rust
cargo build --release
./target/release/polychat-server --port 1443 --host 127.0.0.1
```

Default port is **1443** everywhere (config, TUI, Rust server, serve/chat commands).

Startup sequence (non-negotiable):
1. Load `~/.polychat/.env` → set env vars
2. Validate `POLYCHAT_SECRET_KEY` (≥32 chars)
3. Load `~/.polychat/config.json`
4. Run AES-256-GCM self-test
5. Scan session files, build provider map
6. Start axum server

### Test suites

```bash
```bash
# TypeScript production readiness tests
node --test test/production-readiness.test.mjs  # 7 tests

# Rust unit tests
cd rust && cargo test --bin polychat-server  # 145 tests
```

152 total automated tests across all suites.

---

## Configuration and Secrets

All secrets live in `~/.polychat/.env` (chmod 600). Never commit this file.

```
POLYCHAT_SECRET_KEY=<64 hex chars — generate with: openssl rand -hex 32>
POLYCHAT_API_KEY=<optional — required by clients to call the API>
```

Config at `~/.polychat/config.json` — camelCase keys:
```json
{
  "sessionSalt": "...",
  "defaultModel": "...",
  "lastValidated": "...",
  "server": { "port": 1443, "host": "127.0.0.1" },
  "providers": {
    "deepseek": { "connected": true, "defaultModel": "...", "temporary": false },
    "claude": { "connected": true, "defaultModel": "...", "temporary": false },
    "chatgpt": { "connected": true, "defaultModel": "...", "temporary": false },
    "gemini": { "connected": true, "defaultModel": "gemini-2.5-flash", "temporary": false },
    "kimi": { "connected": false, "defaultModel": "kimi" }
  }
}
```

Rust structs use `#[serde(rename_all = "camelCase")]` to match this format exactly.

---

## Session File Format

Sessions at `~/.polychat/sessions/<provider>.enc`:

```
[16-byte IV][16-byte AES-GCM auth tag][ciphertext]
```

Key derivation: `scrypt(POLYCHAT_SECRET_KEY + ":" + config.sessionSalt, "polychat-session-key", N=2^14, r=8, p=1, dkLen=32)`

**Critical parameter**: N=2^14 (16384), NOT 2^15. Using 2^15 produces wrong keys and breaks decryption.

The nonce is 16 bytes, matching Node.js `crypto.randomBytes(16)`. The Rust crate requires
`AesGcm<Aes256, U16>` — the standard `Aes256Gcm` alias uses a 12-byte nonce and will not work.

### Session content types

**Cookie sessions** (all providers): Playwright `storageState` JSON:
`{ cookies: [...], origins: [...] }`

All providers use cookie-based sessions from Firefox profile reading or CDP login.

---

## Provider Architecture

### DeepSeek
- **Login**: CDP browser (one-time) at `chat.deepseek.com`
- **Runtime**: 100% HTTPS, no browser needed after login
- **Auth**: `userToken` from localStorage stored as JSON `{"value": "..."}` — extract the inner string
- **PoW**: Required per request. Uses `DeepSeekHashV1` (non-standard Keccak — see below)
- **SSE format**: `data: {JSON patch}\n\n`, terminates with `[DONE]`
- **SSE events**: Three types:
  - Snapshot: `{"v": {"response": {"fragments": [...]}}}` — initial content
  - Object APPEND: `{"p": "response/fragments/-1", "o": "APPEND", "v": {"type": "RESPONSE", "content": "..."}}` — new fragment
  - String APPEND: `{"p": "response/fragments/-1/content", "o": "APPEND", "v": "text chunk"}` — bare string appended to last fragment content

### Claude
- **Login**: OAuth PKCE at `claude.ai` (client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`)
- **Runtime**: HTTPS with session cookies
- **SSE format**: `event: type\r\ndata: {...}\r\n\r\n` — CRLF separators (must normalize before parsing)
- **Termination**: `{"type": "message_stop"}` event — there is no `[DONE]`
- **Thinking content**: extracted from `content_block_delta` events with type `thinking`

### ChatGPT
- **Login**: OAuth PKCE at `auth.openai.com` (client ID: `app_EMoamEEZ73f0CkXaXp7hrann`)
- **Runtime**: HTTPS, but requires fresh Cloudflare cookies (`__cf_bm`, `__cflb`) on every request
- **Cookie handling**: Essential cookie filter to stay under 8KB HTTP header limit. Priority order:
  session-token, oai-client-auth, oai-is cookies first, then CF cookies. Sort by priority before
  truncating.
- **Cookie refresh**: `__cf_bm` and `__cflb` have ~30-minute TTL. The Rust server refreshes them
  by collecting `Set-Cookie` headers from each step of the auth chain:
  `auth/session` → `api/auth/csrf` → `sentinel/chat-requirements` → `conversation`
- **PoW**: Required per completion. SHA3-512 hash of `seed + base64(JSON array)`. Header name:
  `openai-sentinel-proof-token`. Max 100k iterations; fallback token if unsolved.
- **SSE format**: `data: {...}\n\n` with `[DONE]` termination
- **Conversation ID**: ChatGPT assigns its own UUIDs. The `create_conversation` call returns a
  placeholder UUID. A real conversation ID only exists after the first message is sent.

### Gemini
- **Login**: Firefox profile reading at `gemini.google.com` — captures Google session cookies
- **Runtime**: Gemini web API via `BardChatUi StreamGenerate` endpoint
- **Auth flow at runtime**:
  1. Fetch `https://gemini.google.com/app` with session cookies → extract `SNlM0e` token
  2. POST to `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
     with `at=<SNlM0e>` and `f.req=[null, json(inner_req_list)]`
  3. Parse line-delimited JSON response: text at `arr[0][2] → inner[4][0][1][0]`,
     conversation metadata at `inner[1]` (cid, rid, rcid)
- **SNlM0e token**: Extracted from Gemini app page HTML (`"SNlM0e":"<token>"`)
- **Session expiry**: `__cf_bm` Cloudflare cookies expire in ~30 minutes. Re-run
 `polychat login gemini` when Gemini returns 401/403 errors — this is routine, not a blocker (~5 seconds).
- **Models**: `gemini-3.1-pro`, `gemini-3.1-flash-lite`, `gemini-3-flash`, `gemini-3-pro`, `gemini-2.5-pro`, `gemini-2.5-flash` (static list)
- **Conversation continuity**: Gemini supports multi-turn conversations via metadata
  passed in `inner_req_list[2]`. The metadata array (cid, rid, rcid, ...) is extracted
  from the response at `inner[1]` and encoded as a JSON string for the `conversation_id`
  field. On subsequent requests, this JSON string is parsed back and placed at
  `inner[2]` to continue the conversation. The `ConversationTracker` in
  `completions.rs` automatically maps message history to the Gemini metadata.
- **Temporary chat**: Setting `inner_req_list[45] = 1` prevents the conversation from
  being saved to the user's Gemini history. Controlled via the `temporary` flag.
- **List conversations**: Uses batchexecute RPC with rpcid `MaZiqc` at
  `POST https://gemini.google.com/_/BardChatUi/data/batchexecute`. Fetches both
  pinned and unpinned chats in parallel.
- **Key dependencies**: `urlencoding` crate in Rust for URL-encoding `f.req` and `at` parameters


### Kimi (Moonshot AI)
- **Login**: Firefox profile reading at `www.kimi.com` — captures `kimi-auth` session cookie
- **Runtime Status**: WORKING — completions stream via `kimi-auth` cookie + random device ID
- **Auth**: `kimi-auth` cookie (length ~524 chars) from `www.kimi.com` domain
- **Create conversation**: `POST https://www.kimi.com/api/chat` with `kimiplus_id: "kimi"`
- **Stream**: `POST https://www.kimi.com/api/chat/{id}/completion/stream` — SSE with `event: cmpl` (text chunks) and `event: done` (terminate)
- **Anti-bot**: `x-msh-device-id` (random 16-digit number) + `x-msh-platform: web` headers — no Cloudflare clearance needed
- **CF protection**: `__cf_bm` only (auto-managed, non-blocking)
- **Models**: `kimi` (default), `k1`, `k1.5`, `k1.5-thinking`, `k2`
- **Conversation list**: v2 Connect RPC — `POST /apiv2/kimi.gateway.chat.v1.ChatService/ListChats` with `Content-Type: application/json` + `Connect-Protocol-Version: 1`. Returns `{chats: [{id, name, createTime, updateTime}], nextPageToken}`. Uses same auth headers as streaming.
- **List messages**: v2 Connect RPC — `POST /apiv2/kimi.gateway.chat.v1.ChatService/ListMessages` with `{chat_id, page_size}`. Returns full message history with block content.
- **v2 streaming**: Connect RPC `POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat` with `Content-Type: application/connect+proto` (binary protobuf). Also supports JSON unary but requires exact proto3 field naming. The old REST `/api/chat/{id}/completion/stream` SSE endpoint is simpler and used for completions.
---
## DeepSeekHashV1 — Critical Details

This is NOT standard Keccak or SHA3. Deviations from the spec:

1. **Padding**: 0x06 (same as SHA3, not 0x01 like standard Keccak)
2. **Rate**: 136 bytes (same as SHA3-256)
3. **Rotation schedule**: triangular numbers mod 64: `[1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 1, 12, 24, 37, 51, 2, 18, 35, 53, 8, 28, 49, 7, ...]`
4. **Round count**: 23 rounds (loop `i=1..=23`), skipping RC[0]
5. **Lane absorption**: big-endian within 8-byte lanes — bytes 4-7 form the high word, bytes 0-3 form the low word
6. **Squeeze output**: lo-word first, then hi-word, both little-endian

Verified test vectors (do not change algorithm without re-verifying these):
- `"test_salt_12345_0"` → `5ca746b9...`
- `"test_salt_12345_1"` → `a9e5aa0e...`
- `"b2b4550b267014dbbe56_1778745997902_65756"` → `190387b2...`

---

## API Surface

```
GET  /health                      No auth required
GET  /v1/models                   List all models from all providers
GET  /v1/models/:model_id         Get specific model
POST /v1/chat/completions         OpenAI-compatible completions
GET  /v1/conversations?provider=X List provider conversations
POST /v1/conversations            Create new conversation
POST /v1/sessions/:provider       Push session transport envelope
DELETE /v1/sessions/:provider     Delete session
POST /api/generate                Ollama-compatible generate endpoint
```

All routes except `/health` require `Authorization: Bearer <POLYCHAT_API_KEY>` when
`POLYCHAT_API_KEY` is set in `.env`.

### TUI Tool Execution

The TUI drives an agentic tool loop when `tools` are sent in the completion request:

1. User types a message
2. TUI sends completion request with `tools` parameter (4 tool definitions: bash, read, write, edit)
3. Server routes through emulated completion, parses `<polychat_tool_call>` blocks
4. Server returns OpenAI-compatible `tool_calls` in the response
5. TUI executes tool calls locally (with approval based on mode)
6. TUI sends `role: "tool"` messages with results back to the server
7. Steps 2-6 repeat until the model returns a final text answer (no tool_calls)
8. Maximum 20 tool rounds per user message (configurable via `/maxrounds`)

Approval modes:
- `auto`: all tools execute without confirmation (dangerous)
- `cautious` (default): `read` auto-approved, `bash`/`write`/`edit` require y/N
- `ask`: every tool call requires y/N

TUI slash commands for tools: `/mode`, `/tools`, `/maxrounds`

No Rust server changes are needed — the emulated completion system already handles tool-call parsing, validation, and retry.

### Completion request extensions (beyond OpenAI spec)

```json
{
  "model": "deepseek-chat",
  "messages": [...],
  "stream": true,
  "provider_conversation_id": "uuid-of-existing-conversation",
  "temporary": true,
  "tools": [...],
  "tool_choice": "auto"
}
```

`provider_conversation_id` routes the message into an existing provider-side conversation.
Omit it (or set to null) to create a new conversation automatically.

`temporary` prevents the conversation from being saved to the provider's history.
Supported by ChatGPT (`history_and_training_disabled`), Claude (`is_temporary`),
DeepSeek (`is_temp`), and Gemini (`inner_req_list[45] = 1`). Ignored by Kimi
(no API support). Can also be set as a per-provider default in
`~/.polychat/config.json` via the `temporary` field; the request-level flag is
OR'd with the config default.

### Conversation continuity (auto-tracking)

When `provider_conversation_id` is not provided, the server automatically maps message
history to the provider's internal conversation ID using the `ConversationTracker` in
`rust/server/src/routes/completions.rs`. The tracker:

- **Key**: hash of all `user` + `system` message content (ignoring `assistant` responses)
- **Value**: provider conversation ID
- **Lookup**: uses all messages except the last (the new user input) as the key
- **Store**: called after `send_message` returns, using the `conversation_id` from `ProviderResponse`
- **LRU eviction**: maximum 1000 entries; oldest entries are evicted first when the limit is exceeded

This ensures multi-turn conversations from any OpenAI-compatible client (OpenCode, Cursor,
Continue, etc.) reuse the same provider-side conversation without the client needing to
track the conversation ID.

---

## Login Architecture (Phase 2)

Login flows route based on provider and browser:

```
polychat login <provider>
 ├── OAuth providers (claude, chatgpt)
 │   └── loginWithOAuth() in src/browser/oauth.ts
 │       ├── PKCE via Web Crypto API
 │       ├── Local HTTP callback server on 127.0.0.1
 │       └── Saves { type: "oauth", access_token, refresh_token, expires_at }
 │           NOTE: Claude/ChatGPT OAuth tokens are not yet used by Rust providers;
 │                 the Rust providers read the session storageState cookies directly
 │
└── Non-OAuth providers (deepseek, gemini, kimi)
     ├── Chromium → loginWithCDP() in src/browser/cdp.ts
     │   ├── Spawns browser with --app= at ~/.polychat/browser/chromium profile
     │   ├── Connects via CDP WebSocket (ws package)
     │   ├── Polls Network.getAllCookies + localStorage
     │   └── Saves cookie-based storageState
     │
     ├── Firefox (Zen, LibreWolf, Floorp, Waterfox) → loginViaFirefoxProfile()
     │   ├── Opens default browser to loginUrl
     │   ├── Reads cookies from Firefox profile SQLite via node-sqlite3-wasm
     │   │   → WAL-mode databases: sqlite3 CLI used for checkpoint, then node-sqlite3-wasm reads
     │   └── Saves filtered cookie-based storageState
     │
     └── Safari → "Safari is not supported" error, exit 1
```

**No Playwright**. `playwright-core` was removed in Phase 2.

### Firefox profile WAL handling

Firefox and Zen browser keep cookies.sqlite in WAL mode. The profile reader:
1. Copies `cookies.sqlite` + `cookies.sqlite-wal` to a temp dir
2. If WAL file exists, runs `sqlite3 <file> .backup <nowal_file>` then `PRAGMA journal_mode=delete`
3. Then reads the non-WAL copy with `node-sqlite3-wasm`

This requires `sqlite3` CLI available in PATH.

---

## Testing Rules

### E2E Testing — Use Designated Test Conversations

**Every E2E test that sends completions MUST use the designated test conversation for that
provider.** Do not send messages without `provider_conversation_id` — this creates new
conversations in the user's personal account that must be manually deleted.

#### Designated Test Conversations

Set these in `~/.polychat/.env`:

```
POLYCHAT_TEST_DEEPSEEK_CONVERSATION_ID=<your-deepseek-test-conversation-id>
POLYCHAT_TEST_CLAUDE_CONVERSATION_ID=<your-claude-test-conversation-id>
POLYCHAT_TEST_CHATGPT_CONVERSATION_ID=<your-chatgpt-test-conversation-id>
POLYCHAT_TEST_KIMI_CONVERSATION_ID=<your-kimi-test-conversation-id>
```

| Provider | Completions | Model | Notes |
|----------|-------------|-------|-------|
| DeepSeek | ✅ Working | `deepseek-chat` | Use `$POLYCHAT_TEST_DEEPSEEK_CONVERSATION_ID` |
| Claude | ✅ Working | `claude-sonnet-4-6` | Use `$POLYCHAT_TEST_CLAUDE_CONVERSATION_ID` |
| ChatGPT | ✅ Working | `gpt-5-mini` | Use `$POLYCHAT_TEST_CHATGPT_CONVERSATION_ID` |
| Gemini | ✅ Working | `gemini-2.5-flash` | Supports conversation continuity via metadata. Use `provider_conversation_id` to continue an existing conversation. Run `polychat login gemini` if session expires (~5s, not a blocker) |
| Kimi | ✅ Working | `kimi` | Use `$POLYCHAT_TEST_KIMI_CONVERSATION_ID` |

ONLY use ONE singular test conversation and do NOT create new conversations on every request.

### E2E Testing — Realistic Usage Required

**Do NOT send trivial "ping/pong" or "say pong" test messages.** Sending repetitive
robotic prompts (especially one-word or two-word messages) can flag your account for
suspicious activity and result in rate-limits or account suspension. Instead, send
natural, substantive queries that a real user would ask — for example:

- "What are three interesting facts about the planet Mars?"
- "Explain the difference between TCP and UDP networking protocols"
- "Write a short Python function that finds the longest common subsequence of two strings"
- "Summarize the key events of the French Revolution in under 200 words"

This applies to both manual E2E probes and any automated test that sends completions.
Vary your prompts between test runs — do not reuse the same query repeatedly.

### Example Completion Calls

DeepSeek/Claude/ChatGPT (reuse test conversation — substitute your conversation ID):
```bash
curl -s http://127.0.0.1:1443/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "provider_conversation_id": "'"$POLYCHAT_TEST_DEEPSEEK_CONVERSATION_ID"'",
    "messages": [{"role": "user", "content": "Explain the difference between TCP and UDP"}],
    "stream": false
  }'
```

Gemini (supports conversation continuity via metadata):
```bash
curl -s http://127.0.0.1:1443/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
  "model": "gemini-2.5-flash",
  "messages": [{"role": "user", "content": "What are three interesting facts about the planet Mars?"}],
  "stream": false
}'
```

### Unit Tests

Unit tests live in the Rust binary (`cargo test --bin polychat-server`) inside `#[cfg(test)]`
blocks in the relevant source files.

```bash
# All unit tests
cd rust && cargo test --bin polychat-server

# Single module
cd rust && cargo test --bin polychat-server pow::keccak
cd rust && cargo test --bin polychat-server tools::parser
cd rust && cargo test --bin polychat-server session::tests
```

The `production-readiness.test.mjs` file is a static analysis test suite — it checks source code structure, not runtime behavior. It does NOT hit live APIs.

### E2E Verification Protocol

**If any provider returns 401/403 during E2E testing, run `polychat login <provider>` and retry. This is a routine operation (~5 seconds), not a blocker.**

Before claiming a change is complete:

1. `cd rust && cargo test --bin polychat-server` — all 145 unit tests must pass
2. `cd rust && cargo build --release` — zero errors (warnings acceptable)
3. Start the server: `rust/target/release/polychat-server --port 1443`
4. Run the test matrix using the designated conversation IDs above
5. Verify `/health` shows all connected providers `connected: true`
6. Verify `/v1/models` returns models from all connected providers

---

## Code Standards

### General

- No stubs, placeholders, TODOs, or `unimplemented!()` in delivered code.
- Fix bugs at the source. Never paper over a failure with a fallback that hides the real error.
- Remove dead code when you touch a file. Unused imports are a sign of incomplete work.
- Prefer narrow, well-named types over stringly-typed maps.
- If a function can fail, it returns `anyhow::Result` (Rust) or throws (TypeScript). Never return
  a plausible-looking success value when the operation failed.

### Rust

- Run `cargo fix --bin polychat-server` before declaring Rust work done to clear auto-fixable warnings.
- `anyhow::bail!` for early exit with context. `anyhow::Context` for adding context to `?` chains.
- Providers implement the `Provider` trait in `providers/mod.rs`. Do not add provider-specific
  logic to routes.
- SSE parsing must handle CRLF normalization before splitting on `\n\n`. Claude sends `\r\n`.
- Session files are the only I/O shared between TypeScript and Rust. The wire format is fixed —
  change it in both or neither.
- `AesGcm<Aes256, U16>` (16-byte nonce), not `Aes256Gcm` (12-byte nonce).
- scrypt N=2^14 (14 as the log2 parameter to `Params::new`).

### TypeScript

- ESM only. No `require()`. All imports use `.js` extensions for local files.
- No `playwright-core` imports. Login uses CDP (`ws` package), OAuth PKCE, or Firefox profile.
- Session files are written via `saveSession()` in `src/session/store.ts`. Never write them directly.
- TypeScript providers are used at login time only (for `loginUrl`, `name`, `detectLoginSuccess`).
  They do NOT read session files — that is the Rust server's job.
- `src/browser/pool.ts` has been deleted. No Playwright browser pool exists.

### Adding a New Provider

1. Implement the `Provider` trait in `rust/server/src/providers/<name>.rs`
2. Register it in `rust/server/src/main.rs` provider map
3. Add a TypeScript counterpart in `src/providers/<name>.ts` implementing the ProviderAdapter interface
4. Register it in `src/providers/registry.ts`
5. Add to `PROVIDERS` in `src/config/index.ts` and `rust/server/src/config.rs`
6. Add login flow routing in `src/commands/login.ts`
7. Add `hasProviderSessionArtifacts` detection in `src/browser/profile.ts`
8. Add domain filter in `PROVIDER_DOMAINS` in `src/browser/profile.ts`
9. Create a designated test conversation and add it to this file

---

## Known Constraints and Sharp Edges

**Qwen and Z.ai were dropped.** Qwen completions require Alibaba APLUS `bx-ua` (browser-runtime anti-bot, not replicable). Z.ai completions require Aliyun interactive CAPTCHA (server-validated, single-use). Both were reduced to listing-only in earlier phases and subsequently removed from the project entirely.

**ChatGPT Cloudflare cookies expire in ~30 minutes.** The Rust server refreshes them by
collecting `Set-Cookie` from each step of the per-request auth chain. If ChatGPT starts
returning 403, run `polychat login chatgpt` — this is routine, not a blocker.

**Gemini session expires.** The `SNlM0e` token is extracted live from `gemini.google.com/app` on each completion. The Google session cookies themselves expire after hours to days. When Gemini returns 401 `session_expired`, run `polychat login gemini` (reads fresh cookies from the Zen Firefox profile — takes ~5 seconds). This is a routine operation, not a blocker. AI agents should just run the login command and continue testing.


**Kimi conversation list via v2 Connect RPC.** `list_conversations` now uses the v2 Connect RPC endpoint `POST /apiv2/kimi.gateway.chat.v1.ChatService/ListChats` (JSON, `Connect-Protocol-Version: 1`). Completions still create a fresh conversation server-side if no `provider_conversation_id` is provided. Use `provider_conversation_id` to reuse a previously-created conversation.
**Firefox WAL database.** Firefox and Zen browser keep `cookies.sqlite` in WAL mode. The
profile reader uses `sqlite3` CLI to checkpoint the WAL before reading with `node-sqlite3-wasm`.
If `sqlite3` is not in PATH, WAL databases will return empty results (non-fatal — session
detection will fail and the login loop will retry).

**DeepSeek model IDs for completions vs health**: the health endpoint shows `defaultModel`
as `deepseek-v4-flash` (the provider's internal slug), but completions must use `deepseek-chat`
or `deepseek-r1` (the API model IDs returned by `/v1/models`).

**Claude has no `[DONE]` terminator.** The stream ends on `{"type": "message_stop"}`. Any
change to the Claude SSE parser must preserve this.

**DeepSeek APPEND events can carry a bare string** `{"p": "response/fragments/-1/content", "o": "APPEND", "v": "text"}`.
The `v` field is a string, not a fragment object. Handle `val.as_str()` before treating it
as a fragment array.

**Gemini supports conversation continuity.** The BardChatUi web API returns
conversation metadata (cid, rid, rcid) at `inner[1]` of the response. This
metadata is passed as `inner_req_list[2]` in subsequent requests to continue
the conversation. The `conversation_id` field is a JSON-serialized metadata
array (not a simple UUID). The `ConversationTracker` automatically maps
message history to the Gemini metadata for multi-turn conversations.

**Tool call parser `flush()` is mandatory.** A tool call that arrives in the last SSE chunk
will be in the `MaybeStart` or `Accumulating` state. Always call `flush()` after the stream
ends; never discard its output.

---

## What NOT to Do

- Do not hardcode model lists. Models are fetched live from each provider's API on startup.
- Do not add a global timeout to the reqwest client. A global timeout kills streaming responses.
  Use per-request `.timeout(Duration::from_secs(15))` on non-streaming calls only.
- Do not use `Aes256Gcm` (standard alias). Use `AesGcm<Aes256, U16>` explicitly.
- Do not use scrypt N=32768 (2^15). The correct value is 16384 (2^14).
- Do not send completions without `provider_conversation_id` during testing (except for the first message in a new Gemini conversation). Kimi has a test conversation ID.
- Do not create parallel conventions for the same pattern. If a pattern exists, follow it.
- Do not import `playwright-core` anywhere. It has been removed from the project.
- Do not reference `src/server/` — it has been deleted. The Rust server handles all HTTP.
- Do not reference `src/browser/pool.ts` — it has been deleted. Use `cdp.ts` or `oauth.ts`.
- Do not send trivial "ping/pong" test messages to providers — use realistic, substantive prompts to avoid suspicious-activity flags.
- Do not assume all providers support persistent conversations. Kimi creates a new conversation if no `provider_conversation_id` is provided.
