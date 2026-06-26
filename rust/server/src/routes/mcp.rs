use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Serialize;
use serde_json::json;

use crate::mcp::config::load_mcp_config;
use crate::mcp::http_client::HttpMcpClient;
use crate::mcp::registry::{discover_registry_from_config, server_statuses, validate_config};
use crate::mcp::types::{McpCallRequest, McpCallResult, McpServerStatus, McpTransportConfig};
use crate::routes::errors::RouteError;

#[derive(Debug, Serialize)]
pub struct McpServersResponse {
    pub object: String,
    pub data: Vec<McpServerStatus>,
}

#[derive(Debug, Serialize)]
pub struct McpToolsResponse {
    pub object: String,
    pub data: Vec<crate::mcp::types::OpenAiToolDefinition>,
}

fn route_internal_error(err: anyhow::Error) -> axum::response::Response {
    RouteError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        err.to_string(),
        "server_error",
        "mcp_error",
    )
    .into_response()
}

fn route_not_found(message: impl Into<String>) -> axum::response::Response {
    RouteError::new(
        StatusCode::NOT_FOUND,
        message.into(),
        "invalid_request_error",
        "mcp_tool_not_found",
    )
    .into_response()
}

pub async fn list_mcp_servers_handler() -> axum::response::Response {
    let config = match load_mcp_config() {
        Ok(config) => config,
        Err(err) => return route_internal_error(err),
    };
    if let Err(err) = validate_config(&config) {
        return route_internal_error(err);
    }
    Json(McpServersResponse {
        object: "list".to_string(),
        data: server_statuses(&config),
    })
    .into_response()
}

pub async fn list_mcp_tools_handler() -> axum::response::Response {
    let config = match load_mcp_config() {
        Ok(config) => config,
        Err(err) => return route_internal_error(err),
    };
    let registry = match discover_registry_from_config(&config).await {
        Ok(registry) => registry,
        Err(err) => return route_internal_error(err),
    };
    Json(McpToolsResponse {
        object: "list".to_string(),
        data: registry.openai_tools(),
    })
    .into_response()
}

pub async fn call_mcp_tool_handler(
    Path(name): Path<String>,
    Json(body): Json<McpCallRequest>,
) -> axum::response::Response {
    let config = match load_mcp_config() {
        Ok(config) => config,
        Err(err) => return route_internal_error(err),
    };
    let registry = match discover_registry_from_config(&config).await {
        Ok(registry) => registry,
        Err(err) => return route_internal_error(err),
    };
    let Some(entry) = registry.get(&name) else {
        return route_not_found(format!("Unknown MCP tool: {name}"));
    };
    let Some(server) = config.servers.get(&entry.server_id) else {
        return route_not_found(format!("Unknown MCP server: {}", entry.server_id));
    };
    let Some(McpTransportConfig::Http { url }) = &server.transport else {
        return route_internal_error(anyhow::anyhow!(
            "MCP tool {} is not backed by an HTTP transport in this build",
            entry.name
        ));
    };
    let client = match HttpMcpClient::new(url.clone()) {
        Ok(client) => client,
        Err(err) => return route_internal_error(err),
    };
    let result = match client.call_tool(&entry.original_name, body.arguments).await {
        Ok(result) => result,
        Err(err) => McpCallResult {
            content: err.to_string(),
            is_error: true,
        },
    };
    Json(json!({
        "object": "mcp.tool_result",
        "tool": entry.name,
        "server": entry.server_id,
        "original_tool": entry.original_name,
        "content": result.content,
        "is_error": result.is_error
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tools_handler_returns_empty_list_without_config() {
        std::env::remove_var("POLYCHAT_MCP_CONFIG");
        let response = list_mcp_tools_handler().await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn internal_error_response_has_error_status() {
        let response = route_internal_error(anyhow::anyhow!("boom"));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
