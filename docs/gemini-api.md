# Gemini Web Adapter Notes

These notes describe Polychat's Gemini web integration.

## Identity

- Provider id: `gemini`
- Base URL: `https://gemini.google.com`
- Login URL: `https://gemini.google.com`

## Session Capture

Polychat captures Gemini browser cookies from a supported browser session and stores them encrypted locally.

## Runtime Flow

For each request Polychat:

1. fetches `https://gemini.google.com/app`
2. extracts the `SNlM0e` token from the HTML
3. posts to Gemini's BardChatUi `StreamGenerate` endpoint
4. parses the line-delimited response into OpenAI-compatible output

## Models

Gemini web models are currently maintained as a curated hardcoded list in Polychat's Gemini provider for stability.

## Conversations

Gemini web is effectively stateless in Polychat today. Each request is a fresh upstream conversation even though Polychat still presents a normal OpenAI-compatible API downstream.

## Tool Calling

Gemini web does not expose custom native tools through the consumer endpoint Polychat uses, so Polychat applies its emulated tool-call bridge for Gemini requests with tools.
