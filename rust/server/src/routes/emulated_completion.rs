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
    emulated_stream_text_response, emulated_stream_tool_call_response, event_stream_response,
    format_sse_chunk, text_completion_response, tool_call_completion_response, StreamDelta,
};
use crate::tools::emulated::{
    EmulatedToolResult, StreamingEmulatedParser, build_emulated_tool_prompt,
    build_repair_prompt_with_context, parse_emulated_tool_response, validate_emulated_tool_call,
};

fn format_tool_result_message(tool_call_id: Option<&str>, content: &str) -> String {
    let call_id = tool_call_id.unwrap_or("unknown");
    format!("[tool_result]\ncall_id: {}\ncontent:\n{}", call_id, content)
}

fn should_retry_emulated_response(tool_choice: Option<&Value>, err: &str) -> bool {
    match tool_choice {
        Some(Value::String(choice)) if choice == "required" => true,
        Some(Value::Object(_)) => true,
        _ => err.contains("incorrectly denied having tool access")
            || err.contains("explicitly requested the `")
            || err.contains("attempted to show tool-call JSON inline")
            || err.contains("returned a structured JSON payload")
            || err.contains("claimed it already changed files"),
    }
}

fn looks_like_structured_payload(raw_output: &str) -> bool {
    let trimmed = raw_output.trim_start();
    (trimmed.starts_with('{') || trimmed.starts_with("```json") || trimmed.starts_with("```"))
        && (trimmed.contains("\"name\"") || trimmed.contains("\"type\"") || trimmed.contains("\"content\""))
}

fn should_accept_plain_text_final(tool_choice: Option<&Value>, err: &str, raw_output: &str) -> bool {
    if raw_output.trim().is_empty() || err != "response did not include a polychat block" {
        return false;
    }

    if looks_like_structured_payload(raw_output) {
        return false;
    }

    !matches!(
        tool_choice,
        Some(Value::String(choice)) if choice == "required"
    ) && !matches!(tool_choice, Some(Value::Object(_)))
}

fn has_tool_result_after_latest_user(messages: &[crate::routes::completion_messages::CompletionMessage]) -> bool {
    let last_user_idx = messages.iter().rposition(|msg| msg.role == "user");
    let search_start = last_user_idx.map_or(0, |idx| idx + 1);
    messages[search_start..].iter().any(|msg| msg.role == "tool")
}

fn final_answer_claims_external_action(content_lower: &str) -> bool {
    let action_markers = [
        "i wrote ",
        "i can write ",
        "i created ",
        "i can create ",
        "i saved ",
        "i can save ",
        "i updated ",
        "i opened ",
        "i ran ",
        "i can run ",
        "i executed ",
        "spec written to ",
        "written to ~/",
        "written to /",
        "saved to ~/",
        "saved to /",
        "created at ~/",
        "created at /",
        "ready for: /go ",
    ];

    action_markers.iter().any(|marker| content_lower.contains(marker))
}

fn final_answer_contains_inline_tool_call_json(content: &str) -> bool {
    let lower = content.to_lowercase();
    (lower.contains("\"name\"") && lower.contains("\"arguments\""))
        || (lower.contains("<polychat_tool_call>") && !lower.contains("</polychat_tool_call>"))
}

