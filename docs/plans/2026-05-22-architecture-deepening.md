# Architecture Deepening Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Deepen four shallow areas of the codebase — delete dead TypeScript provider methods, add a cached model registry, share SSE stream framing, and unify the emulated completion streaming/non-streaming paths.

**Architecture:** Four independent refactor candidates executed in dependency order. Candidate 1 is pure deletion (no behavior change). Candidate 4 adds a ModelRegistry struct built at startup and refreshed on session push. Candidate 2 extracts shared SSE framing into `providers/sse.rs`. Candidate 3 unifies `run_emulated_completion` and `run_emulated_completion_streaming` via an `EmulatedSink` trait and extracts validation heuristics into an inline `mod validator`.

**Tech Stack:** Rust (axum, tokio, reqwest, serde), TypeScript (ESM)

---

## Task 1: Delete Dead TypeScript Provider Methods

**TDD scenario:** Modifying tested code — run existing build + tests after changes. No new tests needed (pure deletion).

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/providers/registry.ts`
- Modify: `src/providers/deepseek.ts`
- Modify: `src/providers/chatgpt.ts`
- Modify: `src/providers/claude.ts`
- Modify: `src/providers/gemini.ts`
- Modify: `src/providers/kimi.ts`
- Modify: `src/commands/login.ts`

**Step 1: Replace ProviderAdapter with LoginInfo in types.ts**

Replace the entire `ProviderAdapter` interface with:

```typescript
export interface LoginInfo {
  id: string;
  name: string;
  loginUrl: string;
  defaultModel: string;
}
```

Also delete the `ChatMessage`, `ChatOptions`, `ChatChunk`, `ProviderConversation` interfaces — they're only used by the dead provider methods. Keep `ModelInfo` if it's used elsewhere (check first). Actually, check:

```bash
rg "ChatMessage|ChatOptions|ChatChunk|ProviderConversation" src/ -g "*.ts" | grep -v "src/providers/"
```

If any are used outside `providers/`, keep them. If not, delete them.

**Step 2: Simplify registry.ts**

Replace with:

```typescript
import type { LoginInfo } from "./types.js";

const providers: Record<string, LoginInfo> = {
  chatgpt: { id: "chatgpt", name: "ChatGPT", loginUrl: "https://chatgpt.com/auth/login", defaultModel: "gpt-5-mini" },
  claude: { id: "claude", name: "Claude", loginUrl: "https://claude.ai/login", defaultModel: "claude-sonnet-4-6" },
  deepseek: { id: "deepseek", name: "DeepSeek", loginUrl: "https://chat.deepseek.com/sign_in", defaultModel: "deepseek-chat" },
  gemini: { id: "gemini", name: "Gemini", loginUrl: "https://gemini.google.com", defaultModel: "gemini-2.5-flash" },
  kimi: { id: "kimi", name: "Kimi", loginUrl: "https://www.kimi.com", defaultModel: "kimi" },
};

export function getLoginInfo(providerId: string): LoginInfo {
  const info = providers[providerId];
  if (!info) throw new Error(`Unknown provider "${providerId}". Available: ${Object.keys(providers).join(", ")}`);
  return info;
}
```

**Step 3: Gut provider files to pure config**

Each provider file (deepseek.ts, chatgpt.ts, claude.ts, gemini.ts, kimi.ts) becomes a single `export const xxxLoginInfo: LoginInfo = { ... }` object. Delete all helper functions, HTTP code, SSE parsing, and adapter methods. Delete the `playwright-core` imports from chatgpt.ts and claude.ts. Keep only what registry.ts needs.

For deepseek.ts specifically: keep `saveDeepSeekToken` and `extractTokenFromStorageState` — these are called from `src/commands/login.ts` (verify this). If they are, they must stay, but move them to a more appropriate location or keep them as non-adapter exports.

**Step 4: Update login.ts**

Replace `import { getAdapter } from "../providers/registry.js"` with `import { getLoginInfo } from "../providers/registry.js"`.

Replace all `adapter.loginUrl` → `info.loginUrl`, `adapter.name` → `info.name`, `adapter.models[0]?.id` → `info.defaultModel`.

For deepseek: if `saveDeepSeekToken` is called from login.ts, import it directly from `../providers/deepseek.js`.

**Step 5: Build and verify**

```bash
npm run build
```

Expected: Clean build, no errors.

**Step 6: Run existing TypeScript tests**

```bash
node --test test/phase1.test.mjs
node --test test/phase2.test.mjs
node --test test/phase3.test.mjs
```

Expected: All pass.

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: replace ProviderAdapter with LoginInfo, delete 1,150 lines of dead TS provider code"
```

