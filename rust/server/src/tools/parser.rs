//! Streaming tool call parser — detects <<<<>>>> blocks in provider output.

use crate::providers::ChatChunk;

const TOOL_START: &str = "<<<<";
const TOOL_END: &str = ">>>>";

#[derive(Debug, Clone)]
pub enum ParsedChunk {
    Content(String),
    Thinking(String),
    ToolCall { name: String, arguments: String },
}

#[derive(Debug)]
enum ParserState {
    Passthrough,
    MaybeStart { buf: String },
    Accumulating { buf: String },
}

pub struct ToolCallParser {
    state: ParserState,
}

impl ToolCallParser {
    pub fn new() -> Self {
        ToolCallParser {
            state: ParserState::Passthrough,
        }
    }

    pub fn feed(&mut self, chunk: ChatChunk) -> Vec<ParsedChunk> {
        match chunk {
            ChatChunk::Thinking(text) => vec![ParsedChunk::Thinking(text)],
            ChatChunk::Content(text) => self.feed_text(text),
        }
    }

    fn feed_text(&mut self, text: String) -> Vec<ParsedChunk> {
        let mut results = Vec::new();
        let mut remaining = text;

        while !remaining.is_empty() {
            match &mut self.state {
                ParserState::Passthrough => {
                    if let Some(pos) = remaining.find('<') {
                        let before = &remaining[..pos];
                        if !before.is_empty() {
                            results.push(ParsedChunk::Content(before.to_string()));
                        }
                        self.state = ParserState::MaybeStart {
                            buf: remaining[pos..].to_string(),
                        };
                        remaining = String::new();
                    } else {
                        results.push(ParsedChunk::Content(remaining.to_string()));
                        remaining = String::new();
                    }
                }
                ParserState::MaybeStart { buf } => {
                    buf.push_str(&remaining);
                    remaining = String::new();
                    if buf.starts_with(TOOL_START) {
                        let rest = buf[TOOL_START.len()..].to_string();
                        self.state = ParserState::Accumulating { buf: rest };
                    } else if buf.len() >= TOOL_START.len() {
                        results.push(ParsedChunk::Content(std::mem::take(buf)));
                        self.state = ParserState::Passthrough;
                    }
                }
                ParserState::Accumulating { buf } => {
                    buf.push_str(&remaining);
                    remaining = String::new();
                    if let Some(pos) = buf.find(TOOL_END) {
                        let json_str = buf[..pos].trim().to_string();
                        let after = buf[pos + TOOL_END.len()..].to_string();
                        if let Some(tc) = parse_tool_call_json(&json_str) {
                            results.push(tc);
                        } else {
                            results.push(ParsedChunk::Content(format!(
                                "{}{}{}",
                                TOOL_START, json_str, TOOL_END
                            )));
                        }
                        self.state = ParserState::Passthrough;
                        if !after.is_empty() {
                            remaining = after;
                        }
                    }
                }
            }
        }
        results
    }

    pub fn flush(&mut self) -> Vec<ParsedChunk> {
        match std::mem::replace(&mut self.state, ParserState::Passthrough) {
            ParserState::Passthrough => vec![],
            ParserState::MaybeStart { buf } => {
                if buf.is_empty() {
                    return vec![];
                }
                if buf.starts_with(TOOL_START) {
                    // Complete tool call in the buffer
                    let rest = buf[TOOL_START.len()..].to_string();
                    if let Some(pos) = rest.find(TOOL_END) {
                        let json_str = rest[..pos].trim().to_string();
                        if let Some(tc) = parse_tool_call_json(&json_str) {
                            return vec![tc];
                        }
                    }
                    // Incomplete — treat as content
                    vec![ParsedChunk::Content(buf)]
                } else {
                    vec![ParsedChunk::Content(buf)]
                }
            }
            ParserState::Accumulating { buf } => {
                // Try to parse if TOOL_END is present
                if let Some(pos) = buf.find(TOOL_END) {
                    let json_str = buf[..pos].trim().to_string();
                    if let Some(tc) = parse_tool_call_json(&json_str) {
                        return vec![tc];
                    }
                }
                // Incomplete or unparseable — emit as content
                vec![ParsedChunk::Content(format!("{}{}", TOOL_START, buf))]
            }
        }
    }
}

fn parse_tool_call_json(json_str: &str) -> Option<ParsedChunk> {
    let v: serde_json::Value = serde_json::from_str(json_str).ok()?;
    let name = v.get("name")?.as_str()?.to_string();
    let args = v.get("arguments").cloned().unwrap_or(serde_json::json!({}));
    let arguments = serde_json::to_string(&args).ok()?;
    Some(ParsedChunk::ToolCall { name, arguments })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_passthrough() {
        let mut p = ToolCallParser::new();
        let c = p.feed(ChatChunk::Content("Hello world".into()));
        assert!(matches!(&c[0], ParsedChunk::Content(t) if t == "Hello world"));
    }

    #[test]
    fn test_tool_call() {
        let mut p = ToolCallParser::new();
        let c = p.feed(ChatChunk::Content(
            r#"<<<<{"name": "read_file", "arguments": {"path": "/tmp"}}>>>>"#.into(),
        ));
        let f = p.flush();
        let all: Vec<_> = c.into_iter().chain(f).collect();
        assert!(matches!(&all[0], ParsedChunk::ToolCall { name, .. } if name == "read_file"));
    }

    #[test]
    fn test_thinking() {
        let mut p = ToolCallParser::new();
        let c = p.feed(ChatChunk::Thinking("hmm".into()));
        assert!(matches!(&c[0], ParsedChunk::Thinking(t) if t == "hmm"));
    }
}