pub async fn emulated_completion_response(
    body: &CompletionRequest,
    provider: Arc<dyn Provider>,
    provider_id: String,
    provider_messages: Vec<ChatMessage>,
    initial_conversation_id: Option<String>,
    request_id: &str,
) -> axum::response::Response {
    if body.stream && should_stream_emulated_incrementally(body, body.tools.as_deref().unwrap_or(&[])) {
        return stream_emulated_completion_response(
            body.clone(),
            provider,
            provider_id,
            provider_messages,
            initial_conversation_id,
            request_id.to_string(),
        );
    }

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

fn stream_emulated_completion_response(
    body: CompletionRequest,
    provider: Arc<dyn Provider>,
    provider_id: String,
    provider_messages: Vec<ChatMessage>,
    initial_conversation_id: Option<String>,
    request_id: String,
) -> axum::response::Response {
    let model = body.model.clone();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(256);

    tokio::spawn(async move {
        let _ = tx
            .send(Ok(format_sse_chunk(
                &request_id,
                &model,
                StreamDelta {
                    role: Some("assistant"),
                    ..Default::default()
                },
                None,
            )))
            .await;

        match run_emulated_completion_streaming(&body, provider, &provider_id, provider_messages.clone(), initial_conversation_id, &request_id, &model, &tx).await {
            Ok(EmulatedStreamOutcome::Final {
                content,
                conversation_id,
                streamed,
            }) => {
                if let Some(cid) = conversation_id {
                    TRACKER.store(&provider_messages, &provider_id, cid);
                }

                if !streamed && !content.is_empty() {
                    let _ = tx
                        .send(Ok(format_sse_chunk(
                            &request_id,
                            &model,
                            StreamDelta {
                                content: Some(content),
                                ..Default::default()
                            },
                            None,
                        )))
                        .await;
                }

                let _ = tx
                    .send(Ok(format_sse_chunk(
                        &request_id,
                        &model,
                        StreamDelta::default(),
                        Some("stop".to_string()),
                    )))
                    .await;
                let _ = tx.send(Ok("data: [DONE]\n\n".into())).await;
            }
            Ok(EmulatedStreamOutcome::ToolCall {
                name,
                arguments,
                conversation_id,
            }) => {
                if let Some(cid) = conversation_id {
                    TRACKER.store(&provider_messages, &provider_id, cid);
                }

                let call_id = format!("call_{}", uuid::Uuid::new_v4());
                let _ = tx
                    .send(Ok(format_sse_chunk(
                        &request_id,
                        &model,
                        StreamDelta {
                            tool_calls: Some(vec![crate::routes::openai_format::StreamToolCallDelta {
                                index: 0,
                                id: Some(call_id),
                                kind: Some("function"),
                                function: crate::routes::openai_format::StreamFunctionDelta {
                                    name: Some(name),
                                    arguments: Some(String::new()),
                                },
                            }]),
                            ..Default::default()
                        },
                        None,
                    )))
                    .await;

                for chunk in arguments.as_bytes().chunks(32) {
                    let _ = tx
                        .send(Ok(format_sse_chunk(
                            &request_id,
                            &model,
                            StreamDelta {
                                tool_calls: Some(vec![crate::routes::openai_format::StreamToolCallDelta {
                                    index: 0,
                                    id: None,
                                    kind: None,
                                    function: crate::routes::openai_format::StreamFunctionDelta {
                                        name: None,
                                        arguments: Some(String::from_utf8_lossy(chunk).to_string()),
                                    },
                                }]),
                                ..Default::default()
                            },
                            None,
                        )))
                        .await;
                }

                let _ = tx
                    .send(Ok(format_sse_chunk(
                        &request_id,
                        &model,
                        StreamDelta::default(),
                        Some("tool_calls".to_string()),
                    )))
                    .await;
                let _ = tx.send(Ok("data: [DONE]\n\n".into())).await;
            }
            Err(err) => {
                tracing::warn!("{} streamed emulated completion failed: {}", provider_id, err.message);
                let _ = tx
                    .send(Ok(format_sse_chunk(
                        &request_id,
                        &model,
                        StreamDelta::default(),
                        Some("stop".to_string()),
                    )))
                    .await;
                let _ = tx.send(Ok("data: [DONE]\n\n".into())).await;
            }
        }
    });

    event_stream_response(tokio_stream::wrappers::ReceiverStream::new(rx))
}

enum EmulatedStreamOutcome {
    Final {
        content: String,
        conversation_id: Option<String>,
        streamed: bool,
    },
    ToolCall {
        name: String,
        arguments: String,
        conversation_id: Option<String>,
    },
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
        let provider_response = provider
            .send_message(
                &working_messages,
                &body.model,
                &ChatOptions {
                    temperature: body.temperature,
                    max_tokens: body.max_tokens,
                    reasoning_effort: body.reasoning_effort.clone(),
                    stream: body.stream,
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

        match parse_emulated_tool_response(&raw_output) {
            Ok(EmulatedToolResult::Final(content)) => {
                if let Some(err) = final_answer_requires_tool_retry(body, &tools, &content) {
                    if attempt < 2 && should_retry_emulated_response(body.tool_choice.as_ref(), &err) {
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
                let resolved_name = match resolve_emulated_tool_name(&name, &tools, body.tool_choice.as_ref()) {
                    Ok(name) => name,
                    Err(err) if attempt < 2 && should_retry_emulated_response(body.tool_choice.as_ref(), &err) => {
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
                        return Ok(EmulatedCompletionOutcome::ToolCall {
                            name: resolved_name,
                            arguments,
                            conversation_id,
                        });
                    }
                    Err(err) if attempt < 2 && should_retry_emulated_response(body.tool_choice.as_ref(), &err) => {
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
            Err(err) if attempt < 2 && should_retry_emulated_response(body.tool_choice.as_ref(), &err) => {
                append_repair_turn(
                    &mut working_messages,
                    raw_output,
                    &err,
                    &tools,
                    body.tool_choice.as_ref(),
                );
            }
            Err(err)
                if attempt < 2
                    && err == "response did not include a polychat block"
                    && looks_like_structured_payload(&raw_output) =>
            {
                let retry_err =
                    "the model returned a structured JSON payload instead of a valid tool call block or plain final answer";
                append_repair_turn(
                    &mut working_messages,
                    raw_output,
                    retry_err,
                    &tools,
                    body.tool_choice.as_ref(),
                );
            }
            Err(err) if should_accept_plain_text_final(body.tool_choice.as_ref(), &err, &raw_output) => {
                let content = raw_output.trim().to_string();
                if let Some(retry_err) = final_answer_requires_tool_retry(body, &tools, &content) {
                    if attempt < 2 && should_retry_emulated_response(body.tool_choice.as_ref(), &retry_err) {
                        append_repair_turn(
                            &mut working_messages,
                            raw_output,
                            &retry_err,
                            &tools,
                            body.tool_choice.as_ref(),
                        );
                        continue;
                    }

                    return Err(RouteError {
                        status: StatusCode::BAD_GATEWAY,
                        message: format!(
                            "{} emulated tool call final-answer validation failed after retries: {}",
                            provider_id, retry_err
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

async fn run_emulated_completion_streaming(
    body: &CompletionRequest,
    provider: Arc<dyn Provider>,
    provider_id: &str,
    provider_messages: Vec<ChatMessage>,
    initial_conversation_id: Option<String>,
    request_id: &str,
    model: &str,
    tx: &tokio::sync::mpsc::Sender<Result<String, std::io::Error>>,
) -> Result<EmulatedStreamOutcome, RouteError> {
    let tools = body.tools.clone().unwrap_or_default();
    let mut working_messages = inject_emulated_tool_prompt(
        &provider_messages,
        &tools,
        body.tool_choice.as_ref(),
    );
    let mut conversation_id = initial_conversation_id;

    for attempt in 0..3 {
        let provider_response = provider
            .send_message(
                &working_messages,
                &body.model,
                &ChatOptions {
                    temperature: body.temperature,
                    max_tokens: body.max_tokens,
                    reasoning_effort: body.reasoning_effort.clone(),
                    stream: body.stream,
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

        let (raw_output, streamed_any) = stream_provider_text(
            provider_response.stream,
            request_id,
            model,
            tx,
        )
        .await;

        match parse_emulated_tool_response(&raw_output) {
            Ok(EmulatedToolResult::Final(content)) => {
                if let Some(err) = final_answer_requires_tool_retry(body, &tools, &content) {
                    if !streamed_any
                        && attempt < 2
                        && should_retry_emulated_response(body.tool_choice.as_ref(), &err)
                    {
                        append_repair_turn(
                            &mut working_messages,
                            raw_output,
                            &err,
                            &tools,
                            body.tool_choice.as_ref(),
                        );
                        continue;
                    }
                }

                return Ok(EmulatedStreamOutcome::Final {
                    content,
                    conversation_id,
                    streamed: streamed_any,
                });
            }
            Ok(EmulatedToolResult::ToolCall { name, arguments }) => {
                let resolved_name = match resolve_emulated_tool_name(&name, &tools, body.tool_choice.as_ref()) {
                    Ok(name) => name,
                    Err(err) if !streamed_any
                        && attempt < 2
                        && should_retry_emulated_response(body.tool_choice.as_ref(), &err) => {
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
                        return Ok(EmulatedStreamOutcome::ToolCall {
                            name: resolved_name,
                            arguments,
                            conversation_id,
                        });
                    }
                    Err(err) if !streamed_any
                        && attempt < 2
                        && should_retry_emulated_response(body.tool_choice.as_ref(), &err) => {
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
                                "{} emulated tool call validation failed after retries: {}",
                                provider_id, err
                            ),
                            err_type: "upstream_error",
                            code: "tool_call_invalid",
                        });
                    }
                }
            }
            Err(err) if !streamed_any
                && should_accept_plain_text_final(body.tool_choice.as_ref(), &err, &raw_output) => {
                let content = raw_output.trim().to_string();
                if let Some(retry_err) = final_answer_requires_tool_retry(body, &tools, &content) {
                    if attempt < 2 && should_retry_emulated_response(body.tool_choice.as_ref(), &retry_err) {
                        append_repair_turn(
                            &mut working_messages,
                            raw_output,
                            &retry_err,
                            &tools,
                            body.tool_choice.as_ref(),
                        );
                        continue;
                    }
                }

                return Ok(EmulatedStreamOutcome::Final {
                    content,
                    conversation_id,
                    streamed: false,
                });
            }
            Err(err) if !streamed_any
                && attempt < 2
                && should_retry_emulated_response(body.tool_choice.as_ref(), &err) => {
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
                        "{} emulated tool call parsing failed after retries: {}",
                        provider_id, err
                    ),
                    err_type: "upstream_error",
                    code: "tool_call_invalid",
                });
            }
        }
    }

    Err(RouteError {
        status: StatusCode::BAD_GATEWAY,
        message: format!("{} emulated tool call failed after retries", provider_id),
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
            result.push(ChatMessage {
                role: "system".into(),
                content: format_tool_result_message(msg.tool_call_id.as_deref(), &msg.content),
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

async fn stream_provider_text(
    mut chunk_stream: crate::providers::ChunkStream,
    request_id: &str,
    model: &str,
    tx: &tokio::sync::mpsc::Sender<Result<String, std::io::Error>>,
) -> (String, bool) {
    let mut parser = StreamingEmulatedParser::new();
    let mut streamed_any = false;

    while let Some(result) = chunk_stream.next().await {
        match result {
            Ok(ChatChunk::Content(text)) => {
                for chunk in parser.feed(&text) {
                    streamed_any = true;
                    let _ = tx
                        .send(Ok(format_sse_chunk(
                            request_id,
                            model,
                            StreamDelta {
                                content: Some(chunk),
                                ..Default::default()
                            },
                            None,
                        )))
                        .await;
                }
            }
            Ok(ChatChunk::Thinking(_)) => {}
            Err(_) => break,
        }
    }

    (parser.raw_output().to_string(), streamed_any)
}

fn should_stream_emulated_incrementally(body: &CompletionRequest, tools: &[Value]) -> bool {
    match body.tool_choice.as_ref() {
        Some(Value::String(choice)) if choice == "required" => return false,
        Some(Value::Object(_)) => return false,
        _ => {}
    }

    explicit_tool_request(body, tools).is_none()
}

fn explicit_tool_request(body: &CompletionRequest, tools: &[Value]) -> Option<String> {
    let user_text = latest_user_text(&body.messages)?;
    let user_lower = user_text.to_lowercase();

    for tool in tools {
        if let Some(name) = tool
            .get("function")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
        {
            let tool_name = name.to_lowercase();
            if user_lower.contains(&format!("use the {} tool", tool_name))
                || user_lower.contains(&format!("use the `{}` tool", tool_name))
                || user_lower.contains(&format!("use {} tool", tool_name))
                || user_lower.contains(&format!("use {} to ", tool_name))
                || user_lower.contains(&format!("call the {} tool", tool_name))
                || user_lower.contains(&format!("call {} with ", tool_name))
                || user_lower.contains(&format!("run the {} tool", tool_name))
                || user_lower.contains(&format!("invoke the {} tool", tool_name))
            {
                return Some(name.to_string());
            }
        }
    }

    None
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

    if final_answer_claims_external_action(&content_lower) {
        if has_tool_result_after_latest_user(&body.messages) {
            return None;
        }

        return Some(
            "the model claimed it already changed files, ran commands, or completed another external action without using a tool call".into(),
        );
    }

    if final_answer_contains_inline_tool_call_json(content) {
        return Some(
            "the model attempted to show tool-call JSON inline instead of returning a clean tool call or final answer block".into(),
        );
    }

    if let Some(name) = explicit_tool_request(body, tools) {
        return Some(format!(
            "the user explicitly requested the `{}` tool, but the model answered directly",
            name
        ));
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
    use super::{
        final_answer_claims_external_action, final_answer_contains_inline_tool_call_json,
        final_answer_requires_tool_retry, format_tool_result_message,
        has_tool_result_after_latest_user, inject_emulated_tool_prompt,
        looks_like_structured_payload, resolve_emulated_tool_name, should_accept_plain_text_final,
        should_retry_emulated_response, should_stream_emulated_incrementally,
    };
    use crate::providers::ChatMessage;
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
            reasoning_effort: None,
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
    fn final_answer_retry_does_not_trigger_for_incidental_tool_mentions() {
        let request = request_with_user_text(
            "Use the grill skill. It may eventually use read, write, grep, or bash, but first ask clarifying questions.",
            None,
        );
        let tools = vec![
            json!({ "type": "function", "function": { "name": "read" } }),
            json!({ "type": "function", "function": { "name": "write" } }),
            json!({ "type": "function", "function": { "name": "bash" } }),
        ];
        let err = final_answer_requires_tool_retry(
            &request,
            &tools,
            "Before I draft anything, what scope should the settings page cover?",
        );
        assert!(err.is_none());
    }

    #[test]
    fn incremental_streaming_stays_enabled_for_auto_tool_mode() {
        let request = request_with_user_text("Explain why Miranda is interesting.", None);
        let tools = vec![json!({ "type": "function", "function": { "name": "read" } })];
        assert!(should_stream_emulated_incrementally(&request, &tools));
    }

    #[test]
    fn incremental_streaming_is_disabled_for_explicit_tool_request() {
        let request = request_with_user_text("Use the bash tool to print the current directory.", None);
        let tools = vec![json!({ "type": "function", "function": { "name": "bash" } })];
        assert!(!should_stream_emulated_incrementally(&request, &tools));
    }

    #[test]
    fn auto_mode_does_not_retry_generic_parse_failures() {
        assert!(!should_retry_emulated_response(
            None,
            "response did not include a polychat block",
        ));
    }

    #[test]
    fn auto_mode_still_retries_tool_access_denials() {
        assert!(should_retry_emulated_response(
            None,
            "the model incorrectly denied having tool access",
        ));
    }

    #[test]
    fn auto_mode_accepts_plain_text_final_without_protocol_block() {
        assert!(should_accept_plain_text_final(
            None,
            "response did not include a polychat block",
            "QUESTION\nWhat is the goal of this work?",
        ));
    }

    #[test]
    fn required_mode_rejects_plain_text_final_without_protocol_block() {
        assert!(!should_accept_plain_text_final(
            Some(&Value::String("required".into())),
            "response did not include a polychat block",
            "QUESTION\nWhat is the goal of this work?",
        ));
    }

    #[test]
    fn structured_json_payload_is_not_accepted_as_plain_text_final() {
        let payload =
            "{\"name\":\"0001-generate-readme\",\"type\":\"document\",\"content\":\"hello\"}";
        assert!(looks_like_structured_payload(payload));
        assert!(!should_accept_plain_text_final(
            None,
            "response did not include a polychat block",
            payload,
        ));
    }

    #[test]
    fn detects_claimed_file_write_without_tool_call() {
        assert!(final_answer_claims_external_action(
            "spec written to ~/.pi/grill/cli-readme-generator/0001-generate-readme.md"
        ));
        assert!(final_answer_claims_external_action(
            "ready for: /go ~/.pi/grill/cli-readme-generator/0001-generate-readme.md"
        ));
    }

    #[test]
    fn allows_plain_text_question_without_external_action_claim() {
        let request = request_with_user_text("Start a grill session", None);
        let err = final_answer_requires_tool_retry(
            &request,
            &[],
            "QUESTION\nWhat is the goal of this work?\n\nOPTIONS\nA. ...\nB. ...",
        );
        assert!(err.is_none());
    }

    #[test]
    fn rejects_plain_text_final_that_claims_file_write() {
        let request = request_with_user_text("Write the final spec", None);
        let err = final_answer_requires_tool_retry(
            &request,
            &[],
            "Spec written to ~/.pi/grill/cli-readme-generator/0001-generate-readme.md",
        );
        assert!(err
            .unwrap()
            .contains("claimed it already changed files, ran commands, or completed another external action"));
    }

    #[test]
    fn detects_inline_tool_call_json_in_plain_text_answer() {
        assert!(final_answer_contains_inline_tool_call_json(
            "I can create it now. {\"name\":\"write\",\"arguments\":{\"path\":\"/tmp/spec.md\"}}"
        ));
    }

    #[test]
    fn retries_plain_text_answer_that_embeds_tool_call_json() {
        let request = request_with_user_text("Use /skill:grill to shape the spec", None);
        let err = final_answer_requires_tool_retry(
            &request,
            &[],
            "Here is the next action. {\"name\":\"write\",\"arguments\":{\"path\":\"/tmp/spec.md\"}}",
        );
        assert!(err
            .unwrap()
            .contains("attempted to show tool-call JSON inline"));
    }

    #[test]
    fn allows_action_summary_after_real_tool_result() {
        let mut request = request_with_user_text("Write the final spec", None);
        request.messages.push(CompletionMessage {
            role: "assistant".into(),
            content: Some(Value::String("Tool call call_1: write({\"path\":\"/tmp/spec.md\"})".into())),
            tool_call_id: None,
            name: None,
            tool_calls: None,
        });
        request.messages.push(CompletionMessage {
            role: "tool".into(),
            content: Some(Value::String("Successfully wrote 123 bytes to /tmp/spec.md".into())),
            tool_call_id: Some("call_1".into()),
            name: None,
            tool_calls: None,
        });

        let err = final_answer_requires_tool_retry(
            &request,
            &[],
            "Spec written to /tmp/spec.md\n\nReady for: /go /tmp/spec.md",
        );
        assert!(err.is_none());
    }

    #[test]
    fn detects_tool_result_after_latest_user() {
        let mut request = request_with_user_text("Write the final spec", None);
        request.messages.push(CompletionMessage {
            role: "tool".into(),
            content: Some(Value::String("ok".into())),
            tool_call_id: Some("call_1".into()),
            name: None,
            tool_calls: None,
        });

        assert!(has_tool_result_after_latest_user(&request.messages));
    }

    #[test]
    fn ignores_tool_result_before_latest_user() {
        let mut request = request_with_user_text("Write the final spec", None);
        request.messages.insert(0, CompletionMessage {
            role: "tool".into(),
            content: Some(Value::String("older tool result".into())),
            tool_call_id: Some("call_0".into()),
            name: None,
            tool_calls: None,
        });

        assert!(!has_tool_result_after_latest_user(&request.messages));
    }

    #[test]
    fn auto_mode_retries_inline_tool_call_json_failures() {
        assert!(should_retry_emulated_response(
            None,
            "the model attempted to show tool-call JSON inline instead of returning a clean tool call or final answer block",
        ));
    }

    #[test]
    fn auto_mode_retries_structured_payload_failures() {
        assert!(should_retry_emulated_response(
            None,
            "the model returned a structured JSON payload instead of a valid tool call block or plain final answer",
        ));
    }

    #[test]
    fn required_mode_still_retries_parse_failures() {
        assert!(should_retry_emulated_response(
            Some(&Value::String("required".into())),
            "response did not include a polychat block",
        ));
    }

    #[test]
    fn tool_results_are_rendered_as_system_context() {
        let messages = vec![ChatMessage {
            role: "tool".into(),
            content: "cwd is /tmp".into(),
            tool_call_id: Some("call_1".into()),
        }];

        let injected = inject_emulated_tool_prompt(&messages, &[], None);

        assert_eq!(injected[0].role, "system");
        assert!(injected[0].content.contains("tools are optional unless they are clearly necessary"));
        assert_eq!(injected[1].role, "system");
        assert_eq!(
            injected[1].content,
            format_tool_result_message(Some("call_1"), "cwd is /tmp")
        );
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
