//! POST /api/generate.

use axum::body::Body;
use axum::http::header;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;

use crate::providers::{ChatChunk, ChatMessage, ChatOptions};
use crate::routes::errors::RouteError;
use crate::routes::resolver::{Providers, find_provider_for_model};

#[derive(Deserialize)]
pub struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub stream: bool,
    pub options: Option<GenerateOptions>,
}

#[derive(Deserialize)]
pub struct GenerateOptions {
    pub temperature: Option<f32>,
    pub num_predict: Option<u32>,
}

pub async fn generate_handler(
    Json(body): Json<GenerateRequest>,
    providers: Providers,
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

    let options = ChatOptions {
        temperature: body.options.as_ref().and_then(|o| o.temperature),
        max_tokens: body.options.as_ref().and_then(|o| o.num_predict),
        reasoning_effort: None,
        stream: body.stream,
        stop: vec![],
        tools: Vec::new(),
        tool_choice: None,
    };

    let provider = match find_provider_for_model(&body.model, &providers, 15).await {
        Some((provider, _provider_id)) => provider,
        None => {
            return RouteError::new(
                StatusCode::NOT_FOUND,
                format!("Model '{}' not found", body.model),
                "invalid_request_error",
                "model_not_found",
            ).into_response();
        }
    };

    let provider_response = match provider.send_message(&messages, &body.model, &options, None).await {
        Ok(r) => r,
        Err(e) => {
            return RouteError::new(
                StatusCode::BAD_GATEWAY,
                e.to_string(),
                "upstream_error",
                "upstream_error",
            ).into_response();
        }
    };
    let chunk_stream = provider_response.stream;

    if body.stream {
        stream_ollama_response(chunk_stream, &body.model).into_response()
    } else {
        non_stream_ollama_response(chunk_stream, &body.model).await.into_response()
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
                    }).to_string() + "\n";
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
        }).to_string() + "\n";
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
