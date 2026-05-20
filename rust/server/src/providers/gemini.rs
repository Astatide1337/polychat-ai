//! Gemini provider — cookie-backed, no browser at runtime.
//!
//! Login: CDP browser at gemini.google.com — captures Google session cookies.
//! Runtime: Gemini web API (BardChatUi StreamGenerate) with SNlM0e access token.
//!
//! Auth flow (per gemini-webapi library):
//!   1. GET https://gemini.google.com/app with session cookies → extract SNlM0e, build_label, f.sid
//!   2. POST StreamGenerate with f.req=[null, json(inner_req_list)] and at=SNlM0e

use anyhow::{bail, Context};
use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, COOKIE, ORIGIN, REFERER, USER_AGENT};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::session::load_session;
use super::{ChatMessage, ChatOptions, ChatChunk, ModelInfo, ProviderConversation, ChunkStream, ProviderResponse, Provider, ToolCallStrategy};
use super::ReceiverStream;

// ---------------------------------------------------------------------------
// Known Gemini models
// ---------------------------------------------------------------------------

const KNOWN_GEMINI_MODELS: &[(&str, &str)] = &[
    ("gemini-3.1-pro",        "Gemini 3.1 Pro"),
    ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"),
    ("gemini-3-flash",        "Gemini 3 Flash"),
    ("gemini-3-pro",          "Gemini 3 Pro"),
    ("gemini-2.5-pro",        "Gemini 2.5 Pro"),
    ("gemini-2.5-flash",      "Gemini 2.5 Flash"),
];

// Model IDs for the x-goog-ext-525001261-jspb header (from gemini-webapi constants)

// ---------------------------------------------------------------------------
// Auth state extracted from the Gemini app page
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct GeminiSession {
    cookie_header: String,
    access_token: String,  // SNlM0e
    build_label:  String,  // boq_... label
    session_id:   String,  // f.sid
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
        headers.insert("x-goog-ext-73010990-jspb", HeaderValue::from_static("[0]"));
        // Default model header — uses unspecified/flash
        headers.insert("x-goog-ext-525001261-jspb",
            HeaderValue::from_static("[1,null,null,null,null,null,null,null,[4]]"));
        headers
    }

    fn build_f_req(prompt: &str) -> anyhow::Result<String> {
        // inner_req_list is a 69-element array matching the gemini-webapi library format
        let mut inner: Vec<Value> = vec![Value::Null; 69];

        // [0]: message content = [prompt, 0, null, null, null, null, 0]
        inner[0] = json!([prompt, 0, Value::Null, Value::Null, Value::Null, Value::Null, 0]);
        // [1]: language
        inner[1] = json!(["en"]);
        // [2]: default metadata (empty chat)
        inner[2] = json!(["", "", "", Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, ""]);
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
}

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

    async fn list_conversations(&self) -> anyhow::Result<Vec<ProviderConversation>> { Ok(vec![]) }

    async fn create_conversation(&self, _model: &str) -> anyhow::Result<ProviderConversation> {
        Ok(ProviderConversation {
            id: String::new(), provider: "gemini".into(), title: "New conversation".into(),
            model_id: None, updated_at: None, url: None,
        })
    }

    async fn send_message(
        &self,
        messages: &[ChatMessage],
        _model: &str,
        _options: &ChatOptions,
        _conversation_id: Option<&str>,
    ) -> anyhow::Result<ProviderResponse> {
        let sess = self.get_session().await?;
        let headers = Self::build_request_headers(&sess);

        // Build the prompt from all messages
        let prompt = messages.iter()
            .map(|m| format!("{}: {}", m.role.to_uppercase(), m.content))
            .collect::<Vec<_>>()
            .join("\n\n");

        let f_req = Self::build_f_req(&prompt)?;

        // URL params
        let mut url = "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?hl=en&rt=c".to_string();
        if !sess.build_label.is_empty() {
            url.push_str(&format!("&bl={}", urlencoding::encode(&sess.build_label)));
        }
        if !sess.session_id.is_empty() {
            url.push_str(&format!("&f.sid={}", urlencoding::encode(&sess.session_id)));
        }
        url.push_str(&format!("&_reqid={}", rand_reqid()));

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

        Ok(ProviderResponse {
            stream: stream_gemini_chunks(res),
            conversation_id: None,
        })
    }
}

fn rand_reqid() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_micros();
    100000 + (t as u64 % 900000)
}

// ---------------------------------------------------------------------------
// SSE stream parser for Gemini BardChatUi format
// ---------------------------------------------------------------------------

fn stream_gemini_chunks(response: reqwest::Response) -> ChunkStream {
    let (tx, rx) = mpsc::channel::<anyhow::Result<ChatChunk>>(256);

    tokio::spawn(async move {
        // Gemini StreamGenerate returns line-delimited JSON chunks, NOT SSE format.
        // Each chunk is a self-contained JSON array line.
        // Response looks like:
        //   )]}'\n\n<number>\n[json_array]\n<number>\n[json_array]\n...
        // The text content is nested inside the JSON at specific positions.
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
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
                    // Gemini response format: outer array where inner[2] contains the chat response
                    // Structure: [["wrb.fr", "fbmAGb", json_string, ...], ...]
                    if let Some(inner_str) = arr.get(0)
                        .and_then(|a| a.as_array())
                        .and_then(|a| a.get(2))
                        .and_then(|v| v.as_str())
                    {
                        if let Ok(inner) = serde_json::from_str::<Vec<Value>>(inner_str) {
                            // Text is at inner[4][0][1][0] in Gemini response format
                            if let Some(text) = inner.get(4)
                                .and_then(|v| v.as_array())
                                .and_then(|a| a.get(0))
                                .and_then(|v| v.as_array())
                                .and_then(|a| a.get(1))
                                .and_then(|v| v.as_array())
                                .and_then(|a| a.get(0))
                                .and_then(|v| v.as_str())
                            {
                                if !text.is_empty() {
                                    let _ = tx.send(Ok(ChatChunk::Content(text.to_string()))).await;
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
