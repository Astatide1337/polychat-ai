//! POST /api/generate.

use axum::body::Body;
use axum::http::header;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;

use crate::config::PolychatConfig;
use crate::providers::{ChatChunk, ChatMessage, ChatOptions};
use crate::router::{Providers, SharedModelRegistry};
use crate::routes::errors::RouteError;

#[derive(Deserialize)]
pub struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub temporary: bool,
}

pub async fn generate_handler(
    Json(body): Json<GenerateRequest>,
    _providers: Providers,
    config: std::sync::Arc<PolychatConfig>,
    registry: SharedModelRegistry,
) -> impl IntoResponse {
    let mut messages = Vec::new();
    if let Some(system) = &body.system {
        messages.push(ChatMessage {
            role: "system".into(),
            content: system.clone(),
            tool_call_id: None,
        });
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: body.prompt.clone(),
        tool_call_id: None,
    });

    let (provider, provider_id) = {
        let reg = registry.read().await;
        match reg.find_provider(&body.model) {
            Some((provider, provider_id)) => (provider, provider_id),
            None => {
                return RouteError::new(
                    StatusCode::NOT_FOUND,
                    format!("Model '{}' not found", body.model),
                    "invalid_request_error",
                    "model_not_found",
                )
                .into_response();
            }
        }
    };

    let config_temporary = config
        .providers
        .get(&provider_id)
        .map(|pc| pc.temporary)
        .unwrap_or(false);

    let options = ChatOptions {
        reasoning_effort: None,
        stream: body.stream,
        stop: vec![],
        tools: Vec::new(),
        tool_choice: None,
        temporary: body.temporary || config_temporary,
    };

    let provider_response = match provider
        .send_message(&messages, &body.model, &options, None)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return RouteError::new(
                StatusCode::BAD_GATEWAY,
                e.to_string(),
                "upstream_error",
                "upstream_error",
            )
            .into_response();
        }
    };
    let chunk_stream = provider_response.stream;

    if body.stream {
        stream_ollama_response(chunk_stream, &body.model).into_response()
    } else {
        non_stream_ollama_response(chunk_stream, &body.model)
            .await
            .into_response()
    }
}

fn stream_ollama_response(
    mut chunk_stream: crate::providers::ChunkStream,
    model: &str,
) -> impl IntoResponse {
    let model = model.to_string();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(256);

    tokio::spawn(async move {
        while let Some(result) = chunk_stream.next().await {
            match result {
                Ok(ChatChunk::Content(text)) => {
                    let line = json!({
                        "model": model,
                        "created_at": chrono::Utc::now().to_rfc3339(),
                        "response": text,
                        "done": false,
                    })
                    .to_string()
                        + "\n";
                    let _ = tx.send(Ok(line)).await;
                }
                Ok(ChatChunk::Thinking(_)) => {}
                Err(_) => break,
            }
        }

        let done_line = json!({
            "model": model,
            "created_at": chrono::Utc::now().to_rfc3339(),
            "response": "",
            "done": true,
            "done_reason": "stop",
        })
        .to_string()
            + "\n";
        let _ = tx.send(Ok(done_line)).await;
    });

    let body_stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let body = Body::from_stream(body_stream);

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/x-ndjson".to_string())],
        body,
    )
}

async fn non_stream_ollama_response(
    mut chunk_stream: crate::providers::ChunkStream,
    model: &str,
) -> impl IntoResponse {
    let mut full_response = String::new();

    while let Some(result) = chunk_stream.next().await {
        if let Ok(ChatChunk::Content(text)) = result {
            full_response.push_str(&text);
        }
    }

    Json(json!({
        "model": model,
        "created_at": chrono::Utc::now().to_rfc3339(),
        "response": full_response,
        "done": true,
        "done_reason": "stop",
    }))
}

#[cfg(test)]
mod tests {
    use super::GenerateRequest;
    use crate::config::{PolychatConfig, ProviderConfig, ServerConfig};
    use std::collections::HashMap;

    fn resolve_temporary(
        request_temporary: bool,
        provider_id: &str,
        config: &PolychatConfig,
    ) -> bool {
        let config_temporary = config
            .providers
            .get(provider_id)
            .map(|pc| pc.temporary)
            .unwrap_or(false);
        request_temporary || config_temporary
    }

    fn sample_config(chatgpt_temporary: bool) -> PolychatConfig {
        let mut providers = HashMap::new();
        providers.insert(
            "chatgpt".into(),
            ProviderConfig {
                default_model: "gpt-5-5-instant".into(),
                connected: true,
                last_validated: None,
                temporary: chatgpt_temporary,
            },
        );

        PolychatConfig {
            default_model: "gpt-5-5-instant".into(),
            server: ServerConfig {
                port: 1443,
                host: "127.0.0.1".into(),
            },
            session_salt: "test-salt".into(),
            providers,
        }
    }

    #[test]
    fn generate_request_temporary_defaults_to_false() {
        let request: GenerateRequest = serde_json::from_value(serde_json::json!({
            "model": "gpt-5-5-instant",
            "prompt": "hello"
        }))
        .expect("request should deserialize");

        assert!(!request.temporary);
    }

    #[test]
    fn generate_request_temporary_deserializes_true() {
        let request: GenerateRequest = serde_json::from_value(serde_json::json!({
            "model": "gpt-5-5-instant",
            "prompt": "hello",
            "temporary": true
        }))
        .expect("request should deserialize");

        assert!(request.temporary);
    }

    #[test]
    fn generate_temporary_uses_provider_default() {
        let config = sample_config(true);
        assert!(resolve_temporary(false, "chatgpt", &config));
    }

    #[test]
    fn generate_temporary_request_overrides_missing_provider_default() {
        let config = sample_config(false);
        assert!(resolve_temporary(true, "chatgpt", &config));
    }
}
