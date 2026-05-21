//! Gemini provider — cookie-backed, no browser at runtime.
//!
//! Login: CDP browser at gemini.google.com — captures Google session cookies.
//! Runtime: Gemini web API (BardChatUi StreamGenerate) with SNlM0e access token.
//!
//! Auth flow (per gemini-webapi library):
//! 1. GET https://gemini.google.com/app with session cookies → extract SNlM0e, build_label, f.sid
//! 2. POST StreamGenerate with f.req=[null, json(inner_req_list)] and at=SNlM0e
//!
//! Conversation continuity:
//! - Gemini conversations are identified by metadata (cid, rid, rcid) stored in inner_req_list[2].
//! - The response contains updated metadata at inner[1] of the parsed response JSON.
//! - We encode the full metadata array as a JSON string for the conversation_id field,
//!   so that subsequent requests can pass it back as inner[2] to continue the conversation.
//!
//! Temporary chat:
//! - Setting inner_req_list[45] = 1 prevents the conversation from being saved to history.

use anyhow::{bail, Context};
use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, COOKIE, ORIGIN, REFERER, USER_AGENT};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use std::time::Duration;

use crate::session::load_session;
use super::{ChatMessage, ChatOptions, ChatChunk, ModelInfo, ProviderConversation, ChunkStream, ProviderResponse, Provider, ToolCallStrategy};
use super::ReceiverStream;

// ---------------------------------------------------------------------------
// Known Gemini models
// ---------------------------------------------------------------------------

const KNOWN_GEMINI_MODELS: &[(&str, &str)] = &[
    ("gemini-3.1-pro", "Gemini 3.1 Pro"),
    ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"),
    ("gemini-3-flash", "Gemini 3 Flash"),
    ("gemini-3-pro", "Gemini 3 Pro"),
    ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash"),
];

/// Index in inner_req_list for the temporary chat flag.
const TEMPORARY_CHAT_FLAG_INDEX: usize = 45;

/// Default metadata for a new conversation (empty strings/nulls).
fn default_metadata() -> Value {
    json!(["", "", "", Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, ""])
}

// ---------------------------------------------------------------------------
// Auth state extracted from the Gemini app page
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct GeminiSession {
    cookie_header: String,
    access_token: String, // SNlM0e
    build_label: String,  // boq_... label
    session_id: String,   // f.sid
}

// ---------------------------------------------------------------------------
// Cookie extraction
// ---------------------------------------------------------------------------

fn extract_cookie_header(session: &Value) -> anyhow::Result<String> {
    let cookies = session
        .get("cookies")
        .and_then(|c| c.as_array())
        .context("Gemini session missing cookies array")?;

    Ok(cookies
        .iter()
        .filter_map(|c| {
            let domain = c.get("domain").and_then(|d| d.as_str()).unwrap_or("");
            if domain.contains("google.com") {
                let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
                if !value.is_empty() && !name.is_empty() {
                    return Some(format!("{}={}", name, value));
                }
            }
            None
        })
        .collect::<Vec<_>>()
        .join("; "))
}

// ---------------------------------------------------------------------------
// Extract SNlM0e, build label, session ID from Gemini app page HTML
// ---------------------------------------------------------------------------

fn extract_gemini_tokens(html: &str) -> (String, String, String) {
    // SNlM0e access token — appears as "SNlM0e":"<value>"
    let access_token = {
        let needle = "\"SNlM0e\":\"";
        if let Some(start) = html.find(needle) {
            let rest = &html[start + needle.len()..];
            if let Some(end) = rest.find('"') {
                rest[..end].to_string()
            } else { String::new() }
        } else { String::new() }
    };

    // Build label — appears as "cfb2h":"boq_..." or query param bl=boq_...
    let build_label = {
        let needle = "\"cfb2h\":\"";
        if let Some(start) = html.find(needle) {
            let rest = &html[start + needle.len()..];
            if let Some(end) = rest.find('"') {
                rest[..end].to_string()
            } else { String::new() }
        } else {
            // fallback: static label that generally works
            "boq_assistant-bard-web-server_20240717.22_p0".to_string()
        }
    };

    // Session ID f.sid
    let session_id = {
        let needle = "\"FdrFJe\":\"";
        if let Some(start) = html.find(needle) {
            let rest = &html[start + needle.len()..];
            if let Some(end) = rest.find('"') {
                rest[..end].to_string()
            } else { String::new() }
        } else { String::new() }
    };

    (access_token, build_label, session_id)
}

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

