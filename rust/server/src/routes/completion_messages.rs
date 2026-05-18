use serde::Deserialize;
use serde_json::Value;

use crate::providers::ChatMessage;

#[derive(Deserialize)]
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<CompletionMessage>,
    #[serde(default)]
    pub stream: bool,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub stop: Vec<String>,
    pub tools: Option<Vec<Value>>,
    pub tool_choice: Option<Value>,
    pub provider_conversation_id: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct CompletionMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<CompletionToolCall>>,
}

#[derive(Deserialize, Clone)]
pub struct CompletionToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: CompletionToolFunction,
}

#[derive(Deserialize, Clone)]
pub struct CompletionToolFunction {
    pub name: String,
    pub arguments: String,
}

pub fn content_to_text(content: &Option<Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.as_str())
            .collect::<Vec<_>>()
            .join(""),
        Some(Value::Object(obj)) => obj
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn render_assistant_tool_calls(tool_calls: &[CompletionToolCall]) -> String {
    let mut lines = Vec::new();
    for call in tool_calls {
        if call.kind != "function" {
            continue;
        }
        lines.push(format!(
            "Tool call {}: {}({})",
            call.id, call.function.name, call.function.arguments
        ));
    }
    lines.join("\n")
}

pub fn completion_messages_to_provider_messages(
    messages: &[CompletionMessage],
) -> Vec<ChatMessage> {
    let mut result = Vec::new();

    for msg in messages {
        if let Some(tool_calls) = &msg.tool_calls {
            let mut content = content_to_text(&msg.content);
            let rendered_calls = render_assistant_tool_calls(tool_calls);
            if !rendered_calls.is_empty() {
                if !content.is_empty() {
                    content.push_str("\n\n");
                }
                content.push_str(&rendered_calls);
            }
            result.push(ChatMessage {
                role: msg.role.clone(),
                content,
                tool_call_id: None,
            });
            continue;
        }

        result.push(ChatMessage {
            role: msg.role.clone(),
            content: content_to_text(&msg.content),
            tool_call_id: msg.tool_call_id.clone().or_else(|| msg.name.clone()),
        });
    }

    result
}

pub fn has_tool_transcript(messages: &[CompletionMessage]) -> bool {
    messages.iter().any(|msg| {
        msg.role == "tool"
            || msg
                .tool_calls
                .as_ref()
                .is_some_and(|tool_calls| !tool_calls.is_empty())
    })
}

pub fn latest_user_text(messages: &[CompletionMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|msg| msg.role == "user")
        .map(|msg| content_to_text(&msg.content))
}
