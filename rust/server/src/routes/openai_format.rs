use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use futures::StreamExt;
use serde::Serialize;
use uuid::Uuid;

use crate::providers::{ChatChunk, ChunkStream};
use crate::tools::parser::{ParsedChunk, ToolCallParser};

#[derive(Serialize)]
pub struct ChatCompletionResponse {
    pub id: String,
    pub object: &'static str,
    pub created: i64,
    pub model: String,
    pub choices: Vec<ChatCompletionChoice>,
    pub usage: Usage,
}

#[derive(Serialize)]
pub struct ChatCompletionChoice {
    pub index: u32,
    pub message: AssistantMessage,
    pub finish_reason: &'static str,
}

#[derive(Serialize)]
pub struct AssistantMessage {
    pub role: &'static str,
    pub content: Option<String>,
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Serialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: ToolFunction,
}

#[derive(Serialize)]
pub struct ToolFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Serialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

fn usage() -> Usage {
    Usage {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
    }
}

fn completion_response(
    request_id: &str,
    model: &str,
    message: AssistantMessage,
    finish_reason: &'static str,
) -> ChatCompletionResponse {
    ChatCompletionResponse {
        id: request_id.to_string(),
        object: "chat.completion",
        created: chrono::Utc::now().timestamp(),
        model: model.to_string(),
        choices: vec![ChatCompletionChoice {
            index: 0,
            message,
            finish_reason,
        }],
        usage: usage(),
    }
}

fn tool_call(name: String, arguments: String) -> ToolCall {
    ToolCall {
        id: format!("call_{}", Uuid::new_v4()),
        kind: "function",
        function: ToolFunction { name, arguments },
    }
}

#[derive(Serialize)]
struct ChatCompletionChunk {
    id: String,
    object: &'static str,
    created: i64,
    model: String,
    choices: Vec<ChatCompletionChunkChoice>,
}

#[derive(Serialize)]
struct ChatCompletionChunkChoice {
    index: u32,
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Serialize, Default)]
pub struct StreamDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<StreamToolCallDelta>>,
}

#[derive(Serialize)]
pub struct StreamToolCallDelta {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    pub function: StreamFunctionDelta,
}

#[derive(Serialize, Default)]
pub struct StreamFunctionDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
}

pub fn text_completion_response(request_id: &str, model: &str, content: String) -> ChatCompletionResponse {
    completion_response(
        request_id,
        model,
        AssistantMessage {
            role: "assistant",
            content: Some(content),
            tool_calls: None,
        },
        "stop",
    )
}

pub fn tool_call_completion_response(request_id: &str, model: &str, name: String, arguments: String) -> ChatCompletionResponse {
    completion_response(
        request_id,
        model,
        AssistantMessage {
            role: "assistant",
            content: None,
            tool_calls: Some(vec![tool_call(name, arguments)]),
        },
        "tool_calls",
    )
}

pub async fn non_stream_response(mut chunk_stream: ChunkStream, request_id: &str, model: &str, has_tools: bool) -> Json<ChatCompletionResponse> {
    let mut full_content = String::new();
    let mut parser = if has_tools { Some(ToolCallParser::new()) } else { None };
    let mut tool_calls = Vec::new();

    while let Some(result) = chunk_stream.next().await {
        match result {
            Ok(ChatChunk::Content(text)) => {
                if let Some(ref mut parser) = parser {
                    for parsed in parser.feed(ChatChunk::Content(text)) {
                        match parsed {
                            ParsedChunk::Content(t) => full_content.push_str(&t),
                            ParsedChunk::Thinking(_) => {}
                            ParsedChunk::ToolCall { name, arguments } => {
                                tool_calls.push(tool_call(name, arguments))
                            }
                        }
                    }
                } else {
                    full_content.push_str(&text);
                }
            }
            Ok(ChatChunk::Thinking(_)) => {}
            Err(_) => break,
        }
    }

    if let Some(ref mut parser) = parser {
        for parsed in parser.flush() {
            if let ParsedChunk::Content(t) = parsed {
                full_content.push_str(&t);
            }
        }
    }

    if tool_calls.is_empty() {
        Json(text_completion_response(request_id, model, full_content))
    } else {
        Json(completion_response(
            request_id,
            model,
            AssistantMessage {
                role: "assistant",
                content: None,
                tool_calls: Some(tool_calls),
            },
            "tool_calls",
        ))
    }
}