pub struct GeminiProvider {
    client: reqwest::Client,
}

impl GeminiProvider {
    pub fn new() -> Self {
        GeminiProvider {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("building reqwest client"),
        }
    }

    async fn get_session(&self) -> anyhow::Result<GeminiSession> {
        let session = load_session("gemini")?;
        let cookie_header = extract_cookie_header(&session)?;

        if cookie_header.is_empty() {
            bail!("Gemini session has no cookies — run polychat login gemini");
        }

        // Fetch the Gemini app page to get SNlM0e, build_label, session_id
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_str(&cookie_header)
            .unwrap_or_else(|_| HeaderValue::from_static("")));
        headers.insert(USER_AGENT, HeaderValue::from_static(
            "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0"
        ));
        headers.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"));

        let res = self.client
            .get("https://gemini.google.com/app")
            .headers(headers)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("fetching Gemini app page")?;

        if !res.status().is_success() {
            bail!("Gemini app page returned {}", res.status());
        }

        let html = res.text().await.context("reading Gemini app page body")?;
        let (access_token, build_label, session_id) = extract_gemini_tokens(&html);

        if access_token.is_empty() {
            bail!("Could not extract SNlM0e token from Gemini page — session may be expired");
        }

        Ok(GeminiSession { cookie_header, access_token, build_label, session_id })
    }

    fn build_request_headers(sess: &GeminiSession) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_str(&sess.cookie_header)
            .unwrap_or_else(|_| HeaderValue::from_static("")));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(
            "application/x-www-form-urlencoded;charset=utf-8"
        ));
        headers.insert(ORIGIN, HeaderValue::from_static("https://gemini.google.com"));
        headers.insert(REFERER, HeaderValue::from_static("https://gemini.google.com/"));
        headers.insert(USER_AGENT, HeaderValue::from_static(
            "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0"
        ));
        headers.insert("X-Same-Domain", HeaderValue::from_static("1"));
        headers.insert("x-goog-ext-73010989-jspb", HeaderValue::from_static("[0]"));
        // Default model header — uses unspecified/flash
        headers.insert("x-goog-ext-525001261-jspb",
            HeaderValue::from_static("[1,null,null,null,null,null,null,null,[4]]"));
        headers
    }

    /// Build the f.req body for StreamGenerate.
    ///
    /// `metadata` is the conversation metadata array to place at inner[2].
    /// For a new conversation, pass `None` (uses default empty metadata).
    /// For continuing a conversation, pass the metadata array from the previous response.
    ///
    /// `temporary` sets inner[45] = 1 to prevent the conversation from being saved.
    fn build_f_req(prompt: &str, metadata: Option<Value>, temporary: bool) -> anyhow::Result<String> {
        // inner_req_list is a 69-element array matching the gemini-webapi library format
        let mut inner: Vec<Value> = vec![Value::Null; 69];

        // [0]: message content = [prompt, 0, null, null, null, null, 0]
        inner[0] = json!([prompt, 0, Value::Null, Value::Null, Value::Null, Value::Null, 0]);
        // [1]: language
        inner[1] = json!(["en"]);
        // [2]: conversation metadata — either default (new) or from previous response (continue)
        inner[2] = metadata.unwrap_or_else(default_metadata);
        // [6]: [1]
        inner[6] = json!([1]);
        // [7]: streaming flag
        inner[7] = json!(1);
        // [10]: 1
        inner[10] = json!(1);
        // [11]: 0
        inner[11] = json!(0);
        // [17]: [[0]]
        inner[17] = json!([[0]]);
        // [18]: 0
        inner[18] = json!(0);
        // [27]: 1
        inner[27] = json!(1);
        // [30]: [4]
        inner[30] = json!([4]);
        // [41]: [1]
        inner[41] = json!([1]);
        // [45]: temporary chat flag — 1 = don't save to history
        if temporary {
            inner[TEMPORARY_CHAT_FLAG_INDEX] = json!(1);
        }
        // [53]: 0
        inner[53] = json!(0);
        // [59]: UUID
        inner[59] = json!(uuid::Uuid::new_v4().to_string().to_uppercase());
        // [61]: []
        inner[61] = json!([]);
        // [68]: 2
        inner[68] = json!(2);

        let inner_json = serde_json::to_string(&inner)?;
        let outer = serde_json::to_string(&json!([Value::Null, inner_json]))?;
        Ok(outer)
    }

    /// Parse a conversation_id string back into a metadata Value for inner[2].
    ///
    /// The conversation_id is a JSON-serialized array (e.g. `["c_abc","rid123",...,""]`).
    /// If parsing fails, returns None (will use default metadata = new conversation).
    fn parse_conversation_metadata(conversation_id: &str) -> Option<Value> {
        serde_json::from_str::<Value>(conversation_id).ok().filter(|v| v.is_array())
    }

    /// Build the URL for a BardChatUi RPC call.
    fn build_bard_url(sess: &GeminiSession, rpc_path: &str) -> String {
        let mut url = format!(
            "https://gemini.google.com/_/BardChatUi/data/{}?hl=en&rt=c",
            rpc_path
        );
        if !sess.build_label.is_empty() {
            url.push_str(&format!("&bl={}", urlencoding::encode(&sess.build_label)));
        }
        if !sess.session_id.is_empty() {
            url.push_str(&format!("&f.sid={}", urlencoding::encode(&sess.session_id)));
        }
        url.push_str(&format!("&_reqid={}", rand_reqid()));
        url
    }

    /// List conversations via the batchexecute RPC endpoint.
    ///
    /// Uses rpcid "MaZiqc" (GRPC.LIST_CHATS) to fetch both pinned and unpinned chats.
    async fn list_conversations_impl(&self) -> anyhow::Result<Vec<ProviderConversation>> {
        let sess = self.get_session().await?;
        let headers = Self::build_request_headers(&sess);

        // Fetch pinned and unpinned chats in parallel
        let (pinned_res, unpinned_res) = tokio::join!(
            self.fetch_chat_list(&sess, &headers, true),
            self.fetch_chat_list(&sess, &headers, false),
        );

        let pinned = pinned_res.unwrap_or_default();
        let unpinned = unpinned_res.unwrap_or_default();

        let mut conversations = Vec::new();
        for chat in pinned.into_iter().chain(unpinned.into_iter()) {
            conversations.push(chat);
        }

        Ok(conversations)
    }

    /// Fetch a single page of chat list (pinned or unpinned) via batchexecute.
    async fn fetch_chat_list(
        &self,
        sess: &GeminiSession,
        headers: &HeaderMap,
        pinned: bool,
    ) -> anyhow::Result<Vec<ProviderConversation>> {
        // Payload: [13, null, [pinned_flag, null, 1]]
        let pin_flag = if pinned { 1 } else { 0 };
        let payload = json!([13, Value::Null, [pin_flag, Value::Null, 1]]);
        let payload_str = serde_json::to_string(&payload)?;

        // batchexecute body format (matching Python gemini-webapi library):
        // RPCData.serialize() returns [rpcid, payload, null, identifier] (4 elements)
        // f.req is double-nested: [[serialized_payload, ...]]
        let freq_inner = json!(["MaZiqc", payload_str, Value::Null, "generic"]);
        let freq = serde_json::to_string(&json!([[freq_inner]]))?;

        // batchexecute URL requires rpcids and source-path query params
        let mut url = format!(
            "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&hl=en&rt=c&source-path=%2Fapp"
        );
        if !sess.build_label.is_empty() {
            url.push_str(&format!("&bl={}", urlencoding::encode(&sess.build_label)));
        }
        if !sess.session_id.is_empty() {
            url.push_str(&format!("&f.sid={}", urlencoding::encode(&sess.session_id)));
        }
        url.push_str(&format!("&_reqid={}", rand_reqid()));

        let body_params = format!(
            "at={}&f.req={}",
            urlencoding::encode(&sess.access_token),
            urlencoding::encode(&freq)
        );

        let res = self.client
            .post(&url)
            .headers(headers.clone())
            .body(body_params)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("Gemini batchexecute request")?;

        if !res.status().is_success() {
            bail!("Gemini batchexecute returned {}", res.status());
        }

        let body = res.text().await.context("reading batchexecute response")?;
        parse_chat_list(&body)
    }
}

