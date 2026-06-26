# Polychat-AI MCP

The MCP app stores synced transcripts in SQLite and exposes them through MCP tools, resources, and an HTTP ingest API.

## Build

```bash
npm --workspace apps/mcp run build
```

## Run

```bash
POLYCHAT_AI_DB_PATH=./data/polychat-history.db \
POLYCHAT_AI_INGEST_TOKEN=change-me \
node apps/mcp/dist/index.js
```

The process starts:

- an HTTP server for ingest and health endpoints
- a JSON-RPC MCP stdio transport for tools and resources

## HTTP ingest

- `POST /ingest/conversation`
- `POST /ingest/batch`
- `GET /health`
- `GET /ingest/status`

The ingest endpoints require:

```http
Authorization: Bearer <POLYCHAT_AI_INGEST_TOKEN>
```

## MCP tools

- `list_conversations`
- `search_conversations`
- `get_conversation`
- `get_messages`
- `sync_status`

## MCP resources

Conversation resources are exposed as:

- `conversation://chatgpt/<conversation_id>`
- `conversation://claude/<conversation_id>`
- `conversation://gemini/<conversation_id>`

The resource body is rendered as Markdown.

## Example gateway config

```json
{
  "mcpServers": {
    "polychat-ai": {
      "command": "node",
      "args": ["apps/mcp/dist/index.js"],
      "env": {
        "POLYCHAT_AI_DB_PATH": "./data/polychat-history.db",
        "POLYCHAT_AI_INGEST_TOKEN": "change-me"
      }
    }
  }
}
```
