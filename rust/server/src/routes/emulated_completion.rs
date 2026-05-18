use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use futures::StreamExt;
use serde_json::Value;

use crate::providers::{ChatChunk, ChatMessage, ChatOptions, Provider};
use crate::routes::completion_messages::{CompletionRequest, latest_user_text};
use crate::routes::conversation_tracker::TRACKER;
use crate::routes::errors::RouteError;
use crate::routes::openai_format::{
    emulated_stream_text_response, emulated_stream_tool_call_response, text_completion_response,
    tool_call_completion_response,
};
use crate::tools::emulated::{
    EmulatedToolResult, build_emulated_tool_prompt, build_repair_prompt_with_context,
    parse_emulated_tool_response, validate_emulated_tool_call,
};

pub async fn emulated_completion_response(
    body: &CompletionRequest,
    provider: Arc<dyn Provider>,
    provider_id: String,
    provider_messages: Vec<ChatMessage>,
    initial_conversation_id: Option<String>,
    request_id: &str,
) -> axum::response::Response {
    match run_emulated_completion(
        body,
        provider,
        &provider_id,
        provider_messages.clone(),
        initial_conversation_id,
    )
    .await
    {
        Ok(EmulatedCompletionOutcome::Final {
            content,
            conversation_id,
        }) => {
            if let Some(cid) = conversation_id {
                TRACKER.store(&provider_messages, &provider_id, cid);
            }

            if body.stream {
                emulated_stream_text_response(request_id, &body.model, content).into_response()
            } else {
                Json(text_completion_response(request_id, &body.model, content)).into_response()
            }
        }
        Ok(EmulatedCompletionOutcome::ToolCall {
            name,
            arguments,
            conversation_id,
        }) => {
            if let Some(cid) = conversation_id {
                TRACKER.store(&provider_messages, &provider_id, cid);
            }

            if body.stream {
                emulated_stream_tool_call_response(request_id, &body.model, &name, &arguments)
                    .into_response()
            } else {
                Json(tool_call_completion_response(request_id, &body.model, name, arguments)).into_response()
            }
        }
        Err(err) => err.into_response(),
    }
}

enum EmulatedCompletionOutcome {
    Final {
        content: String,
        conversation_id: Option<String>,
    },
    ToolCall {
        name: String,
        arguments: String,
        conversation_id: Option<String>,
    },
}

