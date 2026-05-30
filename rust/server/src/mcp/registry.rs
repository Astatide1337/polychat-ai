use crate::mcp::types::{
    McpApprovalMode, McpHostConfig, McpServerStatus, McpToolDescriptor, McpToolRegistryEntry,
    McpTransportConfig, OpenAiToolDefinition, OpenAiToolFunction,
};
use anyhow::{Result, bail};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Default)]
pub struct McpToolRegistry {
    entries: BTreeMap<String, McpToolRegistryEntry>,
}

impl McpToolRegistry {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn get(&self, name: &str) -> Option<&McpToolRegistryEntry> {
        self.entries.get(name)
    }

    pub fn openai_tools(&self) -> Vec<OpenAiToolDefinition> {
        self.entries
            .values()
            .map(|entry| OpenAiToolDefinition {
                kind: "function".to_string(),
                function: OpenAiToolFunction {
                    name: entry.name.clone(),
                    description: format!("[MCP: {}] {}", entry.server_id, entry.description),
                    parameters: entry.input_schema.clone(),
                },
            })
            .collect()
    }

    fn insert(&mut self, entry: McpToolRegistryEntry) -> Result<()> {
        if self.entries.contains_key(&entry.name) {
            bail!("duplicate MCP tool name: {}", entry.name);
        }
        self.entries.insert(entry.name.clone(), entry);
        Ok(())
    }
}

fn registry_entry(
    exposed_name: String,
    server_id: &str,
    server_approval: McpApprovalMode,
    descriptor: McpToolDescriptor,
) -> McpToolRegistryEntry {
    McpToolRegistryEntry {
        name: exposed_name,
        server_id: server_id.to_string(),
        original_name: descriptor.name,
        description: descriptor.description,
        input_schema: descriptor.input_schema,
        approval: server_approval,
    }
}

pub fn normalize_tool_name(tool_name: &str) -> String {
    normalize_segment(tool_name)
}

fn prefixed_tool_name(server_id: &str, tool_name: &str) -> String {
    format!(
        "{}_{}",
        normalize_segment(server_id),
        normalize_segment(tool_name)
    )
}

fn normalize_segment(input: &str) -> String {
    let mut out = String::new();
    let mut last_was_underscore = false;
    for ch in input.chars() {
        let normalized = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else {
            '_'
        };
        if normalized == '_' {
            if !last_was_underscore && !out.is_empty() {
                out.push('_');
            }
            last_was_underscore = true;
        } else {
            out.push(normalized);
            last_was_underscore = false;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        "unnamed".to_string()
    } else {
        out
    }
}

pub fn server_statuses(config: &McpHostConfig) -> Vec<McpServerStatus> {
    config
        .servers
        .iter()
        .map(|(id, server)| McpServerStatus {
            id: id.clone(),
            enabled: server.enabled,
            approval: server.approval,
            transport: match &server.transport {
                Some(McpTransportConfig::Http { .. }) => "http".to_string(),
                Some(McpTransportConfig::Stdio { .. }) => "stdio".to_string(),
                None => "unconfigured".to_string(),
            },
        })
        .collect()
}

pub fn validate_config(config: &McpHostConfig) -> Result<()> {
    let mut normalized_servers = BTreeSet::new();
    for id in config.servers.keys() {
        let normalized = normalize_segment(id);
        if !normalized_servers.insert(normalized.clone()) {
            bail!("duplicate normalized MCP server id: {normalized}");
        }
    }
    Ok(())
}

pub async fn discover_registry_from_config(config: &McpHostConfig) -> Result<McpToolRegistry> {
    validate_config(config)?;

    let mut discovered = Vec::new();
    let mut name_counts: BTreeMap<String, usize> = BTreeMap::new();

    for (server_id, server) in &config.servers {
        if !server.enabled {
            continue;
        }
        match &server.transport {
            Some(McpTransportConfig::Http { url }) => {
                let client = crate::mcp::http_client::HttpMcpClient::new(url.clone())?;
                let tools = client.list_tools().await.map_err(|err| {
                    anyhow::anyhow!("failed to discover MCP tools for {server_id}: {err}")
                })?;
                for descriptor in tools {
                    let natural_name = normalize_tool_name(&descriptor.name);
                    *name_counts.entry(natural_name.clone()).or_insert(0) += 1;
                    discovered.push((server_id.clone(), server.approval, natural_name, descriptor));
                }
            }
            Some(McpTransportConfig::Stdio { .. }) | None => {}
        }
    }

    let mut registry = McpToolRegistry::empty();
    for (server_id, approval, natural_name, descriptor) in discovered {
        let exposed_name = if name_counts.get(&natural_name).copied().unwrap_or(0) == 1 {
            natural_name
        } else {
            prefixed_tool_name(&server_id, &descriptor.name)
        };
        registry.insert(registry_entry(
            exposed_name,
            &server_id,
            approval,
            descriptor,
        ))?;
    }

    Ok(registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::types::McpServerConfig;
    use serde_json::json;

    fn descriptor(name: &str) -> McpToolDescriptor {
        McpToolDescriptor {
            name: name.to_string(),
            description: format!("{name} description"),
            input_schema: json!({"type":"object"}),
        }
    }

    #[test]
    fn normalizes_tool_names_for_model_facing_schema() {
        assert_eq!(normalize_tool_name("create-file"), "create_file");
        assert_eq!(normalize_tool_name("terminal.send"), "terminal_send");
        assert_eq!(normalize_tool_name("***"), "unnamed");
    }

    #[test]
    fn converts_unique_descriptor_to_clean_openai_tool_name() {
        let mut registry = McpToolRegistry::empty();
        registry
            .insert(registry_entry(
                "terminal_send".to_string(),
                "gpterminal",
                McpApprovalMode::Ask,
                McpToolDescriptor {
                    name: "terminal_send".to_string(),
                    description: "Send text".to_string(),
                    input_schema: json!({
                        "type": "object",
                        "properties": { "text": { "type": "string" } },
                        "required": ["text"]
                    }),
                },
            ))
            .unwrap();

        let tools = registry.openai_tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].function.name, "terminal_send");
        assert!(tools[0].function.description.contains("[MCP: gpterminal]"));
        assert_eq!(tools[0].function.parameters["required"][0], "text");
    }

    #[test]
    fn rejects_duplicate_exposed_names() {
        let mut registry = McpToolRegistry::empty();
        registry
            .insert(registry_entry(
                "create_file".to_string(),
                "a",
                McpApprovalMode::Ask,
                descriptor("create-file"),
            ))
            .unwrap();
        assert!(
            registry
                .insert(registry_entry(
                    "create_file".to_string(),
                    "b",
                    McpApprovalMode::Ask,
                    descriptor("create_file"),
                ))
                .is_err()
        );
    }

    #[tokio::test]
    async fn disabled_servers_are_not_discovered() {
        let mut config = McpHostConfig::default();
        config.servers.insert(
            "disabled".to_string(),
            McpServerConfig {
                enabled: false,
                approval: McpApprovalMode::Ask,
                transport: Some(McpTransportConfig::Http {
                    url: "http://127.0.0.1:9/mcp".to_string(),
                }),
                tools: BTreeMap::new(),
            },
        );
        let registry = discover_registry_from_config(&config).await.unwrap();
        assert!(registry.openai_tools().is_empty());
    }
}
