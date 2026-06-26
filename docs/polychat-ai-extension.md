# Polychat-AI Extension

The browser extension syncs conversation history from the logged-in browser session into the local Polychat-AI MCP service.

## Build

```bash
npm --workspace apps/extension run build
```

## Load

Load the unpacked extension from `apps/extension/dist` in Chromium-based browsers.

The manifest includes the provider hosts plus local `127.0.0.1` and `localhost` access for the ingest API.

## Configure

Open the popup and set:

- MCP server URL, default `http://127.0.0.1:3333`
- ingest token, matching `POLYCHAT_AI_INGEST_TOKEN`
- designated test conversation ids matching:
  - `POLYCHAT_TEST_CHATGPT_CONVERSATION_ID`
  - `POLYCHAT_TEST_CLAUDE_CONVERSATION_ID`
  - `POLYCHAT_TEST_GEMINI_CONVERSATION_ID`

The popup also exposes provider sync buttons and the latest sync result.
It now also includes a direct conversation sync control for targeted verification.

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
