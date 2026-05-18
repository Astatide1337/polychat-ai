//! ChatGPT provider — cookie + access token, no browser at runtime.
//!
//! Mirrors `src/providers/chatgpt.ts`.

use anyhow::{bail, Context};
use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, COOKIE, USER_AGENT, ACCEPT, REFERER, ORIGIN, CONTENT_TYPE};
use serde_json::Value;
use sha3::{Digest, Sha3_512};
use uuid::Uuid;
use base64::Engine;
use hex;
use tokio::sync::oneshot;
use std::time::Duration;

use crate::providers::*;
use crate::session::load_session;
use super::ReceiverStream;
use super::{merge_set_cookies, collect_set_cookies};

const CHATGPT_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0";

// ---------------------------------------------------------------------------
// Auth extraction
// ---------------------------------------------------------------------------

struct ChatGptAuth {
    access_token: String,
    cookie_header: String,
}

fn header_value(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn insert_cookie(headers: &mut HeaderMap, cookie_header: &str) {
    headers.insert(COOKIE, header_value(cookie_header));
}

fn merge_response_cookies(cookie_header: &mut String, response: &reqwest::Response) {
    let fresh = collect_set_cookies(response);
    *cookie_header = merge_set_cookies(cookie_header, fresh.into_iter());
}

fn update_access_token(access_token: &mut Option<String>, payload: &Value) {
    if let Some(token) = payload.get("accessToken").and_then(|v| v.as_str()).map(str::trim) {
        if !token.is_empty() {
            *access_token = Some(token.to_string());
        }
    }
}

fn build_session_headers(cookie_header: &str, accept: &'static str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static(accept));
    insert_cookie(&mut headers, cookie_header);
    headers.insert(ORIGIN, HeaderValue::from_static("https://chatgpt.com"));
    headers.insert(REFERER, HeaderValue::from_static("https://chatgpt.com/"));
    headers.insert(USER_AGENT, HeaderValue::from_static(CHATGPT_USER_AGENT));
    headers
}

fn extract_chatgpt_cookies(session: &Value) -> Option<String> {
    let cookies = session.get("cookies")?.as_array()?;

    // Priority 1: session tokens and essential auth cookies (avoid HTTP 431)
    let mut essential_pairs: Vec<String> = cookies.iter()
        .filter_map(|c| {
            let domain = c.get("domain").and_then(|d| d.as_str()).unwrap_or("");
            let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
            // Only include cookies from chatgpt.com / openai.com
            if !(domain.contains("chatgpt.com") || domain.contains("openai.com")) {
                return None;
            }
            // Only essential auth cookies: session tokens, oai-* auth, cf_bm, cflb
            let essential = name.contains("session-token")
                || name.contains("oai-is")
                || name.contains("oai-client-auth")
                || name == "__cf_bm"
                || name == "__cflb";
            if essential {
                Some(format!("{}={}", name, value))
            } else {
                None
            }
        })
        .collect();

    if essential_pairs.is_empty() { return None; }

    // Sort: session/auth tokens first so they fit within the 8KB cap
    essential_pairs.sort_by_key(|p| {
        let name = p.split('=').next().unwrap_or("");
        if name.contains("session-token") || name.contains("oai-is") || name.contains("oai-client-auth") { 0usize }
        else { 1 }
    });

    // Build cookie header, capping at 8KB
    let mut result = String::new();
    for pair in &essential_pairs {
        if result.len() + pair.len() + 2 > 8000 { break; }
        if !result.is_empty() { result.push_str("; "); }
        result.push_str(pair);
    }
    if result.is_empty() { None } else { Some(result) }
}

fn extract_access_token_from_session(session: &Value) -> Option<String> {
    if let Some(origins) = session.get("origins").and_then(|o| o.as_array()) {
        for origin in origins {
            if let Some(ls) = origin.get("localStorage").and_then(|l| l.as_array()) {
                for entry in ls {
                    let name = entry.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if name == "accessToken" {
                        if let Some(val) = entry.get("value").and_then(|v| v.as_str()) {
                            let trimmed = val.trim();
                            if !trimmed.is_empty() {
                                return Some(trimmed.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn build_chatgpt_base_headers(auth: &ChatGptAuth) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(AUTHORIZATION, header_value(&format!("Bearer {}", auth.access_token)));
    insert_cookie(&mut headers, &auth.cookie_header);
    headers.insert(ORIGIN, HeaderValue::from_static("https://chatgpt.com"));
    headers.insert(REFERER, HeaderValue::from_static("https://chatgpt.com/"));
    headers.insert(USER_AGENT, HeaderValue::from_static(CHATGPT_USER_AGENT));
    headers
}

// ---------------------------------------------------------------------------
// Proof-of-Work (SHA3-512 based)
// ---------------------------------------------------------------------------

fn generate_proof_token(seed: &str, difficulty: &str, user_agent: &str) -> Option<String> {
    let screens = [3008, 4010, 6000];
    let dprs = [1, 2, 4];
    let screen = screens[rand::random::<usize>() % screens.len()] * dprs[rand::random::<usize>() % dprs.len()];

    let now = chrono::Utc::now();
    let parse_time = now.format("%a, %d %b %Y %H:%M:%S GMT").to_string();

    let diff_len = difficulty.len();

    for i in 0..100000u32 {
        let proof_array: Vec<Value> = vec![
            Value::from(screen),
            Value::from(parse_time.clone()),
            Value::Null,
            Value::from(i),
            Value::from(user_agent.to_string()),
            Value::from("https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js"),
            Value::from("dpl=1440a687921de39ff5ee56b92807faaadce73f13"),
            Value::from("en"),
            Value::from("en-US"),
            Value::Null,
            Value::from("plugins\u{2212}[object PluginArray]"),
            Value::from("_reactListeningcfilawjnerp"),
            Value::from("alert"),
        ];

        let json_data = serde_json::to_string(&proof_array).ok()?;
        let base = base64::engine::general_purpose::STANDARD.encode(json_data.as_bytes());

        let mut hasher = Sha3_512::new();
        hasher.update(seed.as_bytes());
        hasher.update(base.as_bytes());
        let hash = hex::encode(hasher.finalize());

        if &hash[..diff_len] <= difficulty {
            return Some(format!("gAAAAAB{}", base));
        }
    }

    let fallback_json = serde_json::to_string(&format!("\"{}\"", seed)).ok()?;
    let fallback_base = base64::engine::general_purpose::STANDARD.encode(fallback_json.as_bytes());
    Some(format!("gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D{}", fallback_base))
}

// ---------------------------------------------------------------------------
// ChatGPT provider
// ---------------------------------------------------------------------------

pub struct ChatGptProvider {
    client: reqwest::Client,
}

impl ChatGptProvider {
    pub fn new() -> Self {
        ChatGptProvider {
            client: reqwest::Client::builder()
                            .connect_timeout(std::time::Duration::from_secs(10))
                            .build()
                .expect("building reqwest client"),
        }
    }

    async fn get_auth(&self) -> anyhow::Result<ChatGptAuth> {
        let session = load_session("chatgpt")?;
        let mut cookie_header = extract_chatgpt_cookies(&session)
            .context("ChatGPT session has no cookies")?;

        let mut access_token = extract_access_token_from_session(&session);

        {
            let headers = build_session_headers(&cookie_header, "application/json, text/plain, */*");

            let res = self.client
                .get("https://chatgpt.com/api/auth/session")
                .headers(headers)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .context("fetching ChatGPT auth session")?;

            if res.status().is_success() {
                merge_response_cookies(&mut cookie_header, &res);

                if let Ok(json) = res.json::<Value>().await {
                    update_access_token(&mut access_token, &json);
                }
            }
        }

        let access_token = access_token.context("ChatGPT session is missing an access token")?;
        Ok(ChatGptAuth { access_token, cookie_header })
    }

    async fn get_completion_headers(&self, auth: &ChatGptAuth) -> anyhow::Result<HeaderMap> {
        let mut cookie_jar = auth.cookie_header.clone();
        let mut headers = build_chatgpt_base_headers(auth);
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));

        let csrf_headers = build_session_headers(&cookie_jar, "application/json");

        if let Ok(res) = self.client
            .get("https://chatgpt.com/api/auth/csrf")
            .headers(csrf_headers)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
        {
            if res.status().is_success() {
                merge_response_cookies(&mut cookie_jar, &res);

                if let Ok(json) = res.json::<Value>().await {
                    if let Some(token) = json.get("csrfToken").and_then(|v| v.as_str()) {
                        headers.insert("x-csrf-token", header_value(token));
                    }
                }
            }
        }

        insert_cookie(&mut headers, &cookie_jar);

        let (req, fresh_cookies) = self.get_chat_requirements(auth, &headers).await;
        cookie_jar = merge_set_cookies(&cookie_jar, fresh_cookies.into_iter());
        insert_cookie(&mut headers, &cookie_jar);

        if !req.token.is_empty() {
            headers.insert("openai-sentinel-chat-requirements-token",
                header_value(&req.token));
        }
        if req.pow_required {
            if let (Some(seed), Some(difficulty)) = (&req.pow_seed, &req.pow_difficulty) {
                let ua = headers.get(USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
                if let Some(proof) = generate_proof_token(seed, difficulty, ua) {
                    headers.insert("openai-sentinel-proof-token",
                        header_value(&proof));
                }
            }
        }

        Ok(headers)
    }

    async fn fetch_current_node(
        &self,
        auth: &ChatGptAuth,
        conversation_id: &str,
    ) -> anyhow::Result<Option<String>> {
        let headers = build_chatgpt_base_headers(auth);
        let res = self.client
            .get(format!("https://chatgpt.com/backend-api/conversation/{}", conversation_id))
            .headers(headers)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("loading ChatGPT conversation detail")?;

        if !res.status().is_success() {
            bail!("ChatGPT conversation load request failed: {}", res.status());
        }

        let payload: Value = res.json().await.context("decoding ChatGPT conversation detail")?;
        Ok(payload
            .get("current_node")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    }

    async fn get_chat_requirements(&self, auth: &ChatGptAuth, headers: &HeaderMap) -> (ChatRequirementsResult, Vec<String>) {
        let token_prefix = &auth.access_token[..auth.access_token.len().min(32)];
        let fallback_token = token_prefix.to_string();
        let empty_cookies: Vec<String> = vec![];

        let mut req_headers = headers.clone();
        req_headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let res = match self.client
            .post("https://chatgpt.com/backend-api/sentinel/chat-requirements")
            .headers(req_headers)
            .json(&serde_json::json!({ "p": token_prefix }))
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return (ChatRequirementsResult {
                token: fallback_token, pow_required: false, pow_seed: None, pow_difficulty: None,
            }, empty_cookies),
        };

        if !res.status().is_success() {
            return (ChatRequirementsResult {
                token: fallback_token, pow_required: false, pow_seed: None, pow_difficulty: None,
            }, empty_cookies);
        }

        let fresh = collect_set_cookies(&res);

        match res.json::<Value>().await {
            Ok(json) => {
                let token = json.get("token").and_then(|v| v.as_str())
                    .unwrap_or(&fallback_token).to_string();
                let pow = json.get("proofofwork");
                (ChatRequirementsResult {
                    token,
                    pow_required: pow.as_ref().and_then(|p| p.get("required")).and_then(|v| v.as_bool()).unwrap_or(false),
                    pow_seed: pow.as_ref().and_then(|p| p.get("seed")).and_then(|v| v.as_str()).map(|s| s.to_string()),
                    pow_difficulty: pow.and_then(|p| p.get("difficulty")).and_then(|v| v.as_str()).map(|s| s.to_string()),
                }, fresh)
            }
            Err(_) => (ChatRequirementsResult {
                token: fallback_token, pow_required: false, pow_seed: None, pow_difficulty: None,
            }, empty_cookies),
        }
    }
}

struct ChatRequirementsResult {
    token: String,
    pow_required: bool,
    pow_seed: Option<String>,
    pow_difficulty: Option<String>,
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

fn build_payload(
    messages: &[ChatMessage],
    model: &str,
    conversation_id: Option<&str>,
    parent_message_id: Option<&str>,
) -> Value {
    let history = &messages[..messages.len().saturating_sub(1)];
    let latest = messages.last();

    let system_text = if !history.is_empty() {
        history.iter()
            .map(|m| format!("{}: {}", m.role.to_uppercase(), m.content))
            .collect::<Vec<_>>()
            .join("\n\n")
    } else {
        String::new()
    };

    let mut msg_array = Vec::new();

    if !system_text.is_empty() {
        msg_array.push(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "author": { "role": "system" },
            "content": { "content_type": "text", "parts": [system_text] },
            "metadata": {}
        }));
    }

    if let Some(latest) = latest {
        msg_array.push(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "author": { "role": latest.role },
            "content": { "content_type": "text", "parts": [latest.content] },
            "metadata": {}
        }));
    }

    let parent_message_id = parent_message_id
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    serde_json::json!({
        "model": model,
        "messages": msg_array,
        "parent_message_id": parent_message_id,
        "conversation_id": conversation_id,
        "timezone_offset_min": chrono::Local::now().offset().local_minus_utc() / 60,
    })
}

// ---------------------------------------------------------------------------
// Provider trait implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl Provider for ChatGptProvider {
    fn id(&self) -> &'static str { "chatgpt" }
    fn name(&self) -> &'static str { "ChatGPT" }

    async fn validate_session(&self) -> bool {
        self.get_auth().await.is_ok()
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        let auth = self.get_auth().await?;
        let headers = build_chatgpt_base_headers(&auth);

        let res = self.client
            .get("https://chatgpt.com/backend-api/models?history_and_training_disabled=false")
            .headers(headers)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("fetching ChatGPT models")?;

        if !res.status().is_success() {
            bail!("ChatGPT model list request failed: {}", res.status());
        }

        let payload: Value = res.json().await?;
        Ok(normalize_chatgpt_models(&payload))
    }

    async fn list_conversations(&self) -> anyhow::Result<Vec<ProviderConversation>> {
        let auth = self.get_auth().await?;
        let headers = build_chatgpt_base_headers(&auth);

        let res = self.client
            .get("https://chatgpt.com/backend-api/conversations?offset=0&limit=50&order=updated")
            .headers(headers)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("listing ChatGPT conversations")?;

        if !res.status().is_success() {
            return Ok(vec![]);
        }

        let payload: Value = res.json().await?;
        let items = payload.get("items").or_else(|| payload.get("conversations"))
            .and_then(|v| v.as_array());

        let mut convos = Vec::new();
        if let Some(items) = items {
            for item in items {
                let id = item.get("id").or_else(|| item.get("conversation_id"))
                    .and_then(|v| v.as_str()).unwrap_or("").to_string();
                if id.is_empty() { continue; }
                let title = item.get("title").and_then(|v| v.as_str())
                    .map(|t| t.trim()).filter(|t| !t.is_empty())
                    .unwrap_or("Untitled conversation").to_string();
                let updated_at = item.get("update_time").and_then(|v| {
                    v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|ts| {
                        chrono::DateTime::from_timestamp(ts, 0)
                            .map(|dt| dt.to_rfc3339()).unwrap_or_default()
                    }))
                });
                convos.push(ProviderConversation {
                    id,
                    provider: "chatgpt".into(),
                    title,
                    model_id: None,
                    updated_at,
                    url: None,
                });
            }
        }
        Ok(convos)
    }

    async fn create_conversation(&self, _model: &str) -> anyhow::Result<ProviderConversation> {
        // ChatGPT has no separate "create conversation" API — conversations are
        // auto-created on the first message. See send_message() for the capture
        // of the real conversation_id from the first SSE event.
        Ok(ProviderConversation {
            id: String::new(),
            provider: "chatgpt".into(),
            title: "New conversation".into(),
            model_id: None,
            updated_at: None,
            url: None,
        })
    }

    fn tool_call_strategy(&self) -> ToolCallStrategy { ToolCallStrategy::Emulated }

    async fn send_message(
        &self,
        messages: &[ChatMessage],
        model: &str,
        _options: &ChatOptions,
        conversation_id: Option<&str>,
    ) -> anyhow::Result<ProviderResponse> {
        let auth = self.get_auth().await?;
        let headers = self.get_completion_headers(&auth).await?;
        let parent_message_id = if let Some(conversation_id) = conversation_id {
            self.fetch_current_node(&auth, conversation_id).await?
        } else {
            None
        };
        let payload = build_payload(messages, model, conversation_id, parent_message_id.as_deref());

        let mut body = payload.as_object().cloned().unwrap_or_default();
        body.insert("action".into(), Value::from("next"));
        body.insert("history_and_training_disabled".into(), Value::from(false));
        body.insert("conversation_mode".into(), serde_json::json!({ "kind": "primary_assistant" }));
        body.insert("force_paragen".into(), Value::from(false));
        body.insert("force_rate_limit".into(), Value::from(false));

        let res = self.client
            .post("https://chatgpt.com/backend-api/conversation")
            .headers(headers)
            .json(&body)
            .send()
            .await
            .context("ChatGPT conversation request")?;

        if !res.status().is_success() {
            bail!("ChatGPT conversation request failed: {}", res.status());
        }

        // If creating a new conversation (no ID was passed), try to capture
        // the conversation_id from the first SSE event.
        let captured_id = if conversation_id.is_none() {
            let (tx, mut rx) = oneshot::channel::<String>();
            let stream = stream_chatgpt_chunks(res, Some(tx));
            let cid = tokio::time::timeout(Duration::from_secs(2), &mut rx).await
                .ok().and_then(|r| r.ok());
            std::mem::drop(rx);
            (stream, cid)
        } else {
            (stream_chatgpt_chunks(res, None), None)
        };

        Ok(ProviderResponse {
            stream: captured_id.0,
            conversation_id: captured_id.1.or_else(|| conversation_id.map(|s| s.to_string())),
        })
    }
}

// ---------------------------------------------------------------------------
// ChatGPT SSE stream parser
// ---------------------------------------------------------------------------

fn stream_chatgpt_chunks(response: reqwest::Response, conv_tx: Option<oneshot::Sender<String>>) -> ChunkStream {
    use tokio::sync::mpsc;
    let (tx, rx) = mpsc::channel::<anyhow::Result<ChatChunk>>(256);

    tokio::spawn(async move {
        let mut pending = String::new();
        let mut last_text = String::new();
        // Take ownership of oneshot sender so we can send it (send() takes self)
        let mut conv_tx = conv_tx;
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

            let chunk_str = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
                        pending.push_str(&chunk_str);

            while let Some(idx) = pending.find("\n\n") {
                let frame = pending[..idx].to_string();
                pending = pending[idx + 2..].to_string();

                for line in frame.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                        continue;
                    }
                    if let Some(data) = line.strip_prefix("data:") {
                        let data = data.trim();
                        if data == "[DONE]" { return; }

                        if let Ok(json) = serde_json::from_str::<Value>(data) {
                            // Capture conversation_id from the first SSE event (one-shot)
                            if let Some(tx) = conv_tx.take() {
                                if let Some(cid) = json.get("conversation_id").and_then(|v| v.as_str()) {
                                    let _ = tx.send(cid.to_string());
                                }
                            }

                            // Check for native tool call before text extraction
                            if let Some((tool_name, tool_args)) = extract_chatgpt_tool_call(&json) {
                                let tc_text = format!(
                                    r#"<<<<{{"name":"{}","arguments":{}}}>>>>"#,
                                    tool_name, tool_args
                                );
                                let _ = tx.send(Ok(ChatChunk::Content(tc_text))).await;
                            }

                            // Extract text delta normally
                            if let Some(new_text) = extract_chatgpt_latest_text(&json) {
                                if new_text.len() > last_text.len() && new_text.starts_with(&last_text) {
                                    let delta = new_text[last_text.len()..].to_string();
                                    let _ = tx.send(Ok(ChatChunk::Content(delta))).await;
                                    last_text = new_text;
                                } else if !new_text.is_empty() && new_text != last_text {
                                    let _ = tx.send(Ok(ChatChunk::Content(new_text.clone()))).await;
                                    last_text = new_text;
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    Box::pin(ReceiverStream::new(rx))
}

fn extract_chatgpt_latest_text(data: &Value) -> Option<String> {
    if data.get("type").and_then(|v| v.as_str()) == Some("error") {
        return None;
    }

    if let Some(message) = data.get("message") {
        if let Some(content) = message.get("content") {
            if content.get("content_type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(author) = message.get("author") {
                    if author.get("role").and_then(|v| v.as_str()) == Some("assistant") {
                        if let Some(parts) = content.get("parts").and_then(|p| p.as_array()) {
                            let text: String = parts.iter()
                                .filter_map(|p| p.as_str())
                                .collect();
                            if !text.is_empty() {
                                return Some(text);
                            }
                        }
                    }
                }
            }
        }
    }

    if data.get("o").and_then(|v| v.as_str()) == Some("append") {
        if let Some(path) = data.get("p").and_then(|v| v.as_str()) {
            if path.starts_with("/message/content/parts") {
                if let Some(val) = data.get("v").and_then(|v| v.as_str()) {
                    return Some(val.to_string());
                }
            }
        }
    }

    None
}

/// Try to extract a tool call from a ChatGPT SSE event.
/// Returns `(tool_name, arguments_json_string)` if the event is a tool call.
fn extract_chatgpt_tool_call(data: &Value) -> Option<(String, String)> {
    let message = data.get("message")?;

    // Check for recipient (tool name) — the key indicator of a tool call
    let recipient = message.get("recipient")?.as_str()?;
    if recipient.is_empty() {
        return None;
    }

    let metadata = message.get("metadata")?;

    // Try metadata.args first (common format)
    if let Some(args_str) = metadata.get("args").and_then(|v| v.as_str()) {
        // Validate it's parseable JSON
        if serde_json::from_str::<serde_json::Value>(args_str).is_ok() {
            return Some((recipient.to_string(), args_str.to_string()));
        }
    }

    // Try metadata.tool_call (alternative format)
    if let Some(tc) = metadata.get("tool_call") {
        if let (Some(name), Some(args_val)) = (
            tc.get("name").and_then(|v| v.as_str()),
            tc.get("arguments"),
        ) {
            let args_str = if let Some(s) = args_val.as_str() {
                s.to_string()
            } else {
                serde_json::to_string(args_val).unwrap_or_default()
            };
            return Some((name.to_string(), args_str));
        }
    }

    // Try invocation field in metadata for plugin-style calls
    if let Some(invoc) = metadata.get("invocation") {
        if let (Some(name), Some(args_val)) = (
            invoc.get("name").and_then(|v| v.as_str()),
            invoc.get("arguments"),
        ) {
            let args_str = if let Some(s) = args_val.as_str() {
                s.to_string()
            } else {
                serde_json::to_string(args_val).unwrap_or_default()
            };
            return Some((name.to_string(), args_str));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::build_payload;
    use crate::providers::ChatMessage;

    #[test]
    fn build_payload_uses_supplied_parent_message_id() {
        let payload = build_payload(
            &[ChatMessage {
                role: "user".into(),
                content: "hello".into(),
                tool_call_id: None,
            }],
            "gpt-5-5",
            Some("conv-123"),
            Some("parent-456"),
        );

        assert_eq!(payload.get("conversation_id").and_then(|v| v.as_str()), Some("conv-123"));
        assert_eq!(payload.get("parent_message_id").and_then(|v| v.as_str()), Some("parent-456"));
    }
}
// ---------------------------------------------------------------------------
// Model normalization
// ---------------------------------------------------------------------------

fn normalize_chatgpt_models(payload: &Value) -> Vec<ModelInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();

    if let Some(items) = payload.get("models").and_then(|m| m.as_array()) {
        for item in items {
            let id = item.get("slug").and_then(|v| v.as_str()).unwrap_or("").trim();
            if id.is_empty() || seen.contains(id) { continue; }
            seen.insert(id.to_string());
            let name = item.get("title").or_else(|| item.get("name"))
                .and_then(|v| v.as_str()).map(|s| s.trim())
                .filter(|s| !s.is_empty()).unwrap_or(id).to_string();
            models.push(ModelInfo {
                id: id.to_string(),
                name,
                provider: "chatgpt".into(),
                provider_model: None,
            });
        }
    }

    models
}
