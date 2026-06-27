//! Shared SSE stream framing — extracted from individual providers.
//!
//! Two frame modes:
//! - `Sse`: Standard server-sent events (`data:` lines, `\n\n` frame boundaries)
//! - `LineDelimited`: Line-delimited JSON (one JSON object per line)
//!
//! The `extract_frames` function is a pure, testable frame parser.
//! The `stream_sse_response` and `stream_line_response` functions handle
//! the async boilerplate (channel creation, tokio spawn, buffering).

use crate::providers::{ChatChunk, ChunkStream, ReceiverStream};
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Frame parser (pure, testable)
// ---------------------------------------------------------------------------

/// Frame delimiter modes.
#[derive(Clone, Copy)]
pub enum FrameMode {
    /// Standard SSE: frames separated by `\n\n`, `data:` prefix on each line.
    Sse,
    /// Line-delimited: each complete line is a data frame.
    LineDelimited,
}

/// Parsed frame content.
pub enum ParsedFrame {
    Data(String),
    Done,
}

/// Extract complete frames from a string buffer.
///
/// For SSE mode, splits on `\n\n`, extracts `data:` lines, handles `[DONE]`.
/// For LineDelimited mode, splits on `\n`.
///
/// Incomplete frames remain in the buffer for the next call.
pub fn extract_frames(buffer: &mut String, mode: FrameMode) -> Vec<ParsedFrame> {
    let mut frames = Vec::new();
    match mode {
        FrameMode::Sse => {
            while let Some(idx) = buffer.find("\n\n") {
                let frame = buffer[..idx].to_string();
                *buffer = buffer[idx + 2..].to_string();
                for line in frame.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                        continue;
                    }
                    if let Some(data) = line.strip_prefix("data:") {
                        let data = data.trim();
                        if data == "[DONE]" {
                            frames.push(ParsedFrame::Done);
                            return frames;
                        }
                        frames.push(ParsedFrame::Data(data.to_string()));
                    }
                }
            }
        }
        FrameMode::LineDelimited => {
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].to_string();
                *buffer = buffer[pos + 1..].to_string();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                frames.push(ParsedFrame::Data(trimmed.to_string()));
            }
        }
    }
    frames
}

// ---------------------------------------------------------------------------
// Handler output
// ---------------------------------------------------------------------------

/// What a frame handler returns for each data frame.
pub enum HandlerAction {
    /// Emit these chunks through the stream channel.
    Emit(Vec<anyhow::Result<ChatChunk>>),
    /// The stream is done (e.g. provider-specific termination signal).
    /// No more frames will be processed.
    Done,
}

// ---------------------------------------------------------------------------
// Async stream wrappers
// ---------------------------------------------------------------------------

/// Stream an SSE-framed HTTP response, calling a handler for each data frame.
///
/// The handler returns `HandlerAction::Emit(chunks)` to emit chunks, or
/// `HandlerAction::Done` to signal stream termination (for providers like
/// Claude that use `message_stop` instead of `[DONE]`).
///
/// Providers that need side channels (e.g. oneshot for conversation_id capture)
/// should wrap them in `std::sync::Mutex<Option<oneshot::Sender>>` inside
/// their handler closure.
pub fn stream_sse_response<F>(response: reqwest::Response, handler: F) -> ChunkStream
where
    F: Fn(&str) -> HandlerAction + Send + 'static,
{
    stream_response_inner(response, FrameMode::Sse, handler)
}

/// Stream a line-delimited HTTP response, calling a handler for each line.
pub fn stream_line_response<F>(response: reqwest::Response, handler: F) -> ChunkStream
where
    F: Fn(&str) -> HandlerAction + Send + 'static,
{
    stream_response_inner(response, FrameMode::LineDelimited, handler)
}