---

## Task 2: Add ModelRegistry with Startup Cache

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `rust/server/src/routes/model_registry.rs`
- Modify: `rust/server/src/routes/mod.rs`
- Modify: `rust/server/src/main.rs`
- Modify: `rust/server/src/routes/resolver.rs`
- Modify: `rust/server/src/router.rs`
- Modify: `rust/server/src/routes/sessions.rs`
- Modify: `rust/server/src/routes/models.rs`

**Step 1: Write the failing test — ModelRegistry basic operations**

In `rust/server/src/routes/model_registry.rs`:

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crate::providers::{ModelInfo, Provider};
use crate::routes::resolver::Providers;
use crate::model_aliases::model_matches;

pub struct ModelRegistry {
    /// model_id → (provider_id, Arc<dyn Provider>)
    map: HashMap<String, (String, Arc<dyn Provider>)>,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self { map: HashMap::new() }
    }

    /// Build the registry by calling list_models on each connected provider.
    pub async fn build(providers: &Providers) -> Self {
        let mut map = HashMap::new();
        for (provider_id, provider) in providers.iter() {
            if let Ok(models) = provider.list_models().await {
                for model in models {
                    map.insert(model.id.clone(), (provider_id.clone(), provider.clone()));
                }
            }
        }
        Self { map }
    }

    /// Find the provider for a model ID (with alias support).
    pub fn find(&self, model_id: &str) -> Option<(Arc<dyn Provider>, String)> {
        for (id, (provider_id, provider)) in &self.map {
            if model_matches(model_id, id) {
                return Some((provider.clone(), provider_id.clone()));
            }
        }
        None
    }

    /// Find a specific ModelInfo by model ID.
    pub fn find_model(&self, model_id: &str) -> Option<ModelInfo> {
        // We need to store ModelInfo too — see Step 3
        todo!()
    }

    /// List all models in the registry.
    pub fn list_models(&self) -> Vec<ModelInfo> {
        // We need to store ModelInfo — see Step 3
        todo!()
    }
}
```

Write test:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_registry_finds_nothing() {
        let registry = ModelRegistry::new();
        assert!(registry.find("deepseek-chat").is_none());
    }

    #[test]
    fn registry_finds_inserted_model() {
        // We'll need a mock provider or manual insertion for unit tests
        // Use a manual insert method for testability
    }
}
```

Run: `cd rust && cargo test --bin polychat-server model_registry`
Expected: FAIL (module not yet registered)

**Step 2: Implement ModelRegistry with full storage**

Update `ModelRegistry` to also store `ModelInfo` alongside the provider:

```rust
struct RegistryEntry {
    provider_id: String,
    provider: Arc<dyn Provider>,
    model: ModelInfo,
}

pub struct ModelRegistry {
    entries: Vec<RegistryEntry>,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    pub async fn build(providers: &Providers) -> Self {
        let mut entries = Vec::new();
        for (provider_id, provider) in providers.iter() {
            if !crate::session::has_session(provider_id) { continue; }
            if let Ok(models) = provider.list_models().await {
                for model in models {
                    entries.push(RegistryEntry {
                        provider_id: provider_id.clone(),
                        provider: provider.clone(),
                        model,
                    });
                }
            }
        }
        Self { entries }
    }

    pub fn find(&self, model_id: &str) -> Option<(Arc<dyn Provider>, String)> {
        for entry in &self.entries {
            if model_matches(model_id, &entry.model.id) {
                return Some((entry.provider.clone(), entry.provider_id.clone()));
            }
        }
        None
    }

    pub fn find_model(&self, model_id: &str) -> Option<ModelInfo> {
        for entry in &self.entries {
            if model_matches(model_id, &entry.model.id) {
                return Some(entry.model.clone());
            }
        }
        None
    }

    pub fn list_models(&self) -> Vec<ModelInfo> {
        self.entries.iter().map(|e| e.model.clone()).collect()
    }
}
```

**Step 3: Register module and update main.rs**

In `rust/server/src/routes/mod.rs`, add: `pub mod model_registry;`

In `main.rs`, after building the provider map:

