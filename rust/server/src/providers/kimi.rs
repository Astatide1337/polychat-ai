//! Kimi provider — cookie-backed, no browser at runtime.
//!
//! Targets `https://www.kimi.com` with kimi-auth cookie.
//! Auth: `kimi-auth` cookie on `www.kimi.com` domain.
//! Runtime:
//! - POST /api/chat (create conversation)
//! - POST /api/chat/{id}/completion/stream (SSE streaming)
//! - POST /apiv2/kimi.gateway.chat.v1.ChatService/ListChats (v2 Connect RPC)
use anyhow::{bail, Context};
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, COOKIE, USER_AGENT};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::providers::*;
use crate::session::load_session;
use super::ReceiverStream;

const BASE_URL: &str = "https://www.kimi.com";

const USER_AGENT_STR: &str =
    "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0";
const NEW_CONVERSATION_TITLE: &str = "New conversation";

// ---------------------------------------------------------------------------
// Auth extraction
// ---------------------------------------------------------------------------

/// Extract the kimi-auth cookie value from a session JSON.
fn extract_kimi_auth(session: &Value) -> Option<String> {
    let cookies = session.get("cookies")?.as_array()?;
    cookies.iter().find_map(|c| {
        let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let domain = c.get("domain").and_then(|d| d.as_str()).unwrap_or("");
        let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
        if name == "kimi-auth"
            && (domain.contains("kimi") || domain.contains("moonshot"))
            && value.len() > 100
        {
            Some(value.to_string())
        } else {
            None
        }
    })
}

// ---------------------------------------------------------------------------
// Device ID generation
// ---------------------------------------------------------------------------

fn generate_device_id() -> String {
    let n = rand::random::<u64>() % 9_000_000_000_000_000 + 1_000_000_000_000_000;
    n.to_string()
}

fn latest_user_prompt(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default()
}

fn kimi_error_snippet(text: &str) -> &str {
    &text[..text.len().min(200)]
}

// ---------------------------------------------------------------------------
// Header builder
// ---------------------------------------------------------------------------

