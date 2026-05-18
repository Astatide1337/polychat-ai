# Polychat API Reference

Polychat exposes a local OpenAI-compatible API backed by browser sessions instead of provider API keys.

Default base URL:

```text
http://127.0.0.1:1443
```

Start the server:

```bash
polychat serve
```

## Authentication

If `POLYCHAT_API_KEY` is set in `~/.polychat/.env`, every endpoint except `GET /health` requires:

```text
Authorization: Bearer <POLYCHAT_API_KEY>
```

## Error Shape

Most API errors return:

```json
{
  "error": {
    "message": "Human-readable message",
    "type": "invalid_request_error | authentication_error | rate_limit_error | upstream_error",
    "code": "machine_readable_code"
  }
}
```

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Server status and connected providers |
| `GET` | `/v1/models` | List available models from connected providers |
| `GET` | `/v1/models/:model_id` | Get one model |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions |
| `GET` | `/v1/conversations?provider=<id>` | List provider-side conversations |
| `POST` | `/v1/conversations` | Create a provider-side conversation when supported |
| `POST` | `/v1/sessions/:provider` | Push a sealed session envelope |
| `DELETE` | `/v1/sessions/:provider` | Delete a saved session |
| `POST` | `/api/generate` | Ollama-compatible generate endpoint |

## `GET /health`

No auth required.

```bash
curl http://127.0.0.1:1443/health
```

Example:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "providers": {
    "chatgpt": { "connected": true, "defaultModel": "gpt-5-5" },
    "claude": { "connected": true, "defaultModel": "claude-sonnet-4-6" },
    "deepseek": { "connected": true, "defaultModel": "deepseek-v4-flash" },
    "gemini": { "connected": true, "defaultModel": "gemini-2.5-flash" },
    "kimi": { "connected": true, "defaultModel": "kimi" }
  }
}
```

When session transport is enabled, `/health` may also include `session_salt` for remote session push flows.

## `GET /v1/models`

Returns models from all connected providers.

```bash
curl http://127.0.0.1:1443/v1/models
```

Example:

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-5-5", "object": "model", "created": 1735689600, "owned_by": "chatgpt" },
    { "id": "claude-sonnet-4-6", "object": "model", "created": 1735689600, "owned_by": "claude" },
    { "id": "deepseek-chat", "object": "model", "created": 1735689600, "owned_by": "deepseek" },
    { "id": "gemini-2.5-flash", "object": "model", "created": 1735689600, "owned_by": "gemini" },
    { "id": "k2", "object": "model", "created": 1735689600, "owned_by": "kimi" }
  ]
}
```

## `GET /v1/models/:model_id`

```bash
curl http://127.0.0.1:1443/v1/models/claude-sonnet-4-6
```

## `POST /v1/chat/completions`

Polychat accepts OpenAI-style chat completion requests and adds a few Polychat-specific extensions.

### Request Fields

- `model`: required provider model id
- `messages`: OpenAI-style message array
- `stream`: optional boolean
- `tools`: optional function tool definitions
- `tool_choice`: optional OpenAI-style tool choice
- `provider_conversation_id`: optional existing provider conversation id

### Non-streaming Example

```bash
curl http://127.0.0.1:1443/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "user", "content": "What is a CDN?"}
    ]
  }'
```

Example response:

```json
{
  "id": "chatcmpl-uuid",
  "object": "chat.completion",
  "created": 1735689600,
  "model": "claude-sonnet-4-6",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "A CDN is a distributed network of servers that cache and deliver content closer to users."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

### Streaming Example

```bash
curl -N http://127.0.0.1:1443/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "user", "content": "List three CDN benefits."}
    ],
    "stream": true
  }'
```

Streaming responses use standard OpenAI-style SSE chunks ending in `data: [DONE]`.

### Tool Calling

Polychat exposes OpenAI-style tool calling across providers.

- DeepSeek uses a prompt-injected tool protocol that the model follows directly.
- ChatGPT, Claude, Gemini, and Kimi use Polychat's emulated tool bridge:
  - Polychat asks the model for a strict tool-call block or final answer block
  - parses and validates the result against the provided schema
  - retries with a repair prompt if needed
  - emits normal OpenAI-compatible `tool_calls` back to the client

Clients should send follow-up turns in standard OpenAI format, including:

- the assistant message containing `tool_calls`
- the `role: "tool"` result message
- the next user message

Polychat preserves these turns when continuing provider conversations.

### Tool Call Example

```json
{
  "model": "gpt-5-5",
  "messages": [
    {"role": "user", "content": "Show the current working directory using bash."}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Run a bash command",
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string" }
          },
          "required": ["command"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

Example tool-call response:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_uuid",
            "type": "function",
            "function": {
              "name": "bash",
              "arguments": "{\"command\":\"pwd\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

## Conversations

### `GET /v1/conversations?provider=<id>`

Lists provider-side conversations for one provider.

```bash
curl "http://127.0.0.1:1443/v1/conversations?provider=chatgpt"
```

### `POST /v1/conversations`

Creates a new provider-side conversation when the upstream provider supports it.

```json
{
  "provider": "claude",
  "model": "claude-sonnet-4-6"
}
```

Notes:

- ChatGPT does not support pre-creating conversations through the web API. Polychat returns `supported: false` for this route there.
- Gemini is stateless and does not use persistent provider-side conversations.

## Session Transport

### `POST /v1/sessions/:provider`

Accepts a sealed transport envelope produced by `polychat session export` or `polychat session push`.

### `DELETE /v1/sessions/:provider`

Deletes a stored provider session.

## `POST /api/generate`

Polychat also exposes an Ollama-style generate endpoint for simple text generation flows.

Use this when an Ollama-compatible client expects `/api/generate` instead of `/v1/chat/completions`.