```rust
let model_registry = routes::model_registry::ModelRegistry::build(&providers).await;
let model_registry = Arc::new(model_registry);
tracing::info!("Model registry built with {} models", model_registry.list_models().len());
```

**Step 4: Thread ModelRegistry through router.rs**

Add `model_registry: Arc<ModelRegistry>` parameter to `build_router`. Replace the per-route `providers.clone()` calls for models and completions routes with the shared registry.

**Step 5: Rewrite resolver.rs to use ModelRegistry**

Replace `find_provider_for_model` and `find_model` to use `ModelRegistry::find` and `ModelRegistry::find_model`. Remove `list_connected_models` (replaced by `ModelRegistry::list_models`).

Update `completions.rs` to accept `Arc<ModelRegistry>` instead of calling `find_provider_for_model` with the providers map.

Update `models.rs` to use `registry.list_models()` instead of `list_connected_models`.

**Step 6: Add refresh on session push**

In `sessions.rs::push_session_handler`, after `save_session` succeeds, trigger a registry refresh. This requires the handler to have access to the `Arc<ModelRegistry>`. Thread it through the router.

Add a `refresh` method to `ModelRegistry`:

```rust
pub async fn refresh(&mut self, providers: &Providers) {
    *self = Self::build(providers).await;
}
```

Since `Arc<ModelRegistry>` is shared state, wrap it in `Arc<Mutex<ModelRegistry>>` or use `Arc<RwLock<ModelRegistry>>` for the refresh. The read path (find/find_model/list_models) is hot — use `RwLock` so reads don't contend.

**Step 7: Update tests**

Update any existing resolver.rs tests to work with the new ModelRegistry. Add unit tests for `ModelRegistry::find` with alias matching.

Run: `cd rust && cargo test --bin polychat-server`
Expected: All pass.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: ModelRegistry with startup cache, refresh on session push"
```

---

## Task 3: Extract Shared SSE Framing Module

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `rust/server/src/providers/sse.rs`
- Modify: `rust/server/src/providers/mod.rs` (add `pub mod sse`)
- Modify: `rust/server/src/providers/deepseek.rs`
- Modify: `rust/server/src/providers/claude.rs`
- Modify: `rust/server/src/providers/chatgpt.rs`
- Modify: `rust/server/src/providers/gemini.rs`
- Modify: `rust/server/src/providers/kimi.rs`

**Step 1: Write the failing test — SSE framing with line mode**

In `rust/server/src/providers/sse.rs`:

```rust
use tokio::sync::mpsc;
use crate::providers::{ChatChunk, ChunkStream, ReceiverStream};

/// Frame delimiter modes for the SSE stream parser.
pub enum FrameMode {
    /// Standard SSE: frames separated by `\n\n`, each line prefixed with `data:`
    Sse,
    /// Line-delimited JSON: each line is a self-contained data unit
    LineDelimited,
}

/// Stream an HTTP response into ChatChunks using a provider-specific handler.
///
/// The handler receives each complete frame (SSE data lines, or raw JSON lines)
/// and the channel sender. It is responsible for parsing the frame content
/// and sending `Ok(ChatChunk)` or `Err(...)` through the sender.
pub fn stream_response<F>(
    response: reqwest::Response,
    mode: FrameMode,
    handler: F,
) -> ChunkStream
where
    F: Fn(&str, &mpsc::Sender<anyhow::Result<ChatChunk>>) + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<anyhow::Result<ChatChunk>>(256);
    tokio::spawn(async move {
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
        use futures::StreamExt;

        while let Some(chunk_result) = stream.next().await {
            let bytes = match chunk_result {
                Ok(b) => b,
                Err(e) => {
                    let _ = tx.send(Err(anyhow::anyhow!("stream error: {}", e))).await;
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));

            match mode {
                FrameMode::Sse => {
                    while let Some(idx) = buffer.find("\n\n") {
                        let frame = buffer[..idx].to_string();
                        buffer = buffer[idx + 2..].to_string();
                        for line in frame.lines() {
                            let line = line.trim();
                            if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                                continue;
                            }
                            if let Some(data) = line.strip_prefix("data:") {
                                let data = data.trim();
                                if data == "[DONE]" { return; }
                                handler(data, &tx);
                            }
                        }
                    }
                }
                FrameMode::LineDelimited => {
                    while let Some(pos) = buffer.find('\n') {
                        let line = buffer[..pos].to_string();
                        buffer = buffer[pos + 1..].to_string();
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        handler(trimmed, &tx);
                    }
                }
            }
        }
    });
    Box::pin(ReceiverStream::new(rx))
}
```

Write test:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn sse_mode_extracts_data_lines() {
        // Create a mock response... this is tricky with reqwest::Response.
        // Alternative: test the frame extraction logic directly.
    }
}
```