fn base_headers(cookie_value: &str, device_id: &str) -> HeaderMap {
    let cookie_header = format!("kimi-auth={}", cookie_value);
    let bearer = format!("Bearer {}", cookie_value);

    let mut headers = HeaderMap::new();
    headers.insert(
        COOKIE,
        HeaderValue::from_str(&cookie_header).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&bearer).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_STR));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "x-msh-device-id",
        HeaderValue::from_str(device_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    headers.insert("x-msh-platform", HeaderValue::from_static("web"));
    headers.insert(
        "x-traffic-id",
        HeaderValue::from_str(device_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    headers
}

// ---------------------------------------------------------------------------
// Kimi provider
// ---------------------------------------------------------------------------

pub struct KimiProvider {
    client: reqwest::Client,
}

impl KimiProvider {
    pub fn new() -> Self {
        KimiProvider {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("building reqwest client"),
        }
    }

    async fn get_auth(&self) -> anyhow::Result<String> {
        let session = load_session("kimi")?;
        extract_kimi_auth(&session).context("kimi session has no valid kimi-auth cookie")
    }

    async fn auth_headers(&self) -> anyhow::Result<HeaderMap> {
        let auth = self.get_auth().await?;
        let device_id = generate_device_id();
        Ok(base_headers(&auth, &device_id))
    }

    async fn stream_headers(&self) -> anyhow::Result<HeaderMap> {
        let mut headers = self.auth_headers().await?;
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        Ok(headers)
    }
}

#[async_trait]
impl Provider for KimiProvider {
    fn id(&self) -> &'static str {
        "kimi"
    }

    fn name(&self) -> &'static str {
        "Kimi"
    }

    fn tool_call_strategy(&self) -> ToolCallStrategy { ToolCallStrategy::Emulated }

    async fn validate_session(&self) -> bool {
        let headers = match self.auth_headers().await {
            Ok(headers) => headers,
            Err(_) => return false,
        };
        let res = self
            .client
            .get(format!("{}/api/user", BASE_URL))
            .headers(headers)
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await;
        matches!(res, Ok(r) if r.status().is_success())
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        Ok(vec![
            ModelInfo {
                id: "kimi".into(),
                name: "Kimi".into(),
                provider: "kimi".into(),
                provider_model: None,
                capabilities: None,
            },
            ModelInfo {
                id: "k1".into(),
                name: "Kimi K1".into(),
                provider: "kimi".into(),
                provider_model: None,
                capabilities: None,
            },
            ModelInfo {
                id: "k1.5".into(),
                name: "Kimi K1.5".into(),
                provider: "kimi".into(),
                provider_model: None,
                capabilities: None,
            },
            ModelInfo {
                id: "k1.5-thinking".into(),
                name: "Kimi K1.5 Thinking".into(),
                provider: "kimi".into(),
                provider_model: None,
                capabilities: None,
            },
            ModelInfo {
                id: "k2".into(),
                name: "Kimi K2".into(),
                provider: "kimi".into(),
                provider_model: None,
                capabilities: None,
            },
        ])
    }

    async fn list_conversations(&self) -> anyhow::Result<Vec<ProviderConversation>> {
        let mut headers = self.auth_headers().await?;
        headers.insert("Connect-Protocol-Version", HeaderValue::from_static("1"));

        let body = json!({ "page_size": 50, "page_token": "" });
        let url = format!(
            "{}/apiv2/kimi.gateway.chat.v1.ChatService/ListChats",
            BASE_URL
        );

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .context("Kimi ListChats request")?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            bail!("Kimi ListChats failed: {} {}", status, kimi_error_snippet(&text));
        }

        let data: Value = res.json().await.context("parsing Kimi ListChats response")?;
        let chats = data.get("chats").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        let conversations = chats
            .iter()
            .filter_map(|c| {
                let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if id.is_empty() {
                    return None;
                }
                let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").trim().to_string();
                let updated_at = c.get("updateTime")
                    .or_else(|| c.get("createTime"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let url = format!("https://www.kimi.com/chat/{}", id);

                Some(ProviderConversation {
                    id,
                    provider: "kimi".into(),
                    title: name,
                    model_id: None,
                    updated_at,
                    url: Some(url),
                    provider_debug: None,
                })
            })
            .collect();

        Ok(conversations)
    }

    async fn create_conversation(&self, _model: &str) -> anyhow::Result<ProviderConversation> {
        let headers = self.auth_headers().await?;
        let body = json!({
            "name": NEW_CONVERSATION_TITLE,
            "born_from": "home",
            "kimiplus_id": "kimi",
            "is_example": false,
            "source": "web",
            "tags": []
        });

        let res = self
            .client
            .post(format!("{}/api/chat", BASE_URL))
            .headers(headers)
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("creating Kimi conversation")?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            bail!(
                "Kimi create conversation failed: {} {}",
                status,
                kimi_error_snippet(&text)
            );
        }

        let body: Value = res.json().await.context("parsing Kimi create conversation response")?;
        let id = body
            .get("id")
            .and_then(|v| v.as_str())
            .context("Kimi create conversation: missing id in response")?
            .to_string();

        Ok(ProviderConversation {
            id,
            provider: "kimi".into(),
            title: NEW_CONVERSATION_TITLE.into(),
            model_id: None,
            updated_at: None,
            url: None,
            provider_debug: None,
        })
    }

    async fn send_message(
        &self,
        messages: &[ChatMessage],
        model: &str,
        _options: &ChatOptions,
        conversation_id: Option<&str>,
    ) -> anyhow::Result<ProviderResponse> {
        let conv_id = if let Some(id) = conversation_id {
            id.to_string()
        } else {
            let conv = self.create_conversation(model).await?;
            conv.id
        };

        let prompt = latest_user_prompt(messages);
        let body = json!({
            "kimiplus_id": "kimi",
            "extend": {"sidebar": true},
            "model": if model.is_empty() { "kimi" } else { model },
            "use_search": false,
            "messages": [{"role": "user", "content": prompt}],
            "refs": [],
            "history": [],
            "scene_labels": [],
            "use_semantic_memory": false,
            "use_deep_research": false
        });

        let url = format!("{}/api/chat/{}/completion/stream", BASE_URL, conv_id);
        let headers = self.stream_headers().await?;

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .context("Kimi completion request")?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            bail!(
                "Kimi completion failed: {} {}",
                status,
                kimi_error_snippet(&text)
            );
        }

        Ok(ProviderResponse {
            stream: stream_kimi_chunks(res),
            conversation_id: Some(conv_id),
        })
    }
}

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

fn stream_kimi_chunks(response: reqwest::Response) -> ChunkStream {
    let (tx, rx) = mpsc::channel::<anyhow::Result<ChatChunk>>(256);

    tokio::spawn(async move {
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();

        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx
                        .send(Err(anyhow::anyhow!("Kimi stream error: {}", e)))
                        .await;
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // SSE is newline-delimited; process complete lines
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].to_string();
                buffer = buffer[pos + 1..].to_string();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                // SSE format: "data: <json>"
                let json_str = if let Some(rest) = trimmed.strip_prefix("data: ") {
                    rest
                } else {
                    // Ignore non-data lines (event:, id:, etc.)
                    continue;
                };

                let json: Value = match serde_json::from_str(json_str) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let event = json.get("event").and_then(|e| e.as_str()).unwrap_or("");

                match event {
                    "cmpl" => {
                        // Skip trailing cmpl after done (loading:false, empty text)
                        let loading = json.get("loading").and_then(|v| v.as_bool());
                        if loading == Some(false) {
                            continue;
                        }
                        if let Some(text) = json.get("text").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                let _ = tx.send(Ok(ChatChunk::Content(text.to_string()))).await;
                            }
                        }
                    }
                    "done" => return,
                    "error" => {
                        let msg = json
                            .get("text")
                            .or_else(|| json.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown error");
                        let _ = tx
                            .send(Err(anyhow::anyhow!("Kimi API error: {}", msg)))
                            .await;
                        return;
                    }
                    // ping, req, resp, rename, loading, zone_set — ignore
                    _ => {}
                }
            }
        }
    });

    Box::pin(ReceiverStream::new(rx))
}
