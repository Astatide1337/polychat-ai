# DeepSeek Web Adapter Notes

Polychat's DeepSeek adapter works against `https://chat.deepseek.com` using your existing account.

## Identity

- Provider id: `deepseek`
- Login URL: `https://chat.deepseek.com/sign_in`

## Login

```bash
polychat login deepseek
```

Polychat captures a valid DeepSeek browser session and stores it encrypted in `~/.polychat/sessions/deepseek.enc`.

At runtime, DeepSeek requests are pure HTTPS. Polychat does not need to launch a browser again once the session is saved.

## Runtime Endpoints

| Operation | Endpoint |
| --- | --- |
| Session validation | `GET /api/v0/users/current` |
| Conversation list | `GET /api/v0/chat_session/fetch_page` |
| Create conversation | `POST /api/v0/chat_session/create` |
| Send message | `POST /api/v0/chat/completion` |

## Models

DeepSeek models are captured from login-time app state when possible. If login-time discovery is unavailable, Polychat falls back to safe aliases like:

- `deepseek-chat`
- `deepseek-r1`

## Authentication

Polychat uses DeepSeek's session token and supporting cookies from the saved session.

## Proof-of-Work

DeepSeek requires per-request proof-of-work. Polychat solves this automatically in the Rust runtime.

## Tool Calling

DeepSeek is the one provider that still works well with Polychat's prompt-injected tool protocol, so it stays on the simpler non-emulated path.

## Temporary Chat

When `temporary: true` is set on a completion request (or the provider's `temporary` config default is `true`), Polychat includes `"is_temp": true` in the create-conversation request body (`POST /api/v0/chat_session/create`). This tells DeepSeek not to persist the conversation in the user's chat history.
