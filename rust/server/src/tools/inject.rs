//! Tool call injection — adds tool schema system prompt and converts
//! `role: "tool"` messages to plain text for providers that don't support
//! native function calling.

use crate::providers::ChatMessage;
use serde_json::Value;

/// Inject tool calling instructions into the message list.
///
/// When `tools` is non-empty, this:
/// 1. Builds a system prompt describing the tools and their schemas
/// 2. Prepends or merges it into the first system message
/// 3. Converts `role: "tool"` messages to plain user text
///
/// Returns the modified message list.
pub fn inject_tools(
    messages: &[ChatMessage],
    tools: &[Value],
    tool_choice: Option<&Value>,
) -> Vec<ChatMessage> {
    if tools.is_empty() {
        return messages.to_vec();
    }

    let tool_manifest = build_tool_manifest(tools, tool_choice);
    let mut result = Vec::new();

    let mut injected_system = false;

    for msg in messages {
        if msg.role == "tool" {
            // Convert tool result to user message
            let tool_name = msg.tool_call_id.as_deref().unwrap_or("unknown");
            let content = format!(
                "Tool result for {} (call {}): {}",
                tool_name, tool_name, msg.content
            );
            result.push(ChatMessage {
                role: "user".into(),
                content,
                tool_call_id: None,
            });
        } else if msg.role == "system" && !injected_system {
            // Merge tool manifest into existing system message
            let merged = format!("{}\n\n{}", msg.content, tool_manifest);
            result.push(ChatMessage {
                role: "system".into(),
                content: merged,
                tool_call_id: None,
            });
            injected_system = true;
        } else {
            result.push(msg.clone());
        }
    }

    // If no system message existed, prepend one
    if !injected_system {
        result.insert(
            0,
            ChatMessage {
                role: "system".into(),
                content: tool_manifest,
                tool_call_id: None,
            },
        );
    }

    result
}

fn build_tool_manifest(tools: &[Value], tool_choice: Option<&Value>) -> String {
    let mut manifest = String::from(
        "You have access to tools. When you need to call a tool, respond ONLY with:\n\
         <<<<\n\
         {\"name\": \"<tool_name>\", \"arguments\": {<args as JSON object>}}\n\
         >>>>\n\n\
         Never mix tool calls with regular text. If you need to call a tool, that is your \
         entire response. If you don't need a tool, respond normally.\n\n\
         Available tools:",
    );

    for tool in tools {
        if let Some(function) = tool.get("function") {
            let name = function
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let description = function
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let params = function.get("parameters");

            manifest.push_str(&format!("\n  Name: {}", name));
            if !description.is_empty() {
                manifest.push_str(&format!("\n  Description: {}", description));
            }
            if let Some(params) = params {
                if let Ok(compact) = serde_json::to_string(params) {
                    manifest.push_str(&format!("\n  Parameters: {}", compact));
                }
            }
        }
    }

    if let Some(choice) = tool_choice {
        match choice {
            Value::String(choice) if choice != "none" => {
                manifest.push_str(&format!("\n\nTool choice: {}", choice));
            }
            Value::Object(obj) => {
                if let Some(name) = obj
                    .get("function")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                {
                    manifest.push_str(&format!("\n\nTool choice: {}", name));
                }
            }
            _ => {}
        }
    }

    manifest
}