async fn run_emulated_completion(
    body: &CompletionRequest,
    provider: Arc<dyn Provider>,
    provider_id: &str,
    provider_messages: Vec<ChatMessage>,
    initial_conversation_id: Option<String>,
) -> Result<EmulatedCompletionOutcome, RouteError> {
    let tools = body.tools.clone().unwrap_or_default();
    let mut working_messages = inject_emulated_tool_prompt(
        &provider_messages,
        &tools,
        body.tool_choice.as_ref(),
    );
    let mut conversation_id = initial_conversation_id;

    for attempt in 0..3 {
        trace_tool_event(
            provider_id,
            attempt,
            "request_start",
            conversation_id.as_deref().unwrap_or("new_conversation"),
        );

        let provider_response = provider
            .send_message(
                &working_messages,
                &body.model,
                &ChatOptions {
                    temperature: body.temperature,
                    max_tokens: body.max_tokens,
                    stop: body.stop.clone(),
                    tools: Vec::new(),
                    tool_choice: None,
                },
                conversation_id.as_deref(),
            )
            .await
            .map_err(|e| RouteError {
                status: StatusCode::BAD_GATEWAY,
                message: e.to_string(),
                err_type: "upstream_error",
                code: "upstream_error",
            })?;

        if let Some(cid) = provider_response.conversation_id.clone() {
            conversation_id = Some(cid);
        }

        let raw_output = collect_provider_text(provider_response.stream).await;
        trace_tool_event(provider_id, attempt, "raw_output", &preview_for_log(&raw_output));

        match parse_emulated_tool_response(&raw_output) {
            Ok(EmulatedToolResult::Final(content)) => {
                trace_tool_event(provider_id, attempt, "parsed_final", &preview_for_log(&content));
                if let Some(err) = final_answer_requires_tool_retry(body, &tools, &content) {
                    trace_tool_event(provider_id, attempt, "repair_required", &err);
                    if attempt < 2 {
                        append_repair_turn(
                            &mut working_messages,
                            raw_output,
                            &err,
                            &tools,
                            body.tool_choice.as_ref(),
                        );
                        continue;
                    }

                    return Err(RouteError {
                        status: StatusCode::BAD_GATEWAY,
                        message: format!(
                            "{} emulated tool call final-answer validation failed after retries: {}",
                            provider_id, err
                        ),
                        err_type: "upstream_error",
                        code: "tool_call_invalid",
                    });
                }

                return Ok(EmulatedCompletionOutcome::Final {
                    content,
                    conversation_id,
                });
            }
            Ok(EmulatedToolResult::ToolCall { name, arguments }) => {
                trace_tool_event(
                    provider_id,
                    attempt,
                    "parsed_tool_call",
                    &format!("name={} args={}", name, preview_for_log(&arguments)),
                );

                let resolved_name = match resolve_emulated_tool_name(&name, &tools, body.tool_choice.as_ref()) {
                    Ok(name) => name,
                    Err(err) if attempt < 2 => {
                        trace_tool_event(provider_id, attempt, "repair_required", &err);
                        append_repair_turn(
                            &mut working_messages,
                            raw_output,
                            &err,
                            &tools,
                            body.tool_choice.as_ref(),
                        );
                        continue;
                    }
                    Err(err) => {
                        return Err(RouteError {
                            status: StatusCode::BAD_GATEWAY,
                            message: format!(
                                "{} emulated tool call name resolution failed after retries: {}",
                                provider_id, err
                            ),
                            err_type: "upstream_error",
                            code: "tool_call_invalid",
                        });
                    }
                };

                match validate_emulated_tool_call(
                    &resolved_name,
                    &arguments,
                    &tools,
                    body.tool_choice.as_ref(),
                ) {
                    Ok(()) => {
                        trace_tool_event(
                            provider_id,
                            attempt,
                            "validated_tool_call",
                            &format!("name={} args={}", resolved_name, preview_for_log(&arguments)),
                        );

                        return Ok(EmulatedCompletionOutcome::ToolCall {
                            name: resolved_name,
                            arguments,
                            conversation_id,
                        });
                    }
                    Err(err) if attempt < 2 => {
                        trace_tool_event(provider_id, attempt, "repair_required", &err);
                        append_repair_turn(
                            &mut working_messages,
                            raw_output,
                            &err,
                            &tools,
                            body.tool_choice.as_ref(),
                        );
                    }
                    Err(err) => {
                        return Err(RouteError {
                            status: StatusCode::BAD_GATEWAY,
                            message: format!(
                                "{} emulated tool call validation failed after retries: {}",
                                provider_id, err
                            ),
                            err_type: "upstream_error",
                            code: "tool_call_invalid",
                        });
                    }
                }
            }
            Err(err) if attempt < 2 => {
                trace_tool_event(provider_id, attempt, "repair_required", &err);
                append_repair_turn(
                    &mut working_messages,
                    raw_output,
                    &err,
                    &tools,
                    body.tool_choice.as_ref(),
                );
            }
            Err(err) => {
                return Err(RouteError {
                    status: StatusCode::BAD_GATEWAY,
                    message: format!(
                        "{} emulated tool call parsing failed after retries: {}. Last response: {}",
                        provider_id, err, raw_output
                    ),
                    err_type: "upstream_error",
                    code: "tool_call_invalid",
                });
            }
        }
    }

    Err(RouteError {
        status: StatusCode::BAD_GATEWAY,
        message: format!("{} emulated tool call loop exhausted", provider_id),
        err_type: "upstream_error",
        code: "tool_call_invalid",
    })
}

fn append_repair_turn(
    working_messages: &mut Vec<ChatMessage>,
    raw_output: String,
    err: &str,
    tools: &[Value],
    tool_choice: Option<&Value>,
) {
    working_messages.push(ChatMessage {
        role: "assistant".into(),
        content: raw_output,
        tool_call_id: None,
    });
    working_messages.push(ChatMessage {
        role: "user".into(),
        content: build_repair_prompt_with_context(err, tools, tool_choice),
        tool_call_id: None,
    });
}