Note: Testing with `reqwest::Response` directly is hard in unit tests. The best approach is to extract the *frame parsing* logic into a testable function that operates on a string buffer, then test that. The `stream_response` function becomes a thin wrapper around the parser + tokio spawn.

**Step 2: Extract testable frame parser**

Separate the parsing from the async:

```rust
/// Parsed SSE frame content.
pub enum ParsedFrame {
    Data(String),
    Done,
}

/// Extract complete frames from a buffer, returning remaining buffer.
/// Handles both SSE and line-delimited modes.
pub fn extract_frames(buffer: &mut String, mode: FrameMode) -> Vec<ParsedFrame> {
    let mut frames = Vec::new();
    match mode {
        FrameMode::Sse => {
            while let Some(idx) = buffer.find("\n\n") {
                let frame = buffer[..idx].to_string();
                *buffer = buffer[idx + 2..].to_string();
                for line in frame.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                        continue;
                    }
                    if let Some(data) = line.strip_prefix("data:") {
                        let data = data.trim();
                        if data == "[DONE]" {
                            frames.push(ParsedFrame::Done);
                            return frames;
                        }
                        frames.push(ParsedFrame::Data(data.to_string()));
                    }
                }
            }
        }
        FrameMode::LineDelimited => {
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].to_string();
                *buffer = buffer[pos + 1..].to_string();
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                frames.push(ParsedFrame::Data(trimmed.to_string()));
            }
        }
    }
    frames
}
```

Test this directly:

```rust
#[test]
fn sse_extracts_data_from_simple_frame() {
    let mut buf = "data: hello\n\n".to_string();
    let frames = extract_frames(&mut buf, FrameMode::Sse);
    assert_eq!(frames.len(), 1);
    assert!(matches!(&frames[0], ParsedFrame::Data(s) if s == "hello"));
}

#[test]
fn sse_handles_done_signal() {
    let mut buf = "data: [DONE]\n\n".to_string();
    let frames = extract_frames(&mut buf, FrameMode::Sse);
    assert_eq!(frames.len(), 1);
    assert!(matches!(&frames[0], ParsedFrame::Done));
}

#[test]
fn sse_skips_event_and_comment_lines() {
    let mut buf = "event: ping\n: keepalive\ndata: {\"type\":\"text\"}\n\n".to_string();
    let frames = extract_frames(&mut buf, FrameMode::Sse);
    assert_eq!(frames.len(), 1);
    assert!(matches!(&frames[0], ParsedFrame::Data(s) if s == "{\"type\":\"text\"}"));
}

#[test]
fn sse_normalizes_crlf() {
    let mut buf = "data: ok\r\n\r\n".to_string();
    // CRLF should have been normalized before calling extract_frames
    let buf_normalized = buf.replace("\r\n", "\n");
    let mut buf2 = buf_normalized;
    let frames = extract_frames(&mut buf2, FrameMode::Sse);
    assert_eq!(frames.len(), 1);
}

#[test]
fn sse_partial_frame_stays_in_buffer() {
    let mut buf = "data: partial".to_string();
    let frames = extract_frames(&mut buf, FrameMode::Sse);
    assert!(frames.is_empty());
    assert_eq!(buf, "data: partial");
}

#[test]
fn line_mode_extracts_complete_lines() {
    let mut buf = "{\"event\":\"cmpl\",\"text\":\"hi\"}\n".to_string();
    let frames = extract_frames(&mut buf, FrameMode::LineDelimited);
    assert_eq!(frames.len(), 1);
    assert!(matches!(&frames[0], ParsedFrame::Data(s) if s == "{\"event\":\"cmpl\",\"text\":\"hi\"}"));
}
```

Run: `cd rust && cargo test --bin polychat-server providers::sse`
Expected: PASS

**Step 3: Rewrite `stream_response` to use `extract_frames`**

