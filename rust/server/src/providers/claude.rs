//! Claude provider — cookie-backed, no browser at runtime.
//!
//! Mirrors `src/providers/claude.ts`.

use anyhow::{bail, Context};
use async_trait::async_trait;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, COOKIE, ORIGIN, REFERER, USER_AGENT,
};
use serde_json::Value;
use uuid::Uuid;

use crate::providers::*;
use crate::session::load_session;

// ---------------------------------------------------------------------------
// Known Claude models
// ---------------------------------------------------------------------------

const KNOWN_CLAUDE_MODELS: &[(&str, &str)] = &[
    ("claude-opus-4-7", "Claude Opus 4.7"),
    ("claude-opus-4-6", "Claude Opus 4.6"),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
    ("claude-sonnet-4-5", "Claude Sonnet 4.5"),
    ("claude-haiku-4-5", "Claude Haiku 4.5"),
];

// ---------------------------------------------------------------------------
// Auth extraction
// ---------------------------------------------------------------------------

struct ClaudeAuth {
    org_id: String,
    cookie_header: String,
}

fn extract_claude_auth(session: &Value) -> anyhow::Result<ClaudeAuth> {
    let cookies = session
        .get("cookies")
        .and_then(|c| c.as_array())
        .context("Claude session missing cookies array")?;

    let cookie_header: String = cookies
        .iter()
        .filter_map(|c| {
            let domain = c.get("domain").and_then(|d| d.as_str()).unwrap_or("");
            if domain.contains("claude.ai")
                || domain.contains("claude.com")
                || domain.contains("anthropic")
            {
                let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
                Some(format!("{}={}", name, value))
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("; ");

    Ok(ClaudeAuth {
        org_id: String::new(),
        cookie_header,
    })
}

fn build_claude_headers(cookie_header: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        COOKIE,
        HeaderValue::from_str(cookie_header).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
        ),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(ORIGIN, HeaderValue::from_static("https://claude.ai"));
    headers.insert(REFERER, HeaderValue::from_static("https://claude.ai/"));
    headers
}

fn format_prompt(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .map(|m| format!("{}: {}", m.role.to_uppercase(), m.content))
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ---------------------------------------------------------------------------
// Claude provider
// ---------------------------------------------------------------------------

pub struct ClaudeProvider {
    client: reqwest::Client,
}

impl ClaudeProvider {
    pub fn new() -> Self {
        ClaudeProvider {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("building reqwest client"),
        }
    }

    async fn get_auth(&self) -> anyhow::Result<ClaudeAuth> {
        let session = load_session("claude")?;
        let mut auth = extract_claude_auth(&session)?;
        if auth.cookie_header.is_empty() {
            bail!("Claude session has no cookies");
        }

        let headers = build_claude_headers(&auth.cookie_header);
        let res = self
            .client
            .get("https://claude.ai/api/organizations")
            .headers(headers)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .context("fetching Claude organizations")?;

        if !res.status().is_success() {
            bail!("Failed to load Claude organizations: {}", res.status());
        }

        let orgs: Vec<Value> = res.json().await?;
        if orgs.is_empty() {
            bail!("No Claude organizations found");
        }

        auth.org_id = orgs[0]
            .get("uuid")
            .or_else(|| orgs[0].get("id"))
            .or_else(|| orgs[0].get("org_id"))
            .and_then(|v| v.as_str())
            .context("Could not determine Claude organization id")?
            .to_string();

        Ok(auth)
    }

    async fn create_conversation_with_temporary(
        &self,
        model: &str,
        temporary: bool,
    ) -> anyhow::Result<ProviderConversation> {
        let auth = self.get_auth().await?;
        let conversation_id = Uuid::new_v4().to_string();

        let mut headers = build_claude_headers(&auth.cookie_header);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let mut body = serde_json::json!({
            "name": "",
            "model": model,
            "uuid": conversation_id,
        });
        if temporary {
            body["is_temporary"] = Value::from(true);
        }

        let res = self
            .client
            .post(&format!(
                "https://claude.ai/api/organizations/{}/chat_conversations",
                auth.org_id
            ))
            .headers(headers)
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("creating Claude conversation")?;

        if !res.status().is_success() {
            bail!("Failed to create Claude conversation: {}", res.status());
        }

        Ok(ProviderConversation {
            id: conversation_id.clone(),
            provider: "claude".into(),
            title: "New conversation".into(),
            model_id: Some(model.to_string()),
            updated_at: None,
            url: Some(format!("https://claude.ai/chat/{}", conversation_id)),
            provider_debug: None,
        })
    }
}

#[async_trait]
impl Provider for ClaudeProvider {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn name(&self) -> &'static str {
        "Claude"
    }
    fn tool_call_strategy(&self) -> ToolCallStrategy {
        ToolCallStrategy::Emulated
    }

    async fn validate_session(&self) -> bool {
        self.get_auth().await.is_ok()
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        let auth = self.get_auth().await?;
        let headers = build_claude_headers(&auth.cookie_header);

        let res = self
            .client
            .get(&format!(
                "https://claude.ai/api/organizations/{}/chat_conversations?limit=100",
                auth.org_id
            ))
            .headers(headers)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("listing Claude conversations for model discovery")?;

        if !res.status().is_success() {
            bail!("Claude conversation list request failed: {}", res.status());
        }

        let convos: Vec<Value> = res.json().await?;
        Ok(normalize_claude_models(&convos))
    }

    async fn list_conversations(&self) -> anyhow::Result<Vec<ProviderConversation>> {
        let auth = self.get_auth().await?;
        let headers = build_claude_headers(&auth.cookie_header);

        let res = self
            .client
            .get(&format!(
                "https://claude.ai/api/organizations/{}/chat_conversations",
                auth.org_id
            ))
            .headers(headers)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .context("listing Claude conversations")?;

        if !res.status().is_success() {
            return Ok(vec![]);
        }

        let payload: Vec<Value> = res.json().await?;
        let mut convos = Vec::new();
        for item in &payload {
            let id = item
                .get("uuid")
                .or_else(|| item.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                continue;
            }
            let title = item
                .get("name")
                .and_then(|v| v.as_str())
                .map(|t| t.trim())
                .filter(|t| !t.is_empty())
                .unwrap_or("Untitled conversation")
                .to_string();
            convos.push(ProviderConversation {
                id,
                provider: "claude".into(),
                title,
                model_id: item
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                updated_at: item
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                url: None,
                provider_debug: None,
            });
        }
        Ok(convos)
    }

    async fn create_conversation(&self, model: &str) -> anyhow::Result<ProviderConversation> {
        self.create_conversation_with_temporary(model, false).await
    }

    async fn send_message(
        &self,
        messages: &[ChatMessage],
        model: &str,
        options: &ChatOptions,
        conversation_id: Option<&str>,
    ) -> anyhow::Result<ProviderResponse> {
        let auth = self.get_auth().await?;

        let conv_id = if let Some(id) = conversation_id {
            id.to_string()
        } else {
            self.create_conversation_with_temporary(model, options.temporary)
                .await?
                .id
        };

        let prompt = format_prompt(messages);
        let timezone = chrono::Local::now().format("%Z").to_string();
        let locale = "en-US".to_string();

        let mut headers = build_claude_headers(&auth.cookie_header);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));

        let res = self
            .client
            .post(&format!(
                "https://claude.ai/api/organizations/{}/chat_conversations/{}/completion",
                auth.org_id, conv_id
            ))
            .headers(headers)
            .json(&serde_json::json!({
                "prompt": prompt,
                "model": model,
                "timezone": timezone,
                "locale": locale,
                "rendering_mode": "messages",
                "turn_message_uuids": {
                    "human_message_uuid": Uuid::new_v4().to_string(),
                    "assistant_message_uuid": Uuid::new_v4().to_string(),
                },
                "attachments": [],
                "files": [],
                "sync_sources": [],
            }))
            .send()
            .await
            .context("Claude completion request")?;

        if !res.status().is_success() {
            bail!("Claude completion request failed: {}", res.status());
        }

        Ok(ProviderResponse {
            stream: stream_claude_chunks(res),
            conversation_id: Some(conv_id),
        })
    }
}

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

