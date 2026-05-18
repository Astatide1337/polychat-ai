//! Shared SSE stream parser for all providers.
//!
//! Uses `async_stream::stream!` to produce chunks without spawning a separate
//! task, avoiding potential executor-related issues with tokio::spawn in
//! middleware contexts.

use anyhow::Result;
use futures::Stream;
use reqwest::Response;
use super::ReceiverStream;
#[allow(dead_code)]
pub struct SseFrame {
    pub event: Option<String>,
    pub data: Option<String>,
}

/// Parse a raw SSE response stream into a stream of SseFrame values.
///
/// Claude sends `event:` and `data:` as separate frames (each terminated by \n\n).
/// DeepSeek sends everything in the same frame.
/// We handle both by accumulating frames.
#[allow(dead_code)]
pub fn parse_sse_stream(
    response: Response,
    on_frame: impl Fn(&str) -> Option<Vec<crate::providers::ChatChunk>> + Send + 'static,
) -> impl Stream<Item = Result<crate::providers::ChatChunk>> {
    use futures::StreamExt;

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<crate::providers::ChatChunk>>(256);

    tokio::spawn(async move {
        let mut pending = String::new();
        let mut byte_stream = response.bytes_stream();

        while let Some(result) = byte_stream.next().await {
            match result {
                Err(e) => {
                    let _ = tx.send(Err(anyhow::anyhow!("SSE stream error: {}", e))).await;
                    return;
                }
                Ok(bytes) => {
                    pending.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(idx) = pending.find("\n\n") {
                        let frame = pending[..idx].to_string();
                        pending = pending[idx + 2..].to_string();

                        for line in frame.lines() {
                            let line = line.trim();
                            if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                                continue;
                            }
                            if let Some(data) = line.strip_prefix("data:") {
                                let data = data.trim();
                                if data == "[DONE]" {
                                    return;
                                }
                                if let Some(chunks) = on_frame(data) {
                                    for chunk in chunks {
                                        if tx.send(Ok(chunk)).await.is_err() {
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    ReceiverStream::new(rx)
}
