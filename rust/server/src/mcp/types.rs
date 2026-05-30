use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum McpApprovalMode {
    Auto,
    Cautious,
    #[default]
    Ask,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum McpTransportConfig {
    Http {
        url: String,
    },
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpToolPolicy {
    #[serde(default)]
    pub approval: McpApprovalMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub approval: McpApprovalMode,
    #[serde(default, flatten)]
    pub transport: Option<McpTransportConfig>,
    #[serde(default)]
    pub tools: BTreeMap<String, McpToolPolicy>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpHostConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub servers: BTreeMap<String, McpServerConfig>,
}

impl Default for McpHostConfig {
    fn default() -> Self {
        Self {
            version: default_version(),
            servers: BTreeMap::new(),
        }
    }
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpToolDescriptor {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "inputSchema", default = "default_input_schema")]
    pub input_schema: Value,
}

fn default_input_schema() -> Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpToolRegistryEntry {
    pub name: String,
    pub server_id: String,
    pub original_name: String,
    pub description: String,
    pub input_schema: Value,
    pub approval: McpApprovalMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub id: String,
    pub enabled: bool,
    pub approval: McpApprovalMode,
    pub transport: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenAiToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenAiToolDefinition {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: OpenAiToolFunction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpCallRequest {
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpCallResult {
    pub content: String,
    pub is_error: bool,
}