// ---------------------------------------------------------------------------
// Parse chat list from batchexecute response
// ---------------------------------------------------------------------------

fn parse_chat_list(body: &str) -> anyhow::Result<Vec<ProviderConversation>> {
    let mut conversations = Vec::new();
    let mut seen_cids = std::collections::HashSet::new();

    // batchexecute response format is the same line-delimited JSON as StreamGenerate:
    // )]}'\n<size>\n[json_array]\n...
    //
    // Each JSON line is an array of "parts". Each part: ["wrb.fr", "MaZiqc", json_string, ...]
    // The json_string at index 2 is a JSON-encoded array containing the chat data.
    // Following the Python gemini-webapi library:
    //   part_body = JSON.parse(part[2])
    //   chat_list = part_body[2]  (array of chat entries)
    //   Each chat_data: [cid, title, is_pinned, ..., timestamp_data]
    //     chat_data[0] = cid (string starting with "c_")
    //     chat_data[1] = title (string)
    //     chat_data[2] = is_pinned (bool/int)
    //     chat_data[5] = timestamp_data = [seconds, nanos]
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed == ")]}'" || trimmed.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        if let Ok(parts) = serde_json::from_str::<Vec<Value>>(trimmed) {
            // Each element in the outer array is a "part"
            for part in &parts {
                let part_arr = match part.as_array() {
                    Some(a) => a,
                    None => continue,
                };
                // part[2] is the JSON string containing the response body
                let part_body_str = match part_arr.get(2).and_then(|v| v.as_str()) {
                    Some(s) => s,
                    None => continue,
                };
                let part_body = match serde_json::from_str::<Vec<Value>>(part_body_str) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // part_body[2] is the chat list array
                let chat_list = match part_body.get(2).and_then(|v| v.as_array()) {
                    Some(a) => a,
                    None => continue,
                };
                for chat_data in chat_list {
                    let chat_arr = match chat_data.as_array() {
                        Some(a) if a.len() > 1 => a,
                        _ => continue,
                    };
                    // chat_data[0] = cid
                    let cid = match chat_arr.first().and_then(|v| v.as_str()) {
                        Some(s) if !s.is_empty() => s.to_string(),
                        _ => continue,
                    };
                    // Deduplicate across pinned/unpinned responses
                    if !seen_cids.insert(cid.clone()) {
                        continue;
                    }
                    // chat_data[1] = title
                    let title = chat_arr.get(1)
                        .and_then(|v| v.as_str())
                        .unwrap_or("Untitled")
                        .to_string();
                    // chat_data[5] = timestamp_data = [seconds, nanos]
                    let updated_at = chat_arr.get(5)
                        .and_then(|v| v.as_array())
                        .and_then(|ts| {
                            let secs = ts.get(0).and_then(|v| v.as_i64()).unwrap_or(0);
                            let nanos = ts.get(1).and_then(|v| v.as_i64()).unwrap_or(0);
                            chrono::DateTime::from_timestamp(secs, nanos as u32)
                                .map(|dt| dt.to_rfc3339())
                        });

                    conversations.push(ProviderConversation {
                        id: cid,
                        provider: "gemini".into(),
                        title,
                        model_id: None,
                        updated_at,
                        url: None,
                        provider_debug: None,
                    });
                }
            }
        }
    }

    Ok(conversations)
}