pub fn stream_response(mut chunk_stream: ChunkStream, request_id: &str, model: &str, has_tools: bool) -> axum::response::Response {
    let request_id = request_id.to_string();
    let model = model.to_string();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(256);

    tokio::spawn(async move {
        let mut parser = if has_tools { Some(ToolCallParser::new()) } else { None };
        let mut tool_call_index = 0;

        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { role: Some("assistant"), ..Default::default() }, None))).await;

        while let Some(result) = chunk_stream.next().await {
            match result {
                Ok(ChatChunk::Content(text)) => {
                    if let Some(ref mut parser) = parser {
                        for parsed in parser.feed(ChatChunk::Content(text)) {
                            match parsed {
                                ParsedChunk::Content(t) => {
                                    let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { content: Some(t), ..Default::default() }, None))).await;
                                }
                                ParsedChunk::Thinking(t) => {
                                    let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { reasoning_content: Some(t), ..Default::default() }, None))).await;
                                }
                                ParsedChunk::ToolCall { name, arguments } => {
                                    let call_id = format!("call_{}", Uuid::new_v4());
                                    let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta {
                                        tool_calls: Some(vec![StreamToolCallDelta {
                                            index: tool_call_index,
                                            id: Some(call_id),
                                            kind: Some("function"),
                                            function: StreamFunctionDelta { name: Some(name), arguments: Some(String::new()) },
                                        }]),
                                        ..Default::default()
                                    }, None))).await;

                                    for chunk in arguments.as_bytes().chunks(10) {
                                        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta {
                                            tool_calls: Some(vec![StreamToolCallDelta {
                                                index: tool_call_index,
                                                id: None,
                                                kind: None,
                                                function: StreamFunctionDelta { name: None, arguments: Some(String::from_utf8_lossy(chunk).to_string()) },
                                            }]),
                                            ..Default::default()
                                        }, None))).await;
                                    }

                                    tool_call_index += 1;
                                }
                            }
                        }
                    } else {
                        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { content: Some(text), ..Default::default() }, None))).await;
                    }
                }
                Ok(ChatChunk::Thinking(text)) => {
                    let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { reasoning_content: Some(text), ..Default::default() }, None))).await;
                }
                Err(e) => {
                    tracing::warn!("Stream error: {}", e);
                    break;
                }
            }
        }

        if let Some(ref mut parser) = parser {
            for parsed in parser.flush() {
                if let ParsedChunk::Content(t) = parsed {
                    let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { content: Some(t), ..Default::default() }, None))).await;
                }
            }
        }

        let finish_reason = if has_tools && tool_call_index > 0 { Some("tool_calls".to_string()) } else { Some("stop".to_string()) };
        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta::default(), finish_reason))).await;
        let _ = tx.send(Ok("data: [DONE]\n\n".into())).await;
    });

    event_stream_response(tokio_stream::wrappers::ReceiverStream::new(rx))
}

pub fn emulated_stream_text_response(request_id: &str, model: &str, content: String) -> axum::response::Response {
    let request_id = request_id.to_string();
    let model = model.to_string();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(16);

    tokio::spawn(async move {
        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { role: Some("assistant"), ..Default::default() }, None))).await;
        if !content.is_empty() {
            let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { content: Some(content), ..Default::default() }, None))).await;
        }
        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta::default(), Some("stop".to_string())))).await;
        let _ = tx.send(Ok("data: [DONE]\n\n".into())).await;
    });

    event_stream_response(tokio_stream::wrappers::ReceiverStream::new(rx))
}

