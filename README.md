# Polychat

Run ChatGPT, Claude, DeepSeek, Gemini, and Kimi through one local API.

Polychat is a CLI plus a local OpenAI-compatible server backed by your existing browser sessions.

## Quickstart

```bash
npm install -g polychat-ai
polychat init
polychat login claude
polychat serve
polychat verify
```

The published npm package is intended to ship prebuilt servers for:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

If you are building from source instead of installing the published package, you can still point Polychat at a local server binary with `POLYCHAT_SERVER_BINARY`.

## Example

```bash
curl http://127.0.0.1:1443/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "user", "content": "Explain what a CDN does in two sentences."}
    ]
  }'
```

## Supported providers

- `chatgpt`
- `claude`
- `deepseek`
- `gemini`
- `kimi`

## Commands

```bash
polychat init
polychat doctor [--json]
polychat verify [--json]
polychat login <provider>
polychat logout <provider>
polychat logout --all
polychat status [--check]
polychat models
polychat serve [--host <host>] [--port <port>]
polychat chat [--model <id>]
polychat session export <provider> --api-key <key>
polychat session push <provider> <server-url> --api-key <key> [--insecure]
```

## Docs

- [`docs/api.md`](docs/api.md)
- [`docs/chatgpt-api.md`](docs/chatgpt-api.md)
- [`docs/claude-api.md`](docs/claude-api.md)
- [`docs/deepseek-api.md`](docs/deepseek-api.md)
- [`docs/gemini-api.md`](docs/gemini-api.md)
- [`docs/kimi-api.md`](docs/kimi-api.md)
- [`docs/npm-release.md`](docs/npm-release.md)

## Disclaimer

- Use this at your own risk.
- I provide no warranty, no guarantee of long-term support, and no guarantee that any provider account will remain usable.
- Provider bans, rate limits, session invalidation, API changes, model drift, and breakage are all possible.
- Polychat depends on third-party web products that can change or shut this down at any time, so mileage will vary.
- Tool behavior and output are not fully deterministic across providers or over time.
- This project is intended to work best with a ChatGPT subscription, but nothing is promised.
- You are responsible for how you use this project, your accounts, and any consequences from that use.
- This README is not a legal contract and is not legal advice; if you want real liability protection, use a proper license, terms, and counsel.

## Security

- Sessions are encrypted with `POLYCHAT_SECRET_KEY`
- `POLYCHAT_API_KEY` is optional

## Uninstall

```bash
npm uninstall -g polychat-ai
rm -rf ~/.polychat
```

## License

MIT