fn stream_claude_chunks(response: reqwest::Response) -> ChunkStream {
    use crate::providers::sse::{stream_sse_response, HandlerAction};

    stream_sse_response(response, |data| {
        if let Ok(json) = serde_json::from_str::<Value>(data) {
            if let Some(obj) = json.as_object() {
                if obj.get("type").and_then(|v| v.as_str()) == Some("error") {
                    let msg = obj
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("Claude returned an error");
                    return HandlerAction::Emit(vec![Err(anyhow::anyhow!("{}", msg))]);
                }
                // message_stop = Claude's termination signal
                if obj.get("type").and_then(|v| v.as_str()) == Some("message_stop") {
                    return HandlerAction::Done;
                }
                if obj.get("type").and_then(|v| v.as_str()) == Some("content_block_delta") {
                    if let Some(delta) = obj.get("delta") {
                        let dt = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match dt {
                            "text_delta" => {
                                if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                                    return HandlerAction::Emit(vec![Ok(ChatChunk::Content(
                                        text.to_string(),
                                    ))]);
                                }
                            }
                            "thinking_delta" => {
                                if let Some(thinking) =
                                    delta.get("thinking").and_then(|v| v.as_str())
                                {
                                    return HandlerAction::Emit(vec![Ok(ChatChunk::Thinking(
                                        thinking.to_string(),
                                    ))]);
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        HandlerAction::Emit(vec![])
    })
}

// ---------------------------------------------------------------------------
// Model normalization
// ---------------------------------------------------------------------------

fn normalize_claude_models(convos: &[Value]) -> Vec<ModelInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();

    for item in convos {
        if let Some(model_id) = item.get("model").and_then(|v| v.as_str()) {
            let model_id = model_id.trim();
            if !model_id.is_empty() && !seen.contains(model_id) {
                seen.insert(model_id.to_string());
                let name = KNOWN_CLAUDE_MODELS
                    .iter()
                    .find(|(id, _)| *id == model_id)
                    .map(|(_, name)| name.to_string())
                    .unwrap_or_else(|| model_id.to_string());
                models.push(ModelInfo {
                    id: model_id.to_string(),
                    name,
                    provider: "claude".into(),
                    provider_model: None,
                    capabilities: None,
                });
            }
        }
    }

    for (id, name) in KNOWN_CLAUDE_MODELS {
        if !seen.contains(*id) {
            seen.insert(id.to_string());
            models.push(ModelInfo {
                id: id.to_string(),
                name: name.to_string(),
                provider: "claude".into(),
                provider_model: None,
                capabilities: None,
            });
        }
    }

    models
}
