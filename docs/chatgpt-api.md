# ChatGPT Web Adapter Notes

These notes describe Polychat's ChatGPT web integration. This is not the public OpenAI API.

## Identity

- Provider id: `chatgpt`
- Base URL: `https://chatgpt.com`
- Login URL: `https://chatgpt.com/auth/login`

## Login and Session State

Polychat logs in through OAuth or captures a valid browser session and access token.

Important runtime inputs:

- ChatGPT access token from `GET /api/auth/session`
- CSRF token from `GET /api/auth/csrf`
- ChatGPT cookies, including refreshed Cloudflare cookies

## Model Discovery

Polychat loads ChatGPT models live from the connected account:

```text
GET https://chatgpt.com/backend-api/models?history_and_training_disabled=false
```

There is no stale hardcoded fallback model list in the ChatGPT provider. If discovery fails, ChatGPT models are omitted until live discovery succeeds again.

## Requirements Flow

Before sending a message, Polychat calls:

```text
POST https://chatgpt.com/backend-api/sentinel/chat-requirements
```

This can return requirement tokens and proof-of-work requirements used by the conversation request.

## Conversations

List conversations:

```text
GET https://chatgpt.com/backend-api/conversations?offset=0&limit=50&order=updated
```

Load a conversation before continuing it:

```text
GET https://chatgpt.com/backend-api/conversation/{conversation_id}
```

Polychat uses the returned `current_node` as `parent_message_id` when reusing an existing ChatGPT conversation. This is required for continuation semantics to work reliably.

## Create Conversation

ChatGPT web does not expose a real empty-conversation create endpoint for Polychat. The first message creates the conversation.

Because of that:

- `POST /v1/conversations` is reported as unsupported for ChatGPT
- the normal way to create a ChatGPT conversation is to send the first completion request

## Tool Calling

ChatGPT web does not support arbitrary custom function tools through its consumer web API. Polychat therefore uses emulated tool calling for ChatGPT and returns OpenAI-style `tool_calls` to the client after parsing and validating ChatGPT's plain-text planner output.
