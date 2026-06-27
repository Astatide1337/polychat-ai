# Polychat-AI MCP

The MCP app stores synced transcripts in SQLite and exposes them through MCP tools, resources, and an HTTP ingest API.
It uses an in-process SQLite binding rather than shelling out to the `sqlite3` CLI.

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

The ingest server enforces a request body cap via `POLYCHAT_AI_INGEST_MAX_BODY_BYTES`
and defaults to 50 MiB.

Ingest requests replace existing messages for a conversation unless
`replaceMessages` is set to `false`. Use that flag for metadata-only refreshes.

## MCP tools

- `list_conversations`
- `search_conversations`
- `get_conversation`
- `get_messages`
- `sync_status`

The transcript tools omit raw provider payloads by default. Pass `includeRaw: true`
when you explicitly need the provider JSON.

`search_conversations` defaults to safe plain-text search. Pass `syntax: "fts"`
if you want raw FTS5 syntax.

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
