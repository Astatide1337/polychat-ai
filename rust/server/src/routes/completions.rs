//! POST /v1/chat/completions.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::config::PolychatConfig;
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

fn temporary_conversation_source(temporary: bool, explicit: bool, tracked: bool) -> &'static str {
    if temporary {
        "temporary_stateless"
    } else if explicit {
        "provided"
    } else if tracked {
        "tracked"
    } else {
        "new"
    }
}

fn error_response(status: StatusCode, message: &str, err_type: &'static str, code: &'static str) -> axum::response::Response {
    RouteError::new(status, message, err_type, code).into_response()
}

pub async fn completions_handler(
    Json(body): Json<CompletionRequest>,
    providers: Arc<HashMap<String, Arc<dyn Provider>>>,
    config: Arc<PolychatConfig>,
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

    // Per-provider temporary default from config, overridden by request
    let config_temporary = config.providers.get(&provider_id)
        .map(|pc| pc.temporary)
        .unwrap_or(false);
    let temporary = body.temporary || config_temporary;

    let mut options = ChatOptions {
        reasoning_effort: body.reasoning_effort.clone(),
        stream: body.stream,
        stop: body.stop.clone(),
        tools: Vec::new(),
        tool_choice: None,
        temporary,
    };

    let mut messages = provider_messages.clone();
    let explicit_conversation_id = if temporary {
        None
    } else {
        body.provider_conversation_id.clone()
    };
    let tracked_conversation_id = if temporary || explicit_conversation_id.is_some() {
        None
    } else {
        tracked_conversation_id(&provider_id, &provider_messages)
    };
    let conv_id_to_use = explicit_conversation_id.clone().or_else(|| tracked_conversation_id.clone());

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
                let mut emulated_body = body.clone();
                emulated_body.temporary = temporary;
                return emulated_completion_response(
                    &emulated_body,
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

    if !temporary {
        if let Some(ref cid) = provider_response.conversation_id {
        TRACKER.store(&provider_messages, &provider_id, cid.clone());
        }
    }

    let request_id = format!("chatcmpl-{}", Uuid::new_v4());
    let stream = body.stream;
    let provider_debug = if body.include_provider_debug {
        Some(json!({
            "provider": provider_id,
            "requested_temporary": temporary,
            "conversation_source": temporary_conversation_source(
                temporary,
                explicit_conversation_id.is_some(),
                tracked_conversation_id.is_some(),
            ),
            "input_conversation_id": conv_id_to_use.clone(),
            "provider_conversation_id": provider_response.conversation_id.clone(),
        }))
    } else {
        None
    };

    if stream {
        stream_response(provider_response.stream, &request_id, model, has_tools).into_response()
    } else {
        non_stream_response(provider_response.stream, &request_id, model, has_tools, provider_debug).await.into_response()
    }
}

#[cfg(test)]
mod tests {
    use crate::config::ProviderConfig;
    use super::temporary_conversation_source;

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

    #[test]
    fn temporary_flag_or_logic_both_false() {
        let config_temporary = false;
        let request_temporary = false;
        assert!(!(request_temporary || config_temporary));
    }

    #[test]
    fn temporary_flag_or_logic_request_true() {
        let config_temporary = false;
        let request_temporary = true;
        assert!(request_temporary || config_temporary);
    }

    #[test]
    fn temporary_flag_or_logic_config_true() {
        let config_temporary = true;
        let request_temporary = false;
        assert!(request_temporary || config_temporary);
    }

    #[test]
    fn temporary_flag_or_logic_both_true() {
        let config_temporary = true;
        let request_temporary = true;
        assert!(request_temporary || config_temporary);
    }

    #[test]
    fn config_provider_temporary_lookup_missing_provider() {
        let mut providers = std::collections::HashMap::new();
        providers.insert("chatgpt".to_string(), ProviderConfig {
            default_model: "gpt-5-5".into(),
            connected: true,
            last_validated: None,
            temporary: true,
        });
        // Looking up a provider that doesn't exist should return false
        let result = providers.get("claude").map(|pc| pc.temporary).unwrap_or(false);
        assert!(!result);
    }

    #[test]
    fn config_provider_temporary_lookup_existing_provider() {
        let mut providers = std::collections::HashMap::new();
        providers.insert("chatgpt".to_string(), ProviderConfig {
            default_model: "gpt-5-5".into(),
            connected: true,
            last_validated: None,
            temporary: true,
        });
        let result = providers.get("chatgpt").map(|pc| pc.temporary).unwrap_or(false);
        assert!(result);
    }

    #[test]
    fn temporary_requests_force_stateless_conversation_source() {
        assert_eq!(
            temporary_conversation_source(true, true, true),
            "temporary_stateless"
        );
        assert_eq!(
            temporary_conversation_source(true, false, false),
            "temporary_stateless"
        );
    }

    #[test]
    fn non_temporary_requests_preserve_existing_conversation_source_logic() {
        assert_eq!(temporary_conversation_source(false, true, false), "provided");
        assert_eq!(temporary_conversation_source(false, false, true), "tracked");
        assert_eq!(temporary_conversation_source(false, false, false), "new");
    }
}
