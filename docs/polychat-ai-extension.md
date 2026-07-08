# Polychat-AI Extension

The browser extension syncs conversation history from the logged-in browser session into the local Polychat-AI MCP service.

## Build

```bash
npm --workspace apps/extension run build
```

## Load

Load the unpacked extension from `apps/extension/dist` in Chromium-based browsers.

The manifest includes the provider hosts plus local `127.0.0.1` and `localhost` access for the ingest API.
Remote HTTPS ingest hosts are requested explicitly from the popup when you save a remote MCP server URL.
The extension also needs access to the provider auth domains and cookies API so it can
upload a fresh browser session to a remote Polychat API server when you click the
session refresh button.

In Zen / Firefox, the extension is installed into the active browser profile and persists across restarts. Rebuilding the repo does not update that profile copy on its own; reload or reinstall the add-on in that profile after a new build if you want the browser to pick up changes.

## Configure

Open the popup and set:

- MCP server URL, default `http://127.0.0.1:3333`
- ingest token, matching `POLYCHAT_AI_INGEST_TOKEN`
- Polychat API URL, default `http://127.0.0.1:1443`
- Polychat API key, optional unless the server is protected by `POLYCHAT_API_KEY`
- designated test conversation ids matching:
  - `POLYCHAT_TEST_CHATGPT_CONVERSATION_ID`
  - `POLYCHAT_TEST_CLAUDE_CONVERSATION_ID`
  - `POLYCHAT_TEST_GEMINI_CONVERSATION_ID`

The popup also exposes provider sync buttons and the latest sync result.
It now also includes a direct conversation sync control for targeted verification.
Use the browser-session refresh control after signing in to ChatGPT, Claude, or Gemini
in the browser to push the current cookies to the Polychat API server.
The test-only conversation sync controls and URL-driven auto-test flow are only enabled when the extension is built with `POLYCHAT_EXTENSION_TEST_MODE=1`.

If refresh fails, check the message in the popup result area:

- `No cookies found...` means you need to sign in to that provider in the current browser profile first.
- `Permission required...` means the popup needs access to the Polychat API origin you entered.
- `Use https://...` means the server URL is not a loopback local URL and must be HTTPS.
- `Session refresh failed` usually means the upstream provider session expired and needs a fresh login in the browser.

## Current behavior

- Detects the active provider page from the URL for auto-ingest
- Captures the current page through the content script when a provider tab opens
- Syncs the full conversation history for ChatGPT, Claude, and Gemini when a provider sync is triggered
- Uses best-effort fallbacks for Claude and Gemini detail capture
- Posts normalized conversations to the MCP ingest API

## Live verification

If you test against live provider history or conversation continuity, use the designated test conversations from the epic:

- ChatGPT
- Claude
- Gemini

Do not create new throwaway conversations for repeated verification runs.
Use the conversation-targeted sync control for those known test conversation ids when you want to validate a specific provider thread.