```rust
pub fn stream_response<F>(
    response: reqwest::Response,
    mode: FrameMode,
    handler: F,
) -> ChunkStream
where
    F: Fn(&str, &mpsc::Sender<anyhow::Result<ChatChunk>>) + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<anyhow::Result<ChatChunk>>(256);
    tokio::spawn(async move {
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
        use futures::StreamExt;

        while let Some(chunk_result) = stream.next().await {
            let bytes = match chunk_result {
                Ok(b) => b,
                Err(e) => {
                    let _ = tx.send(Err(anyhow::anyhow!("stream error: {}", e))).await;
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));

            for frame in extract_frames(&mut buffer, mode) {
                match frame {
                    ParsedFrame::Done => return,
                    ParsedFrame::Data(data) => handler(&data, &tx),
                }
            }
        }
    });
    Box::pin(ReceiverStream::new(rx))
}
```

**Step 4: Migrate deepseek.rs to use shared SSE framing**

Replace `stream_deepseek_chunks` with:

```rust
fn stream_deepseek_chunks(response: reqwest::Response) -> ChunkStream {
    use crate::providers::sse::{stream_response, FrameMode};
    stream_response(response, FrameMode::Sse, |data, tx| {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            if let Some(obj) = json.as_object() {
                // (use the existing extract_text_from_event logic)
                // ...
            }
        }
    })
}
```

But wait — DeepSeek needs `response_started` state that persists across frames. The closure can't capture mutable state easily. Use the `Mutex` pattern or `Cell` inside the closure:

```rust
fn stream_deepseek_chunks(response: reqwest::Response) -> ChunkStream {
    use crate::providers::sse::{stream_response, FrameMode};
    use std::cell::Cell;
    let response_started = Cell::new(false);

    stream_response(response, FrameMode::Sse, move |data, tx| {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            if let Some(obj) = json.as_object() {
                let result = extract_text_from_event(obj, response_started.get());
                if let Some(text) = result.thinking {
                    let _ = tx.send(Ok(ChatChunk::Thinking(text))).await;
                }
                if let Some(text) = result.text {
                    let _ = tx.send(Ok(ChatChunk::Content(text))).await;
                }
                if result.response_started {
                    response_started.set(true);
                }
            }
        }
    })
}
```

**Problem:** The `handler` signature uses `&mpsc::Sender<...>` which doesn't support `.await` on `send()`. We need `tx.send().await` but the handler is a sync closure.

**Solution:** Change the handler to be async, OR use `try_send()` (non-blocking), OR use a different pattern. The simplest: use `tx.try_send()` or `tx.blocking_send()`. Actually, the handler runs inside a `tokio::spawn` so we can make it async. But `for frame in extract_frames(...)` is sync. The cleanest approach: have the handler return `Vec<anyhow::Result<ChatChunk>>` and the stream loop sends them:

```rust
pub fn stream_response<F>(
    response: reqwest::Response,
    mode: FrameMode,
    handler: F,
) -> ChunkStream
where
    F: Fn(&str) -> Vec<anyhow::Result<ChatChunk>> + Send + 'static,
{
    // ...
    for frame in extract_frames(&mut buffer, mode) {
        match frame {
            ParsedFrame::Done => return,
            ParsedFrame::Data(data) => {
                for chunk in handler(&data) {
                    let _ = tx.send(chunk).await;
                }
            }
        }
    }
}
```

This way the handler is a pure function — takes a data string, returns chunks. No async, no sender. Clean and testable.

**Step 5: Migrate all 5 providers**

For each provider, replace the `stream_*_chunks` function body with a call to `stream_response` + a handler closure.

- **deepseek.rs**: `FrameMode::Sse`, handler calls `extract_text_from_event`
- **claude.rs**: `FrameMode::Sse`, handler parses `content_block_delta` events
- **chatgpt.rs**: `FrameMode::Sse`, handler parses accumulated text + tool calls + reasoning. **Special case:** ChatGPT needs the `conv_tx` oneshot channel for conversation_id capture. Handle this by having the handler return `ChatChunk` plus an optional side-effect. OR: keep ChatGPT's stream function as-is initially, migrate the others first. **Decision:** Add a `stream_response_with_oneshot` variant that accepts an `Option<oneshot::Sender<String>>`, and the handler can return `(Vec<Result<ChatChunk>>, Option<String>)`. Actually, simpler: keep the oneshot capture inside the ChatGPT handler by using `Cell<Option<oneshot::Sender<String>>>`.

Revised handler signature for ChatGPT:

