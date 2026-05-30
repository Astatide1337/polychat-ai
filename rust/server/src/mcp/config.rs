use crate::mcp::types::McpHostConfig;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub fn load_mcp_config() -> Result<McpHostConfig> {
    if let Some(path) = resolve_mcp_config_path() {
        load_mcp_config_from_path(&path)
    } else {
        Ok(McpHostConfig::default())
    }
}

pub fn resolve_mcp_config_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("POLYCHAT_MCP_CONFIG") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    let local = PathBuf::from(".polychat/mcp.json");
    if local.exists() {
        return Some(local);
    }

    if let Ok(home) = std::env::var("HOME") {
        let user = PathBuf::from(home).join(".polychat/mcp.json");
        if user.exists() {
            return Some(user);
        }
    }

    None
}

pub fn load_mcp_config_from_path(path: &Path) -> Result<McpHostConfig> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read MCP config {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse MCP config {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::types::{McpApprovalMode, McpTransportConfig};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_config_path(name: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("polychat-{name}-{n}.json"))
    }

    #[test]
    fn parses_explicit_http_config() {
        let path = temp_config_path("mcp-config");
        std::fs::write(
            &path,
            r#"{
              "version": 1,
              "servers": {
                "gpterminal": {
                  "enabled": true,
                  "transport": "http",
                  "url": "http://127.0.0.1:8719/mcp",
                  "approval": "auto"
                }
              }
            }"#,
        )
        .unwrap();

        let config = load_mcp_config_from_path(&path).unwrap();
        let server = config.servers.get("gpterminal").unwrap();
        assert!(server.enabled);
        assert_eq!(server.approval, McpApprovalMode::Auto);
        assert_eq!(
            server.transport,
            Some(McpTransportConfig::Http {
                url: "http://127.0.0.1:8719/mcp".to_string()
            })
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn invalid_config_returns_error() {
        let path = temp_config_path("bad-mcp-config");
        std::fs::write(&path, "{ not json").unwrap();
        let err = load_mcp_config_from_path(&path).unwrap_err().to_string();
        assert!(err.contains("failed to parse MCP config"));
        let _ = std::fs::remove_file(path);
    }
}
