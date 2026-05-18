# Kimi Web Adapter Notes

These notes describe Polychat's Kimi integration against `https://www.kimi.com`.

## Identity

- Provider id: `kimi`
- Base URL: `https://www.kimi.com`

## Authentication

Polychat uses:

- `kimi-auth` cookie
- `Authorization: Bearer <kimi-auth>`
- `x-msh-device-id`, `x-msh-platform`, and related web headers

## Runtime APIs

Kimi uses two API surfaces:

1. legacy REST endpoints for create and stream
2. v2 Connect RPC endpoints for conversation listing and message history

## Conversation Runtime

Create conversation:

```text
POST https://www.kimi.com/api/chat
```

Stream completion:

```text
POST https://www.kimi.com/api/chat/{chat_id}/completion/stream
```

List conversations:

```text
POST /apiv2/kimi.gateway.chat.v1.ChatService/ListChats
```

## Supported Web Model IDs

Use these Kimi model ids through Polychat:

- `kimi`
- `k1`
- `k1.5`
- `k1.5-thinking`
- `k2`

Do not use unsupported marketing-style ids like `kimi-k2.6`.

## Tool Calling

Kimi uses Polychat's emulated tool bridge. Polychat also normalizes several observed Kimi-specific output variants so they can still be converted into strict OpenAI-style `tool_calls`.