// ---------------------------------------------------------------------------
// Provider trait implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl Provider for GeminiProvider {
    fn id(&self) -> &'static str { "gemini" }
    fn name(&self) -> &'static str { "Gemini" }
    fn tool_call_strategy(&self) -> ToolCallStrategy { ToolCallStrategy::Emulated }

    async fn validate_session(&self) -> bool {
        // Check if session has valid Google cookies
        let session = match load_session("gemini") {
            Ok(s) => s,
            Err(_) => return false,
        };
        let cookies = session.get("cookies").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        cookies.iter().any(|c| {
            let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
            (name == "COMPASS" || name == "__Secure-1PSID" || name == "SID") && value.len() > 10
        })
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        Ok(KNOWN_GEMINI_MODELS.iter().map(|&(id, name)| ModelInfo {
            id: id.into(), name: name.into(), provider: "gemini".into(), provider_model: None, capabilities: None,
        }).collect())
    }

    async fn list_conversations(&self) -> anyhow::Result<Vec<ProviderConversation>> {
        self.list_conversations_impl().await
    }

    async fn create_conversation(&self, _model: &str) -> anyhow::Result<ProviderConversation> {
        // Gemini does not support pre-creating conversations.
        // A real conversation ID is only available after the first message is sent.
        Ok(ProviderConversation {
            id: String::new(), provider: "gemini".into(), title: "New conversation".into(),
            model_id: None, updated_at: None, url: None, provider_debug: None,
        })
    }

    async fn send_message(
        &self,
        messages: &[ChatMessage],
        _model: &str,
        options: &ChatOptions,
        conversation_id: Option<&str>,
    ) -> anyhow::Result<ProviderResponse> {
        let sess = self.get_session().await?;
        let headers = Self::build_request_headers(&sess);

        // Build the prompt from all messages
        let prompt = messages.iter()
            .map(|m| format!("{}: {}", m.role.to_uppercase(), m.content))
            .collect::<Vec<_>>()
            .join("\n\n");

        // Parse conversation metadata from the conversation_id if provided
        let metadata = conversation_id.and_then(Self::parse_conversation_metadata);

        let f_req = Self::build_f_req(&prompt, metadata, options.temporary)?;

        // URL params
        let url = Self::build_bard_url(&sess, "assistant.lamda.BardFrontendService/StreamGenerate");

        // Body: application/x-www-form-urlencoded
        let body_params = format!(
            "at={}&f.req={}",
            urlencoding::encode(&sess.access_token),
            urlencoding::encode(&f_req)
        );

        let res = self.client
            .post(&url)
            .headers(headers)
            .body(body_params)
            .send()
            .await
            .context("Gemini StreamGenerate request")?;

        if !res.status().is_success() {
            let status = res.status();
            let body_text = res.text().await.unwrap_or_default();
            bail!("Gemini StreamGenerate failed: {} {}", status, &body_text[..body_text.len().min(200)]);
        }

        // Capture conversation metadata from the first response chunk via oneshot channel.
        // Same pattern as ChatGPT's conversation_id capture.
        let (meta_tx, mut meta_rx) = oneshot::channel::<String>();
        let stream = stream_gemini_chunks(res, Some(meta_tx));

        // Wait up to 2 seconds for the metadata to arrive from the first chunk
        let captured_metadata = tokio::time::timeout(Duration::from_secs(2), &mut meta_rx)
            .await
            .ok()
            .and_then(|r| r.ok());

        // The conversation_id is the JSON-serialized metadata array.
        // If we captured it, use it. If a conversation_id was already provided, keep it.
        // Otherwise, None (the ConversationTracker won't track it).
        let final_conversation_id = captured_metadata
            .or_else(|| conversation_id.map(|s| s.to_string()));

        Ok(ProviderResponse {
            stream,
            conversation_id: final_conversation_id,
        })
    }
}

