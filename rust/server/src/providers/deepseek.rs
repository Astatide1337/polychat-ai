//! DeepSeek provider — pure HTTPS, no browser needed at runtime.
//!
//! Mirrors `src/providers/deepseek.ts`.

use anyhow::{bail, Context};
use async_trait::async_trait;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, ORIGIN, REFERER, USER_AGENT,
};
use serde::Deserialize;

use crate::pow::solver::{self};
use crate::providers::*;
use crate::session::load_session;

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/// Read the DeepSeek token from the session file.
/// Supports both the direct shape `{ "userToken": "..." }` and the
/// StorageState shape with `userToken` in localStorage.
fn read_deepseek_token() -> anyhow::Result<String> {
    let raw = load_session("deepseek")?;

    // Direct shape
    if let Some(token) = raw.get("userToken").and_then(|v| v.as_str()) {
        let token = token.trim();
        if !token.is_empty() {
            return Ok(token.to_string());
        }
    }

    // StorageState shape: walk origins → localStorage → userToken
    if let Some(origins) = raw.get("origins").and_then(|o| o.as_array()) {
        for origin in origins {
            if let Some(ls) = origin.get("localStorage").and_then(|l| l.as_array()) {
                for entry in ls {
                    let name = entry.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if name.to_lowercase() == "usertoken" {
                        if let Some(value) = entry.get("value").and_then(|v| v.as_str()) {
                            // The value might be a JSON object like {"value":"actual_token"}
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value) {
                                if let Some(inner) = parsed.get("value").and_then(|v| v.as_str()) {
                                    let token = inner.trim();
                                    if !token.is_empty() {
                                        return Ok(token.to_string());
                                    }
                                }
                            }
                            // Or it might be the raw token
                            let trimmed = value.trim();
                            if trimmed.len() > 20 {
                                return Ok(trimmed.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    bail!("DeepSeek session is missing credentials. Run 'polychat login deepseek' to authenticate.")
}

// ---------------------------------------------------------------------------
// Model config from session localStorage
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DeepSeekModelConfig {
    model_type: String,
    name: Option<String>,
    enabled: Option<bool>,
}

fn read_deepseek_model_configs() -> Option<Vec<DeepSeekModelConfig>> {
    let raw = load_session("deepseek").ok()?;
    let origins = raw.get("origins")?.as_array()?;
    for origin in origins {
        if let Some(ls) = origin.get("localStorage").and_then(|l| l.as_array()) {
            for entry in ls {
                let name = entry.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name == "__polychat_deepseek_models" {
                    if let Some(value) = entry.get("value").and_then(|v| v.as_str()) {
                        if let Ok(configs) = serde_json::from_str::<Vec<DeepSeekModelConfig>>(value)
                        {
                            if !configs.is_empty() {
                                return Some(
                                    configs
                                        .into_iter()
                                        .filter(|c| c.enabled != Some(false))
                                        .collect(),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn build_base_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("x-client-platform", HeaderValue::from_static("web"));
    headers.insert("x-client-version", HeaderValue::from_static("2.0.0"));
    headers.insert("x-app-version", HeaderValue::from_static("2.0.0"));
    headers.insert("x-client-locale", HeaderValue::from_static("en_US"));
    // Timezone offset
    let offset = chrono::Local::now().offset().local_minus_utc() / 60;
    headers.insert(
        "x-client-timezone-offset",
        HeaderValue::from_str(&offset.to_string()).unwrap(),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
        ),
    );
    headers.insert(
        ORIGIN,
        HeaderValue::from_static("https://chat.deepseek.com"),
    );
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://chat.deepseek.com/"),
    );
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers
}

fn resolve_model_id(model: &str) -> String {
    let stripped = if model.starts_with("deepseek-") {
        &model["deepseek-".len()..]
    } else {
        model
    };
    match stripped {
        "chat" | "v3" | "v3-0324" | "v4" | "v4-flash" | "DEFAULT" | "r1" | "reasoner"
        | "r1-0528" | "default" => "default".into(),
        "expert" => "expert".into(),
        "vision" => "vision".into(),
        other => other.to_string(),
    }
}

fn format_last_user_message(messages: &[ChatMessage]) -> String {
    if messages.is_empty() {
        return String::new();
    }
    if messages.len() == 1 {
        return messages[0].content.clone();
    }
    let mut history = String::new();
    for m in &messages[..messages.len() - 1] {
        let role = if m.role == "user" {
            "User"
        } else {
            "Assistant"
        };
        if !history.is_empty() {
            history.push_str("\n\n");
        }
        history.push_str(&format!("{}: {}", role, m.content));
    }
    history.push_str(&format!("\n\nUser: {}", messages.last().unwrap().content));
    history
}

fn thinking_enabled_for_reasoning_effort(reasoning_effort: Option<&str>) -> bool {
    let Some(effort) = reasoning_effort.map(str::trim) else {
        return false;
    };

    if effort.is_empty() {
        return false;
    }

    !matches!(effort, "off" | "none" | "disabled" | "false")
}

fn deepseek_model_capabilities(model_id: &str) -> Option<ModelCapabilities> {
    if model_id == "deepseek-chat" || model_id == "deepseek-r1" {
        return Some(ModelCapabilities {
            reasoning: true,
            reasoning_effort: true,
            reasoning_effort_levels: vec!["off", "low", "medium", "high"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        });
    }

    None
}

// ---------------------------------------------------------------------------
// DeepSeek provider implementation
// ---------------------------------------------------------------------------

pub struct DeepSeekProvider {
    client: reqwest::Client,
}

impl DeepSeekProvider {
    pub fn new() -> Self {
        DeepSeekProvider {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("building reqwest client"),
        }
    }

    async fn create_conversation_with_temporary(
        &self,
        temporary: bool,
    ) -> anyhow::Result<ProviderConversation> {
        let token = read_deepseek_token()?;
        let headers = build_base_headers(&token);
        let mut body = serde_json::json!({});
        if temporary {
            body["is_temp"] = serde_json::Value::from(true);
        }
        let res = self
            .client
            .post("https://chat.deepseek.com/api/v0/chat_session/create")
            .headers(headers)
            .json(&body)
            .send()
            .await
            .context("creating DeepSeek conversation")?;

        if !res.status().is_success() {
            bail!("DeepSeek session creation failed: {}", res.status());
        }

        let json: serde_json::Value = res.json().await?;
        let id = json
            .get("data")
            .and_then(|d| d.get("biz_data"))
            .and_then(|b| b.get("chat_session"))
            .and_then(|c| c.get("id"))
            .and_then(|v| v.as_str())
            .context("DeepSeek session creation did not return a session ID")?;

        Ok(ProviderConversation {
            id: id.to_string(),
            provider: "deepseek".into(),
            title: "New conversation".into(),
            model_id: None,
            updated_at: None,
            url: Some(format!("https://chat.deepseek.com/a/chat/s/{}", id)),
            provider_debug: None,
        })
    }
}

#[async_trait]
impl Provider for DeepSeekProvider {
    fn id(&self) -> &'static str {
        "deepseek"
    }
    fn name(&self) -> &'static str {
        "DeepSeek"
    }

    async fn validate_session(&self) -> bool {
        let token = match read_deepseek_token() {
            Ok(t) => t,
            Err(_) => return false,
        };
        let headers = build_base_headers(&token);
        let res = self
            .client
            .get("https://chat.deepseek.com/api/v0/users/current")
            .headers(headers)
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await;
        matches!(res, Ok(r) if r.status().is_success())
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        let _ = read_deepseek_token()?; // Validate token exists

        // Validate session first
        if !self.validate_session().await {
            bail!("DeepSeek session invalid");
        }

        // Try to read model configs from localStorage
        if let Some(configs) = read_deepseek_model_configs() {
            return Ok(configs
                .into_iter()
                .map(|c| ModelInfo {
                    id: format!("deepseek-{}", c.model_type),
                    name: c
                        .name
                        .unwrap_or_else(|| format!("DeepSeek {}", c.model_type)),
                    provider: "deepseek".into(),
                    provider_model: None,
                    capabilities: deepseek_model_capabilities(&format!(
                        "deepseek-{}",
                        c.model_type
                    )),
                })
                .collect());
        }

        // Fallback
        Ok(vec![
            ModelInfo {
                id: "deepseek-chat".into(),
                name: "DeepSeek Chat (default)".into(),
                provider: "deepseek".into(),
                provider_model: None,
                capabilities: deepseek_model_capabilities("deepseek-chat"),
            },
            ModelInfo {
                id: "deepseek-r1".into(),
                name: "DeepSeek R1".into(),
                provider: "deepseek".into(),
                provider_model: None,
                capabilities: deepseek_model_capabilities("deepseek-r1"),
            },
        ])
    }

    async fn list_conversations(&self) -> anyhow::Result<Vec<ProviderConversation>> {
        let token = read_deepseek_token()?;
        let headers = build_base_headers(&token);
        let res = self.client
            .get("https://chat.deepseek.com/api/v0/chat_session/fetch_page?page_size=50&sort_type=updated_at")
            .headers(headers)
            .send()
            .await
            .context("listing DeepSeek conversations")?;

        if !res.status().is_success() {
            return Ok(vec![]);
        }

        let json: serde_json::Value = res.json().await?;
        let sessions = json
            .get("data")
            .and_then(|d| d.get("biz_data"))
            .and_then(|b| b.get("chat_sessions"))
            .and_then(|s| s.as_array());

        let mut convos = Vec::new();
        if let Some(sessions) = sessions {
            for s in sessions {
                let id = s
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                let title = s
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(|t| t.trim())
                    .filter(|t| !t.is_empty())
                    .unwrap_or("Untitled conversation")
                    .to_string();
                let updated_at = s.get("updated_at").and_then(|v| v.as_i64()).map(|ts| {
                    chrono::DateTime::from_timestamp(ts, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                });
                convos.push(ProviderConversation {
                    id,
                    provider: "deepseek".into(),
                    title,
                    updated_at,
                    url: None,
                    model_id: None,
                    provider_debug: None,
                });
            }
        }
        Ok(convos)
    }

    async fn create_conversation(&self, _model: &str) -> anyhow::Result<ProviderConversation> {
        self.create_conversation_with_temporary(false).await
    }

    async fn send_message(
        &self,
        messages: &[ChatMessage],
        model: &str,
        options: &ChatOptions,
        conversation_id: Option<&str>,
    ) -> anyhow::Result<ProviderResponse> {
        let token = read_deepseek_token()?;
        let headers = build_base_headers(&token);

        // Create conversation if not provided
        let session_id = if let Some(id) = conversation_id {
            id.to_string()
        } else {
            self.create_conversation_with_temporary(options.temporary)
                .await?
                .id
        };

        let prompt = format_last_user_message(messages);
        let model_type = resolve_model_id(model);

        // Fetch PoW challenge and solve
        let chal = solver::fetch_challenge(&self.client, &headers).await?;
        let answer = solver::solve_pow(&chal)?;
        let pow_header = solver::build_pow_header(&answer, "/api/v0/chat/completion");

        // Build completion request
        let mut body = serde_json::json!({
            "chat_session_id": session_id,
            "parent_message_id": null,
            "model_type": model_type,
            "prompt": prompt,
            "ref_file_ids": [],
            "thinking_enabled": thinking_enabled_for_reasoning_effort(options.reasoning_effort.as_deref()),
            "search_enabled": false,
            "preempt": false,
        });

        // Forward stop sequences if provided
        if !options.stop.is_empty() {
            body["stop"] = serde_json::to_value(&options.stop)?;
        }

        // Make the request
        let mut req_headers = headers;
        req_headers.insert(
            "x-ds-pow-response",
            reqwest::header::HeaderValue::from_str(&pow_header).context("building PoW header")?,
        );

        let res = self
            .client
            .post("https://chat.deepseek.com/api/v0/chat/completion")
            .headers(req_headers)
            .json(&body)
            .send()
            .await
            .context("DeepSeek completion request")?;

        if !res.status().is_success() {
            let status = res.status();
            let body_text = res.text().await.unwrap_or_default();
            bail!(
                "DeepSeek completion request failed: {} {}",
                status,
                &body_text[..body_text.len().min(200)]
            );
        }

        // Parse SSE stream using the channel-based parser
        Ok(ProviderResponse {
            stream: stream_deepseek_chunks(res),
            conversation_id: Some(session_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::thinking_enabled_for_reasoning_effort;

    #[test]
    fn deepseek_thinking_is_disabled_when_reasoning_is_off() {
        assert!(!thinking_enabled_for_reasoning_effort(Some("off")));
        assert!(!thinking_enabled_for_reasoning_effort(Some("none")));
        assert!(!thinking_enabled_for_reasoning_effort(None));
    }

    #[test]
    fn deepseek_thinking_is_enabled_for_non_off_values() {
        assert!(thinking_enabled_for_reasoning_effort(Some("low")));
        assert!(thinking_enabled_for_reasoning_effort(Some("high")));
        assert!(thinking_enabled_for_reasoning_effort(Some("max")));
    }
}

// ---------------------------------------------------------------------------
// DeepSeek SSE stream parser
// ---------------------------------------------------------------------------

/// Parse DeepSeek SSE events into ChatChunks using shared SSE framing.
pub fn stream_deepseek_chunks(response: reqwest::Response) -> ChunkStream {
    use crate::providers::sse::{stream_sse_response, HandlerAction};
    use std::cell::Cell;

    let response_started = Cell::new(false);

    stream_sse_response(response, move |data| {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            let obj = match json.as_object() {
                Some(o) => o,
                None => return HandlerAction::Emit(vec![]),
            };
            let result = extract_text_from_event(obj, response_started.get());
            let mut chunks = Vec::new();
            if let Some(text) = result.thinking {
                chunks.push(Ok(ChatChunk::Thinking(text)));
            }
            if let Some(text) = result.text {
                chunks.push(Ok(ChatChunk::Content(text)));
            }
            if result.response_started {
                response_started.set(true);
            }
            return HandlerAction::Emit(chunks);
        }
        HandlerAction::Emit(vec![])
    })
}

struct EventResult {
    text: Option<String>,
    thinking: Option<String>,
    response_started: bool,
}

fn extract_text_from_event(
    obj: &serde_json::Map<String, serde_json::Value>,
    response_started: bool,
) -> EventResult {
    let path = obj.get("p").and_then(|v| v.as_str()).unwrap_or("");
    let op = obj.get("o").and_then(|v| v.as_str()).unwrap_or("");
    let val = obj.get("v");

    // Snapshot fragments (initial response)
    if let Some(fragments) = val
        .and_then(|v| v.get("response"))
        .and_then(|r| r.get("fragments"))
        .and_then(|f| f.as_array())
    {
        for frag in fragments {
            let frag_type = frag.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let content = frag.get("content").and_then(|c| c.as_str()).unwrap_or("");
            if !content.is_empty() {
                if frag_type == "RESPONSE" {
                    return EventResult {
                        text: Some(content.to_string()),
                        thinking: None,
                        response_started: true,
                    };
                } else if !response_started {
                    return EventResult {
                        text: None,
                        thinking: Some(content.to_string()),
                        response_started: false,
                    };
                }
            }
        }
    }

    // APPEND patch with fragment array or string value
    if path.starts_with("response/fragments") && op == "APPEND" {
        if let Some(text) = val.and_then(|v| v.as_str()) {
            if !text.is_empty() {
                if !response_started {
                    return EventResult {
                        text: None,
                        thinking: Some(text.to_string()),
                        response_started: false,
                    };
                }
                return EventResult {
                    text: Some(text.to_string()),
                    thinking: None,
                    response_started: true,
                };
            }
        }
        let fragments: Vec<&serde_json::Value> = if let Some(arr) = val.and_then(|v| v.as_array()) {
            arr.iter().collect()
        } else if let Some(v) = val {
            vec![v]
        } else {
            vec![]
        };
        for frag in fragments {
            let frag_type = frag.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let content = frag.get("content").and_then(|c| c.as_str()).unwrap_or("");
            if !content.is_empty() {
                if frag_type == "RESPONSE" {
                    return EventResult {
                        text: Some(content.to_string()),
                        thinking: None,
                        response_started: true,
                    };
                } else {
                    return EventResult {
                        text: None,
                        thinking: Some(content.to_string()),
                        response_started: false,
                    };
                }
            }
        }
        return EventResult {
            text: None,
            thinking: None,
            response_started: false,
        };
    }

    // String patch on fragments path
    if path.starts_with("response/fragments") {
        if let Some(content) = val.and_then(|v| v.as_str()) {
            if !content.is_empty() {
                if !response_started {
                    return EventResult {
                        text: None,
                        thinking: Some(content.to_string()),
                        response_started: false,
                    };
                }
                return EventResult {
                    text: Some(content.to_string()),
                    thinking: None,
                    response_started: true,
                };
            }
        }
    }

    // String patch on content path
    if path.contains("/content") {
        if let Some(content) = val.and_then(|v| v.as_str()) {
            if !content.is_empty() {
                if !response_started {
                    return EventResult {
                        text: None,
                        thinking: Some(content.to_string()),
                        response_started: false,
                    };
                }
                return EventResult {
                    text: Some(content.to_string()),
                    thinking: None,
                    response_started: true,
                };
            }
        }
    }

    // Bare string value (no path, no op)
    if path.is_empty() && op.is_empty() {
        if let Some(content) = val.and_then(|v| v.as_str()) {
            if !content.is_empty() {
                if !response_started {
                    return EventResult {
                        text: None,
                        thinking: Some(content.to_string()),
                        response_started: false,
                    };
                }
                return EventResult {
                    text: Some(content.to_string()),
                    thinking: None,
                    response_started: true,
                };
            }
        }
    }

    EventResult {
        text: None,
        thinking: None,
        response_started,
    }
}