fn stream_response_inner<F>(response: reqwest::Response, mode: FrameMode, handler: F) -> ChunkStream
where
    F: Fn(&str) -> HandlerAction + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<anyhow::Result<ChatChunk>>(256);

    tokio::spawn(async move {
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
        use futures::StreamExt;

        while let Some(chunk_result) = stream.next().await {
            let bytes = match chunk_result {
                Ok(b) => b,
                Err(e) => {
                    let _ = tx.send(Err(anyhow::anyhow!("stream error: {}", e))).await;
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));

            for frame in extract_frames(&mut buffer, mode) {
                match frame {
                    ParsedFrame::Done => return,
                    ParsedFrame::Data(data) => match handler(&data) {
                        HandlerAction::Emit(chunks) => {
                            for chunk in chunks {
                                let _ = tx.send(chunk).await;
                            }
                        }
                        HandlerAction::Done => return,
                    },
                }
            }
        }
    });

    Box::pin(ReceiverStream::new(rx))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_extracts_data_from_simple_frame() {
        let mut buf = "data: hello\n\n".to_string();
        let frames = extract_frames(&mut buf, FrameMode::Sse);
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            ParsedFrame::Data(s) => assert_eq!(s, "hello"),
            ParsedFrame::Done => panic!("expected Data, got Done"),
        }
    }

    #[test]
    fn sse_handles_done_signal() {
        let mut buf = "data: [DONE]\n\n".to_string();
        let frames = extract_frames(&mut buf, FrameMode::Sse);
        assert_eq!(frames.len(), 1);
        assert!(matches!(&frames[0], ParsedFrame::Done));
    }

    #[test]
    fn sse_skips_event_and_comment_lines() {
        let mut buf = "event: ping\n: keepalive\ndata: {\"type\":\"text\"}\n\n".to_string();
        let frames = extract_frames(&mut buf, FrameMode::Sse);
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            ParsedFrame::Data(s) => assert_eq!(s, "{\"type\":\"text\"}"),
            _ => panic!("expected Data"),
        }
    }

    #[test]
    fn sse_handles_multiple_data_lines_in_one_frame() {
        let mut buf = "data: line1\ndata: line2\n\n".to_string();
        let frames = extract_frames(&mut buf, FrameMode::Sse);
        assert_eq!(frames.len(), 2);
        match &frames[0] {
            ParsedFrame::Data(s) => assert_eq!(s, "line1"),
            _ => panic!("expected Data"),
        }
        match &frames[1] {
            ParsedFrame::Data(s) => assert_eq!(s, "line2"),
            _ => panic!("expected Data"),
        }
    }

    #[test]
    fn sse_partial_frame_stays_in_buffer() {
        let mut buf = "data: partial".to_string();
        let frames = extract_frames(&mut buf, FrameMode::Sse);
        assert!(frames.is_empty());
        assert_eq!(buf, "data: partial");
    }

    #[test]
    fn sse_second_call_continues_after_incomplete_frame() {
        let mut buf = "data: hel".to_string();
        let frames = extract_frames(&mut buf, FrameMode::Sse);
        assert!(frames.is_empty());

        buf.push_str("lo\n\n");
        let frames = extract_frames(&mut buf, FrameMode::Sse);
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            ParsedFrame::Data(s) => assert_eq!(s, "hello"),
            _ => panic!("expected Data"),
        }
    }

    #[test]
    fn line_mode_extracts_complete_lines() {
        let mut buf = "{\"event\":\"cmpl\",\"text\":\"hi\"}\n".to_string();
        let frames = extract_frames(&mut buf, FrameMode::LineDelimited);
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            ParsedFrame::Data(s) => assert_eq!(s, "{\"event\":\"cmpl\",\"text\":\"hi\"}"),
            _ => panic!("expected Data"),
        }
    }

    #[test]
    fn line_mode_skips_empty_lines() {
        let mut buf = "\n{\"data\":true}\n\n".to_string();
        let frames = extract_frames(&mut buf, FrameMode::LineDelimited);
        assert_eq!(frames.len(), 1);
    }

    #[test]
    fn line_mode_partial_line_stays_in_buffer() {
        let mut buf = "partial".to_string();
        let frames = extract_frames(&mut buf, FrameMode::LineDelimited);
        assert!(frames.is_empty());
        assert_eq!(buf, "partial");
    }
}