```rust
// For ChatGPT, the handler needs to optionally capture a conversation_id.
// Add a separate function that accepts extra state.
pub fn stream_response_with_state<S, F>(
    response: reqwest::Response,
    mode: FrameMode,
    initial_state: S,
    handler: F,
) -> ChunkStream
where
    S: Send + 'static,
    F: Fn(&str, &mut S, &mpsc::Sender<anyhow::Result<ChatChunk>>) + Send + 'static,
```

Hmm, this is getting complex. **Simpler approach:** Just use `Mutex<Option<oneshot::Sender<String>>>` inside the ChatGPT handler closure. The handler is already `Fn` (not `FnOnce`), so we need interior mutability. Use `std::sync::Mutex`:

```rust
fn stream_chatgpt_chunks(response: reqwest::Response, conv_tx: Option<oneshot::Sender<String>>) -> ChunkStream {
    use crate::providers::sse::{stream_response, FrameMode};
    use std::sync::Mutex;
    let conv_tx = Mutex::new(conv_tx);

    stream_response(response, FrameMode::Sse, move |data| {
        let mut chunks = Vec::new();
        if let Ok(json) = serde_json::from_str::<Value>(data) {
            // Capture conversation_id
            if let Some(tx) = conv_tx.lock().unwrap().take() {
                if let Some(cid) = json.get("conversation_id").and_then(|v| v.as_str()) {
                    let _ = tx.send(cid.to_string());
                }
            }
            // ... existing ChatGPT parsing logic ...
        }
        chunks
    })
}
```

**Gemini and ChatGPT special:** They both need oneshot channels for metadata. Add a generic "oneshot capture" to the shared module:

```rust
pub fn stream_response_with_capture<C, F>(
    response: reqwest::Response,
    mode: FrameMode,
    capture_tx: Option<oneshot::Sender<C>>,
    extract_capture: impl Fn(&serde_json::Value) -> Option<C> + Send + 'static,
    handler: F,
) -> ChunkStream
where
    C: Send + 'static,
    F: Fn(&str) -> Vec<anyhow::Result<ChatChunk>> + Send + 'static,
```

This is getting over-abstracted. **Final decision:** Keep it simple. Two functions:

1. `stream_sse_response(response, handler)` — for providers that only emit ChatChunks
2. `stream_sse_response_with_oneshot(response, oneshot_tx, extract_oneshot, handler)` — for ChatGPT and Gemini that also capture metadata via oneshot

The `handler` in both cases is `Fn(&str) -> Vec<anyhow::Result<ChatChunk>>`.

**Step 6: Run all tests**

```bash
cd rust && cargo test --bin polychat-server
```

Expected: All pass.

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: extract shared SSE framing module, migrate all 5 providers"
```

---

## Task 4: Unify Emulated Completion Streaming/Non-Streaming Paths

**TDD scenario:** Modifying tested code — run existing tests first, then refactor.

**Files:**
- Modify: `rust/server/src/routes/emulated_completion.rs`

**Step 1: Run existing emulated completion tests as baseline**

```bash
cd rust && cargo test --bin polychat-server emulated
```

Expected: All pass. Record count.

**Step 2: Define EmulatedSink trait and CollectingSink**

Inside `emulated_completion.rs`, add:

```rust
mod sink {
    use crate::routes::openai_format::StreamDelta;
    use axum::response::IntoResponse;
    use axum::Json;
    use serde_json::{json, Value};
    use tokio::sync::mpsc;

    /// A sink that absorbs emulated completion output.
    pub trait EmulatedSink {
        fn emit_content(&mut self, text: &str);
        fn emit_thinking(&mut self, text: &str);
        fn emit_tool_call(&mut self, tool_call_id: &str, name: &str, arguments: &str);
        fn finish(self, finish_reason: &str) -> EmulatedResult;
    }

    pub enum EmulatedResult {
        NonStream(String),
        Stream,
    }

    /// Collects output into a string (non-streaming path).
    pub struct CollectingSink {
        pub content: String,
        pub thinking: String,
        pub tool_calls: Vec<(String, String, String)>, // (id, name, arguments)
    }

    impl CollectingSink {
        pub fn new() -> Self {
            Self { content: String::new(), thinking: String::new(), tool_calls: Vec::new() }
        }
    }