fn rand_reqid() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_micros();
    100000 + (t as u64 % 900000)
}

// ---------------------------------------------------------------------------
// Stream parser for Gemini BardChatUi format
// ---------------------------------------------------------------------------

/// Parse a single Gemini response line and extract:
/// 1. Text content (at inner[4][0][1][0])
/// 2. Conversation metadata (at inner[1])
///
/// Returns (text_content, metadata_json_string).
fn parse_gemini_response_line(arr: &[Value]) -> (Option<String>, Option<String>) {
    // Gemini response format: outer array where arr[0][2] contains the chat response
    // Structure: [["wrb.fr", "fbmAGb", json_string, ...], ...]
    let inner_str = match arr.get(0)
        .and_then(|a| a.as_array())
        .and_then(|a| a.get(2))
        .and_then(|v| v.as_str())
    {
        Some(s) => s,
        None => return (None, None),
    };

    let inner = match serde_json::from_str::<Vec<Value>>(inner_str) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };

    // Extract text content at inner[4][0][1][0]
    let text = inner.get(4)
        .and_then(|v| v.as_array())
        .and_then(|a| a.get(0))
        .and_then(|v| v.as_array())
        .and_then(|a| a.get(1))
        .and_then(|v| v.as_array())
        .and_then(|a| a.get(0))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Extract conversation metadata at inner[1]
    // metadata[0] = cid, metadata[1] = rid, etc.
    let metadata = inner.get(1)
        .filter(|v| v.is_array())
        .and_then(|v| {
            // Only emit metadata if it contains a valid cid (starts with "c_")
            let cid = v.as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if cid.starts_with("c_") {
                Some(serde_json::to_string(v).unwrap_or_default())
            } else {
                None
            }
        });

    (text, metadata)
}