pub fn emulated_stream_tool_call_response(request_id: &str, model: &str, name: &str, arguments: &str) -> axum::response::Response {
    let request_id = request_id.to_string();
    let model = model.to_string();
    let name = name.to_string();
    let arguments = arguments.to_string();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(16);

    tokio::spawn(async move {
        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta { role: Some("assistant"), ..Default::default() }, None))).await;
        let call_id = format!("call_{}", Uuid::new_v4());
        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta {
            tool_calls: Some(vec![StreamToolCallDelta {
                index: 0,
                id: Some(call_id),
                kind: Some("function"),
                function: StreamFunctionDelta { name: Some(name), arguments: Some(String::new()) },
            }]),
            ..Default::default()
        }, None))).await;

        for chunk in arguments.as_bytes().chunks(32) {
            let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta {
                tool_calls: Some(vec![StreamToolCallDelta {
                    index: 0,
                    id: None,
                    kind: None,
                    function: StreamFunctionDelta { name: None, arguments: Some(String::from_utf8_lossy(chunk).to_string()) },
                }]),
                ..Default::default()
            }, None))).await;
        }

        let _ = tx.send(Ok(format_sse_chunk(&request_id, &model, StreamDelta::default(), Some("tool_calls".to_string())))).await;
        let _ = tx.send(Ok("data: [DONE]\n\n".into())).await;
    });

    event_stream_response(tokio_stream::wrappers::ReceiverStream::new(rx))
}

pub(crate) fn event_stream_response<S>(stream: S) -> axum::response::Response
where
    S: futures::Stream<Item = Result<String, std::io::Error>> + Send + 'static,
{
    let body = Body::from_stream(stream);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/event-stream".to_string()),
            (header::CACHE_CONTROL, "no-cache".to_string()),
            (header::CONNECTION, "keep-alive".to_string()),
            (axum::http::header::HeaderName::from_static("x-accel-buffering"), "no".to_string()),
        ],
        body,
    ).into_response()
}

pub fn format_sse_chunk(id: &str, model: &str, delta: StreamDelta, finish_reason: Option<String>) -> String {
    let chunk = ChatCompletionChunk {
        id: id.to_string(),
        object: "chat.completion.chunk",
        created: chrono::Utc::now().timestamp(),
        model: model.to_string(),
        choices: vec![ChatCompletionChunkChoice { index: 0, delta, finish_reason }],
    };
    format!("data: {}\n\n", serde_json::to_string(&chunk).unwrap())
}

#[cfg(test)]
mod tests {
    use super::{format_sse_chunk, text_completion_response, tool_call_completion_response, StreamDelta, StreamFunctionDelta, StreamToolCallDelta};
    use serde_json::Value;

    #[test]
    fn tool_call_completion_response_has_expected_shape() {
        let response = tool_call_completion_response("chatcmpl-1", "deepseek-chat", "bash".into(), "{\"command\":\"pwd\"}".into());
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(value["choices"][0]["message"]["content"], Value::Null);
        assert_eq!(value["choices"][0]["message"]["tool_calls"][0]["function"]["name"], "bash");
    }

    #[test]
    fn text_completion_response_has_expected_shape() {
        let response = text_completion_response("chatcmpl-1", "claude-sonnet-4-6", "ok".into());
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["choices"][0]["finish_reason"], "stop");
        assert_eq!(value["choices"][0]["message"]["content"], "ok");
        assert_eq!(value["choices"][0]["message"]["tool_calls"], Value::Null);
    }

    #[test]
    fn format_sse_chunk_serializes_tool_call_delta() {
        let chunk = format_sse_chunk(
            "chatcmpl-1",
            "deepseek-chat",
            StreamDelta {
                tool_calls: Some(vec![StreamToolCallDelta {
                    index: 0,
                    id: Some("call_1".into()),
                    kind: Some("function"),
                    function: StreamFunctionDelta { name: Some("bash".into()), arguments: Some(String::new()) },
                }]),
                ..Default::default()
            },
            None,
        );
        assert!(chunk.contains("\"tool_calls\""));
        assert!(chunk.contains("\"name\":\"bash\""));
        assert!(chunk.contains("data: {"));
    }
}