fn tool_debug_enabled() -> bool {
    std::env::var("POLYCHAT_DEBUG_TOOLS")
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn preview_for_log(text: &str) -> String {
    const LIMIT: usize = 400;
    let clean = text.replace('\n', "\\n");
    if clean.len() <= LIMIT {
        clean
    } else {
        format!("{}...", &clean[..LIMIT])
    }
}

fn trace_tool_event(provider_id: &str, attempt: usize, event: &str, detail: &str) {
    if tool_debug_enabled() {
        tracing::info!(
            target: "polychat::tools",
            provider = provider_id,
            attempt = attempt + 1,
            event,
            detail = detail,
            "emulated tool event"
        );
    }
}

fn inject_emulated_tool_prompt(
    messages: &[ChatMessage],
    tools: &[Value],
    tool_choice: Option<&Value>,
) -> Vec<ChatMessage> {
    let prompt = build_emulated_tool_prompt(tools, tool_choice);
    let mut result = Vec::new();
    let mut injected_system = false;

    for msg in messages {
        if msg.role == "tool" {
            let tool_name = msg.tool_call_id.as_deref().unwrap_or("unknown");
            result.push(ChatMessage {
                role: "user".into(),
                content: format!("Tool result for {} (call {}): {}", tool_name, tool_name, msg.content),
                tool_call_id: None,
            });
        } else if msg.role == "system" && !injected_system {
            result.push(ChatMessage {
                role: "system".into(),
                content: format!("{}\n\n{}", msg.content, prompt),
                tool_call_id: None,
            });
            injected_system = true;
        } else {
            result.push(msg.clone());
        }
    }

    if !injected_system {
        result.insert(
            0,
            ChatMessage {
                role: "system".into(),
                content: prompt,
                tool_call_id: None,
            },
        );
    }

    result
}

async fn collect_provider_text(mut chunk_stream: crate::providers::ChunkStream) -> String {
    let mut output = String::new();
    while let Some(result) = chunk_stream.next().await {
        match result {
            Ok(ChatChunk::Content(text)) => output.push_str(&text),
            Ok(ChatChunk::Thinking(_)) => {}
            Err(_) => break,
        }
    }
    output
}

fn final_answer_requires_tool_retry(
    body: &CompletionRequest,
    tools: &[Value],
    content: &str,
) -> Option<String> {
    match body.tool_choice.as_ref() {
        Some(Value::String(choice)) if choice == "required" => {
            return Some("tool choice was `required`, but the model answered directly".into());
        }
        Some(Value::Object(obj)) => {
            if let Some(name) = obj
                .get("function")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
            {
                return Some(format!(
                    "tool choice required `{}`, but the model answered directly",
                    name
                ));
            }
        }
        _ => {}
    }

    let content_lower = content.to_lowercase();
    if content_lower.contains("don't have access")
        || content_lower.contains("do not have access")
        || content_lower.contains("cannot run")
        || content_lower.contains("can't run")
        || content_lower.contains("i'm a text-based ai")
    {
        return Some("the model incorrectly denied having tool access".into());
    }

    let Some(user_text) = latest_user_text(&body.messages) else {
        return None;
    };
    let user_lower = user_text.to_lowercase();

    for tool in tools {
        if let Some(name) = tool
            .get("function")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
        {
            let tool_name = name.to_lowercase();
            if user_lower.contains(&format!("use the {} tool", tool_name))
                || user_lower.contains(&format!("use {}", tool_name))
                || user_lower.contains(&tool_name)
            {
                return Some(format!(
                    "the user explicitly requested the `{}` tool, but the model answered directly",
                    name
                ));
            }
        }
    }

    None
}

fn resolve_emulated_tool_name(
    name: &str,
    tools: &[Value],
    tool_choice: Option<&Value>,
) -> Result<String, String> {
    if !name.is_empty() {
        return Ok(name.to_string());
    }

    if let Some(Value::Object(obj)) = tool_choice {
        if let Some(name) = obj
            .get("function")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
        {
            return Ok(name.to_string());
        }
    }

    let mut names = tools.iter().filter_map(|tool| {
        tool.get("function")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    let first = names
        .next()
        .ok_or_else(|| "tool call omitted a name and no tools were available".to_string())?;
    if names.next().is_none() {
        Ok(first)
    } else {
        Err("tool call omitted a name and multiple tools were available".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{final_answer_requires_tool_retry, resolve_emulated_tool_name};
    use crate::routes::completion_messages::{CompletionMessage, CompletionRequest};
    use serde_json::{Value, json};

    fn request_with_user_text(text: &str, tool_choice: Option<Value>) -> CompletionRequest {
        CompletionRequest {
            model: "gpt-5-5".into(),
            messages: vec![CompletionMessage {
                role: "user".into(),
                content: Some(Value::String(text.into())),
                tool_call_id: None,
                name: None,
                tool_calls: None,
            }],
            stream: false,
            temperature: None,
            max_tokens: None,
            stop: Vec::new(),
            tools: None,
            tool_choice,
            provider_conversation_id: None,
        }
    }

    #[test]
    fn final_answer_retry_triggers_for_required_tool_choice() {
        let request = request_with_user_text("list the files", Some(Value::String("required".into())));
        let err = final_answer_requires_tool_retry(&request, &[], "Here are some files.");
        assert_eq!(err.as_deref(), Some("tool choice was `required`, but the model answered directly"));
    }

    #[test]
    fn final_answer_retry_triggers_for_explicit_tool_request() {
        let request = request_with_user_text("use bash to print the current directory", None);
        let tools = vec![json!({ "type": "function", "function": { "name": "bash" } })];
        let err = final_answer_requires_tool_retry(&request, &tools, "The current directory is /tmp.");
        assert!(err.unwrap().contains("explicitly requested the `bash` tool"));
    }

    #[test]
    fn resolve_tool_name_uses_single_available_tool() {
        let tools = vec![json!({ "type": "function", "function": { "name": "bash" } })];
        assert_eq!(resolve_emulated_tool_name("", &tools, None).unwrap(), "bash");
    }

    #[test]
    fn resolve_tool_name_rejects_ambiguous_empty_name() {
        let tools = vec![
            json!({ "type": "function", "function": { "name": "bash" } }),
            json!({ "type": "function", "function": { "name": "read" } }),
        ];
        assert!(resolve_emulated_tool_name("", &tools, None)
            .unwrap_err()
            .contains("multiple tools were available"));
    }
}