fn stream_gemini_chunks(
    response: reqwest::Response,
    meta_tx: Option<oneshot::Sender<String>>,
) -> ChunkStream {
    let (tx, rx) = mpsc::channel::<anyhow::Result<ChatChunk>>(256);

    tokio::spawn(async move {
        // Gemini StreamGenerate returns line-delimited JSON chunks, NOT SSE format.
        // Each chunk is a self-contained JSON array line.
        // Response looks like:
        // )]}'\n\n<number>\n[json_array]\n<number>\n[json_array]\n...
        // The text content is nested inside the JSON at specific positions.
        //
        // Gemini sends the full accumulated text in each chunk (not just deltas),
        // so we track sent_length and only emit the new portion.
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
        let mut meta_tx = meta_tx; // Take ownership so we can send once
        let mut sent_length: usize = 0;
        use futures::StreamExt;

        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Err(anyhow::anyhow!("Gemini stream error: {}", e))).await;
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Process line by line
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].to_string();
                buffer = buffer[pos + 1..].to_string();

                let trimmed = line.trim();
                // Skip preamble, sizes, etc.
                if trimmed.is_empty() || trimmed == ")]}'" || trimmed.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                // Try to parse as JSON array
                if let Ok(arr) = serde_json::from_str::<Vec<Value>>(trimmed) {
                    let (text, metadata) = parse_gemini_response_line(&arr);

                    // Send conversation metadata via oneshot (one-shot, first chunk only)
                    if let Some(meta_json) = metadata {
                        if let Some(tx) = meta_tx.take() {
                            let _ = tx.send(meta_json);
                        }
                    }

                    // Send text content — only the delta since last send
                    if let Some(text) = text {
                        if text.len() > sent_length {
                            let delta = text[sent_length..].to_string();
                            if !delta.is_empty() {
                                let _ = tx.send(Ok(ChatChunk::Content(delta))).await;
                            }
                            sent_length = text.len();
                        }
                    }
                }
            }
        }

        // If we never captured metadata, drop the oneshot sender so the receiver
        // gets a RecvError instead of hanging.
        drop(meta_tx);
    });

    Box::pin(ReceiverStream::new(rx))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_metadata_structure() {
        let meta = default_metadata();
        let arr = meta.as_array().unwrap();
        assert_eq!(arr.len(), 10);
        assert_eq!(arr[0], Value::String(String::new()));
        assert_eq!(arr[3], Value::Null);
    }

    #[test]
    fn test_build_f_req_new_conversation() {
        let result = GeminiProvider::build_f_req("hello", None, false).unwrap();
        // Should be valid JSON
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert!(parsed.is_array());
        // outer[1] is the inner JSON string
        let inner_str = parsed.as_array().unwrap()[1].as_str().unwrap();
        let inner: Vec<Value> = serde_json::from_str(inner_str).unwrap();
        // inner[2] should be default metadata
        assert!(inner[2].is_array());
        assert_eq!(inner[2].as_array().unwrap()[0], Value::String(String::new()));
        // inner[45] should be Null (not temporary)
        assert!(inner[TEMPORARY_CHAT_FLAG_INDEX].is_null());
    }

    #[test]
    fn test_build_f_req_temporary() {
        let result = GeminiProvider::build_f_req("hello", None, true).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        let inner_str = parsed.as_array().unwrap()[1].as_str().unwrap();
        let inner: Vec<Value> = serde_json::from_str(inner_str).unwrap();
        // inner[45] should be 1 (temporary)
        assert_eq!(inner[TEMPORARY_CHAT_FLAG_INDEX], json!(1));
    }

    #[test]
    fn test_build_f_req_with_metadata() {
        let metadata = json!(["c_abc123", "rid456", "rcid789", Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, ""]);
        let result = GeminiProvider::build_f_req("hello", Some(metadata.clone()), false).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        let inner_str = parsed.as_array().unwrap()[1].as_str().unwrap();
        let inner: Vec<Value> = serde_json::from_str(inner_str).unwrap();
        // inner[2] should be our metadata
        assert_eq!(inner[2], metadata);
    }

    #[test]
    fn test_parse_conversation_metadata_valid() {
        let meta = json!(["c_abc123", "rid456", "rcid789", Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, ""]);
        let meta_str = serde_json::to_string(&meta).unwrap();
        let parsed = GeminiProvider::parse_conversation_metadata(&meta_str);
        assert!(parsed.is_some());
        assert_eq!(parsed.unwrap(), meta);
    }

    #[test]
    fn test_parse_conversation_metadata_invalid() {
        assert!(GeminiProvider::parse_conversation_metadata("not json").is_none());
        assert!(GeminiProvider::parse_conversation_metadata("\"just a string\"").is_none());
        assert!(GeminiProvider::parse_conversation_metadata("42").is_none());
    }

    #[test]
    fn test_parse_gemini_response_line_with_metadata() {
        // Simulate a Gemini response with both text content and metadata
        let inner = json!([
            Value::Null,                                    // [0]
            ["c_test123", "rid456", "rcid789", Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, ""], // [1] metadata
            Value::Null,                                    // [2]
            Value::Null,                                    // [3]
            [["type", ["Hello world"]]],                    // [4] text content
        ]);
        let inner_str = serde_json::to_string(&inner).unwrap();

        let arr = json!([["wrb.fr", "fbmAGb", inner_str, Value::Null, "generic"]]);
        let (text, metadata) = parse_gemini_response_line(arr.as_array().unwrap());

        assert_eq!(text, Some("Hello world".to_string()));
        assert!(metadata.is_some());
        let meta_parsed: Value = serde_json::from_str(&metadata.unwrap()).unwrap();
        assert_eq!(meta_parsed.as_array().unwrap()[0], Value::String("c_test123".to_string()));
    }

    #[test]
    fn test_parse_gemini_response_line_no_cid() {
        // Metadata without a valid cid (doesn't start with "c_") should not be emitted
        let inner = json!([
            Value::Null,
            ["not_a_cid", "rid456"],  // [1] metadata with invalid cid
            Value::Null,
            Value::Null,
            [["type", ["Hello"]]],
        ]);
        let inner_str = serde_json::to_string(&inner).unwrap();
        let arr = json!([["wrb.fr", "fbmAGb", inner_str, Value::Null, "generic"]]);
        let (text, metadata) = parse_gemini_response_line(arr.as_array().unwrap());

        assert_eq!(text, Some("Hello".to_string()));
        assert!(metadata.is_none()); // No valid cid → no metadata
    }

    #[test]
    fn test_parse_gemini_response_line_empty_text() {
        let inner = json!([
            Value::Null,
            ["c_test123", "rid456"],
            Value::Null,
            Value::Null,
            [["type", [""]]],  // empty text
        ]);
        let inner_str = serde_json::to_string(&inner).unwrap();
        let arr = json!([["wrb.fr", "fbmAGb", inner_str, Value::Null, "generic"]]);
        let (text, _) = parse_gemini_response_line(arr.as_array().unwrap());

        assert!(text.is_none()); // Empty text should not be emitted
    }

    #[test]
    fn test_parse_gemini_response_line_malformed() {
        let arr = json!([["wrb.fr", "fbmAGb", "not valid json"]]);
        let (text, metadata) = parse_gemini_response_line(arr.as_array().unwrap());
        assert!(text.is_none());
        assert!(metadata.is_none());
    }

    #[test]
    fn test_parse_chat_list_basic() {
        // Simulate a batchexecute response with two chats
        let part_body = json!([
            Value::Null,
            Value::Null,
            [
                ["c_abc123", "My First Chat", 1, Value::Null, Value::Null, [1716200000, 0]],
                ["c_def456", "My Second Chat", 0, Value::Null, Value::Null, [1716300000, 500000000]],
            ]
        ]);
        let part_body_str = serde_json::to_string(&part_body).unwrap();
        let line = serde_json::to_string(&json!([["wrb.fr", "MaZiqc", part_body_str, Value::Null, "generic"]])).unwrap();
        let body = format!(")]}}'\n\n{}\n", line);

        let result = parse_chat_list(&body).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "c_abc123");
        assert_eq!(result[0].title, "My First Chat");
        assert!(result[0].updated_at.is_some());
        assert_eq!(result[1].id, "c_def456");
        assert_eq!(result[1].title, "My Second Chat");
    }

    #[test]
    fn test_parse_chat_list_deduplication() {
        // Same cid appearing in both pinned and unpinned responses
        let part_body = json!([Value::Null, Value::Null, [["c_dup", "Dup Chat", 1, Value::Null, Value::Null, [1716200000, 0]]]]);
        let part_body_str = serde_json::to_string(&part_body).unwrap();
        let line = serde_json::to_string(&json!([["wrb.fr", "MaZiqc", part_body_str, Value::Null, "generic"]])).unwrap();
        let body = format!(")]}}'\n\n{}\n{}\n", line, line);

        let result = parse_chat_list(&body).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "c_dup");
    }

    #[test]
    fn test_parse_chat_list_empty_cid() {
        // Chat with empty cid should be skipped
        let part_body = json!([Value::Null, Value::Null, [["", "No CID", 0, Value::Null, Value::Null, [1716200000, 0]]]]);
        let part_body_str = serde_json::to_string(&part_body).unwrap();
        let line = serde_json::to_string(&json!([["wrb.fr", "MaZiqc", part_body_str, Value::Null, "generic"]])).unwrap();
        let body = format!(")]}}'\n\n{}\n", line);

        let result = parse_chat_list(&body).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_chat_list_no_timestamp() {
        // Chat without timestamp data
        let part_body = json!([Value::Null, Value::Null, [["c_notime", "No Time Chat", 0]]]);
        let part_body_str = serde_json::to_string(&part_body).unwrap();
        let line = serde_json::to_string(&json!([["wrb.fr", "MaZiqc", part_body_str, Value::Null, "generic"]])).unwrap();
        let body = format!(")]}}'\n\n{}\n", line);

        let result = parse_chat_list(&body).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "c_notime");
        assert!(result[0].updated_at.is_none());
    }

    #[test]
    fn test_parse_chat_list_malformed() {
        let body = ")]}'\n\nnot valid json\n";
        let result = parse_chat_list(body).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_temporary_flag_index() {
        assert_eq!(TEMPORARY_CHAT_FLAG_INDEX, 45);
    }
}