    impl EmulatedSink for CollectingSink {
        fn emit_content(&mut self, text: &str) { self.content.push_str(text); }
        fn emit_thinking(&mut self, text: &str) { self.thinking.push_str(text); }
        fn emit_tool_call(&mut self, id: &str, name: &str, arguments: &str) {
            self.tool_calls.push((id.to_string(), name.to_string(), arguments.to_string()));
        }
        fn finish(self, _finish_reason: &str) -> EmulatedResult {
            EmulatedResult::NonStream(self.content)
        }
    }

    /// Sends output as SSE chunks through a channel (streaming path).
    pub struct StreamingSink {
        tx: mpsc::Sender<Result<String, std::io::Error>>,
        request_id: String,
        model: String,
        tool_call_index: usize,
    }

    impl StreamingSink {
        pub fn new(tx: mpsc::Sender<Result<String, std::io::Error>>, request_id: String, model: String) -> Self {
            Self { tx, request_id, model, tool_call_index: 0 }
        }
    }

    impl EmulatedSink for StreamingSink {
        fn emit_content(&mut self, text: &str) {
            let _ = self.tx.try_send(Ok(crate::routes::openai_format::format_sse_chunk(
                &self.request_id, &self.model,
                StreamDelta { content: Some(text.to_string()), ..Default::default() },
                None,
            )));
        }
        fn emit_thinking(&mut self, text: &str) {
            let _ = self.tx.try_send(Ok(crate::routes::openai_format::format_sse_chunk(
                &self.request_id, &self.model,
                StreamDelta { reasoning_content: Some(text.to_string()), ..Default::default() },
                None,
            )));
        }
        fn emit_tool_call(&mut self, id: &str, name: &str, arguments: &str) {
            // Emit tool call delta chunks (same format as openai_format.rs)
            // ... streaming tool call chunk emission ...
            self.tool_call_index += 1;
        }
        fn finish(self, finish_reason: &str) -> EmulatedResult {
            let _ = self.tx.try_send(Ok(crate::routes::openai_format::format_sse_chunk(
                &self.request_id, &self.model,
                StreamDelta::default(),
                Some(finish_reason.to_string()),
            )));
            let _ = self.tx.try_send(Ok("data: [DONE]\n\n".into()));
            EmulatedResult::Stream
        }
    }
}
```

**Step 3: Extract validation heuristics into inline mod validator**

Inside `emulated_completion.rs`, wrap all the `final_answer_*`, `should_accept_plain_text_final`, `should_retry_emulated_response`, `looks_like_structured_payload`, `normalize_validation_text`, `has_any_tool` functions in:

```rust
mod validator {
    // Move all validation/heuristic functions here
    // Keep them pub(super) so the main module can call them

    pub fn final_answer_requires_tool_retry(...) -> Option<String> { ... }
    pub fn should_accept_plain_text_final(...) -> bool { ... }
    pub fn should_retry_emulated_response(...) -> bool { ... }
    // etc.
}
```

**Step 4: Unify run_emulated_completion and run_emulated_completion_streaming**

Create a single `run_emulated_completion_loop<S: EmulatedSink>` function that replaces both. The key insight: both functions have the same retry loop structure (up to 3 attempts, call provider, validate, retry). The only difference is what happens with the output.

This is the most complex step. Both existing functions must be carefully compared line-by-line to identify true differences vs. accidental duplication.

Key differences to preserve:
- Non-streaming: collects all text, returns `ChatCompletionResponse`
- Streaming: sends SSE chunks through channel, returns `Response`
- Streaming has incremental tool call chunk emission
- Both share: retry logic, validation, repair prompt construction, tool name resolution

**Step 5: Update emulated_completion_response and stream_emulated_completion_response**

These become thin wrappers that create the appropriate sink and call the unified loop.

**Step 6: Run all tests**

```bash
cd rust && cargo test --bin polychat-server
```

Expected: Same count as baseline, all pass.

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: unify emulated completion streaming/non-streaming via EmulatedSink trait"
```

---

## Verification Checklist

After all four tasks are complete:

1. `cd rust && cargo test --bin polychat-server` — all tests pass
2. `cd rust && cargo build --release` — zero errors
3. `npm run build` — zero TypeScript errors
4. `node --test test/phase1.test.mjs` — all pass
5. `node --test test/phase2.test.mjs` — all pass
6. Start server: `rust/target/release/polychat-server --port 1443`
7. Verify `/health` shows connected providers
8. Verify `/v1/models` returns all models (from cache)
9. Test a completion on one provider
10. Push a session and verify model registry refreshes
