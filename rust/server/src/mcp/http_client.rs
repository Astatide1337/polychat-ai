use crate::mcp::types::{McpCallResult, McpToolDescriptor};
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::time::Duration;

const MCP_HTTP_TIMEOUT_SECS: u64 = 30;
const MCP_OUTPUT_MAX_CHARS: usize = 20_000;

#[derive(Debug, Clone)]
pub struct HttpMcpClient {
    url: String,
    client: reqwest::Client,
}

impl HttpMcpClient {
    pub fn new(url: impl Into<String>) -> Result<Self> {
        let url = url.into();
        if url.trim().is_empty() {
            bail!("MCP HTTP url cannot be empty");
        }
        Ok(Self {
            url,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(MCP_HTTP_TIMEOUT_SECS))
                .build()
                .context("failed to build MCP HTTP client")?,
        })
    }

    pub async fn list_tools(&self) -> Result<Vec<McpToolDescriptor>> {
        let result = self
            .rpc("tools/list", json!({}))
            .await
            .context("MCP tools/list failed")?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        tools
            .into_iter()
            .map(|tool| serde_json::from_value(tool).context("failed to parse MCP tool descriptor"))
            .collect()
    }

    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<McpCallResult> {
        let result = self
            .rpc(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await
            .with_context(|| format!("MCP tools/call failed for {name}"))?;
        Ok(normalize_call_result(result))
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let res = self
            .client
            .post(&self.url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params
            }))
            .send()
            .await
            .with_context(|| format!("failed to send MCP request to {}", self.url))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .with_context(|| format!("failed to parse MCP response from {}", self.url))?;
        if !status.is_success() {
            bail!("MCP HTTP error {status}: {body}");
        }
        if let Some(error) = body.get("error") {
            bail!("MCP JSON-RPC error: {error}");
        }
        body.get("result")
            .cloned()
            .ok_or_else(|| anyhow!("MCP response missing result"))
    }
}

fn normalize_call_result(result: Value) -> McpCallResult {
    let is_error = result
        .get("isError")
        .or_else(|| result.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut parts = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                parts.push(text.to_string());
            } else if let Some(value) = item.get("data") {
                parts.push(value.to_string());
            } else {
                parts.push(item.to_string());
            }
        }
    } else if let Some(text) = result.get("text").and_then(Value::as_str) {
        parts.push(text.to_string());
    } else {
        parts.push(result.to_string());
    }

    let mut content = parts.join("\n");
    if content.chars().count() > MCP_OUTPUT_MAX_CHARS {
        content = content
            .chars()
            .take(MCP_OUTPUT_MAX_CHARS)
            .collect::<String>()
            + "\n... (truncated MCP output)";
    }

    McpCallResult { content, is_error }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_text_content_results() {
        let result = normalize_call_result(json!({
            "content": [{ "type": "text", "text": "hello" }],
            "isError": false
        }));
        assert_eq!(result.content, "hello");
        assert!(!result.is_error);
    }

    #[test]
    fn normalizes_error_results() {
        let result = normalize_call_result(json!({
            "content": [{ "type": "text", "text": "boom" }],
            "isError": true
        }));
        assert_eq!(result.content, "boom");
        assert!(result.is_error);
    }
}
