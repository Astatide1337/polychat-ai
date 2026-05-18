# Claude Web Adapter Notes

These notes describe Polychat's Claude web integration. This is not Anthropic's public API.

## Identity

- Provider id: `claude`
- Base URL: `https://claude.ai`
- Login URL: `https://claude.ai/login`

## Session Validation

Polychat validates the session by loading organizations:

```text
GET https://claude.ai/api/organizations
```

The first returned organization id is used for conversation and completion requests.

## Models

Claude web uses current Claude web model ids such as:

- `claude-sonnet-4-6`
- `claude-opus-4-6`
- `claude-haiku-4-5`

## Conversations

List conversations:

```text
GET https://claude.ai/api/organizations/{org_id}/chat_conversations
```

Create conversation:

```text
POST https://claude.ai/api/organizations/{org_id}/chat_conversations
```

Claude conversation requests are scoped to the resolved organization id.

## Streaming

Claude streams SSE frames separated with CRLF, not just LF. Polychat normalizes this before parsing.

The stream ends on Claude's stop event rather than a literal `[DONE]` from upstream, though Polychat still emits OpenAI-style downstream responses.

## Tool Calling

Claude web does not expose native custom tool definitions to Polychat, so Polychat uses emulated tool calling and returns normal OpenAI-style `tool_calls` to clients.
