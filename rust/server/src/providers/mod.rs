//! Provider trait and shared types — mirrors `src/providers/types.ts`

use async_trait::async_trait;
use futures::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use std::task::Poll;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant" | "tool"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatOptions {
 #[allow(dead_code)] pub temperature: Option<f32>,
 #[allow(dead_code)] pub max_tokens: Option<u32>,
 #[allow(dead_code)] pub reasoning_effort: Option<String>,
    pub stream: bool,
    pub stop: Vec<String>,
    /// Native OpenAI-format tool definitions. When non-empty, the provider
    /// should pass them directly in the request body (for providers that
    /// support native tool calling) rather than relying on <<<<>>>> injection.
    pub tools: Vec<serde_json::Value>,
    /// Native tool_choice — passed through for providers that support native
    /// tool calling.
    pub tool_choice: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ToolCallStrategy {
    PromptInjected,
    Emulated,
    Native,
}

#[derive(Debug, Clone)]
pub enum ChatChunk {
    Content(String),
    Thinking(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelCapabilities {
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub reasoning_effort: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasoning_effort_levels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConversation {
    pub id: String,
    pub provider: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}
pub type ChunkStream = Pin<Box<dyn Stream<Item = anyhow::Result<ChatChunk>> + Send>>;

/// Response from sending a message, including the content stream and
/// the provider-side conversation ID (if known).
pub struct ProviderResponse {
    pub stream: ChunkStream,
    /// The provider-side conversation ID, if one was created or reused.
    /// `None` means the provider did not expose the ID (e.g. Gemini).
    pub conversation_id: Option<String>,
}
 
// ---------------------------------------------------------------------------
// Shared ReceiverStream helper
// ---------------------------------------------------------------------------

/// Wrapper around `tokio::sync::mpsc::Receiver` that implements `futures::Stream`.
pub struct ReceiverStream<T> {
    pub(crate) rx: tokio::sync::mpsc::Receiver<T>,
}

impl<T> ReceiverStream<T> {
    pub fn new(rx: tokio::sync::mpsc::Receiver<T>) -> Self {
        ReceiverStream { rx }
    }
}

impl<T> futures::Stream for ReceiverStream<T> {
    type Item = T;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}


/// Merge `Set-Cookie` header values into an existing cookie string.
/// Existing cookies with the same name are overwritten; insertion order is preserved.
pub fn merge_set_cookies(existing: &str, set_cookie_values: impl Iterator<Item = String>) -> String {
    // (name, value) pairs preserving order; later entries override earlier ones for same name
    let mut pairs: Vec<(String, String)> = existing
        .split("; ")
        .filter_map(|pair| {
            let eq = pair.find('=')?;
            Some((pair[..eq].to_string(), pair[eq + 1..].to_string()))
        })
        .collect();

    for sc in set_cookie_values {
        let name_val = sc.split(';').next().unwrap_or("").trim();
        if let Some(eq) = name_val.find('=') {
            let name = name_val[..eq].trim().to_string();
            let value = name_val[eq + 1..].trim().to_string();
            if name.is_empty() {
                continue;
            }
            if let Some(pos) = pairs.iter().position(|(k, _)| k == &name) {
                pairs[pos].1 = value;
            } else {
                pairs.push((name, value));
            }
        }
    }

    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Collect `Set-Cookie` headers from a response and return them as a Vec.
pub fn collect_set_cookies(res: &reqwest::Response) -> Vec<String> {
    res.headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect()
}

// ---------------------------------------------------------------------------
// Provider trait
// ---------------------------------------------------------------------------

#[async_trait]
pub trait Provider: Send + Sync + 'static {
 #[allow(dead_code)]
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;

    /// Check if the session is valid by making a lightweight API call.
    async fn validate_session(&self) -> bool;

    /// List available models from the provider.
    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>>;

    /// List conversations for the provider.
    async fn list_conversations(&self) -> anyhow::Result<Vec<ProviderConversation>>;

    /// Create a new conversation.
    async fn create_conversation(&self, model: &str) -> anyhow::Result<ProviderConversation>;

    /// How this provider handles tool calling.
    fn tool_call_strategy(&self) -> ToolCallStrategy { ToolCallStrategy::PromptInjected }

    /// Send a message (creates a new conversation internally if no conversation_id given).
    /// Returns a `ProviderResponse` containing the content stream and the actual
    /// provider-side conversation ID.
    async fn send_message(
        &self,
        messages: &[ChatMessage],
        model: &str,
        options: &ChatOptions,
        conversation_id: Option<&str>,
    ) -> anyhow::Result<ProviderResponse>;
}
pub mod deepseek;
pub mod claude;
pub mod chatgpt;
pub mod gemini;
pub mod kimi;
pub mod sse;
