//! POST /v1/chat/completions.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::providers::{ChatOptions, Provider, ToolCallStrategy};
pub use crate::routes::completion_messages::CompletionRequest;
use crate::routes::completion_messages::{
    completion_messages_to_provider_messages, has_tool_transcript,
};
use crate::routes::emulated_completion::emulated_completion_response;
use crate::routes::conversation_tracker::{TRACKER, tracked_conversation_id};
use crate::routes::errors::RouteError;
use crate::routes::openai_format::{non_stream_response, stream_response};
use crate::routes::resolver::find_provider_for_model;
use crate::tools::inject::inject_tools;

fn error_response(status: StatusCode, message: &str, err_type: &'static str, code: &'static str) -> axum::response::Response {
    RouteError::new(status, message, err_type, code).into_response()
}

pub async fn completions_handler(
    Json(body): Json<CompletionRequest>,
    providers: Arc<HashMap<String, Arc<dyn Provider>>>,
) -> impl IntoResponse {
    let model = &body.model;
    if model.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Missing model",
            "invalid_request_error",
            "missing_model",
        ).into_response();
    }

    let resolved = find_provider_for_model(model, &providers, 15).await;
    let (provider, provider_id) = match resolved {
        Some(r) => r,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                &format!("Model '{}' not found for any connected provider.", model),
                "invalid_request_error",
                "model_not_found",
            ).into_response();
        }
    };

    let provider_messages = completion_messages_to_provider_messages(&body.messages);

    let has_tools = body.tools.as_ref().map_or(false, |t| !t.is_empty());
    let has_tool_history = has_tool_transcript(&body.messages);
    let tool_strategy = provider.tool_call_strategy();

    let mut options = ChatOptions {
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        stop: body.stop.clone(),
        tools: Vec::new(),
        tool_choice: None,
    };

    let mut messages = provider_messages.clone();
    let conv_id_to_use = body.provider_conversation_id.clone().or_else(|| {
        tracked_conversation_id(&provider_id, &provider_messages)
    });

    if has_tools || (tool_strategy == ToolCallStrategy::Emulated && has_tool_history) {
        match tool_strategy {
            ToolCallStrategy::Native => {
                options.tools = body.tools.clone().unwrap_or_default();
                options.tool_choice = body.tool_choice.clone();
            }
            ToolCallStrategy::PromptInjected => {
                let tools = body.tools.as_deref().unwrap_or(&[]);
                messages = inject_tools(&messages, tools, body.tool_choice.as_ref());
            }
            ToolCallStrategy::Emulated => {
                return emulated_completion_response(
                    &body,
                    provider,
                    provider_id,
                    provider_messages,
                    conv_id_to_use,
                    &format!("chatcmpl-{}", Uuid::new_v4()),
                ).await;
            }
        }
    }

    let provider_response = match provider.send_message(
        &messages,
        model,
        &options,
        conv_id_to_use.as_deref(),
    ).await {
        Ok(r) => r,
        Err(e) => {
            let msg = e.to_string();
            if msg.to_lowercase().contains("expired") {
                return error_response(
                    StatusCode::UNAUTHORIZED, &msg,
                    "authentication_error", "session_expired",
                ).into_response();
            }
            if msg.to_lowercase().contains("rate limit") {
                return error_response(
                    StatusCode::TOO_MANY_REQUESTS, &msg,
                    "rate_limit_error", "rate_limited",
                ).into_response();
            }
            return error_response(
                StatusCode::BAD_GATEWAY, &msg,
                "upstream_error", "upstream_error",
            ).into_response();
        }
    };

    if let Some(ref cid) = provider_response.conversation_id {
        TRACKER.store(&provider_messages, &provider_id, cid.clone());
    }

    let request_id = format!("chatcmpl-{}", Uuid::new_v4());
    let stream = body.stream;

    if stream {
        stream_response(provider_response.stream, &request_id, model, has_tools).into_response()
    } else {
        non_stream_response(provider_response.stream, &request_id, model, has_tools).await.into_response()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn detects_tool_transcript_from_assistant_tool_calls_and_tool_result() {
        use crate::routes::completion_messages::{
            CompletionMessage, CompletionToolCall, CompletionToolFunction, has_tool_transcript,
        };
        use serde_json::Value;

        let messages = vec![
            CompletionMessage {
                role: "assistant".into(),
                content: None,
                tool_call_id: None,
                name: None,
                tool_calls: Some(vec![CompletionToolCall {
                    id: "call_1".into(),
                    kind: "function".into(),
                    function: CompletionToolFunction {
                        name: "bash".into(),
                        arguments: "{\"command\":\"pwd\"}".into(),
                    },
                }]),
            },
            CompletionMessage {
                role: "tool".into(),
                content: Some(Value::String("/tmp".into())),
                tool_call_id: Some("call_1".into()),
                name: None,
                tool_calls: None,
            },
        ];

        assert!(has_tool_transcript(&messages));
    }
}
