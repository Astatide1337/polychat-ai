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

Gemini supports multi-turn conversations via metadata (cid, rid, rcid) passed in `inner_req_list[2]` of the request. The response contains updated metadata at `inner[1]` of the parsed response JSON. Polychat encodes the full metadata array as a JSON string for the `conversation_id` field, so that subsequent requests can pass it back as `inner[2]` to continue the conversation. The `ConversationTracker` in `completions.rs` automatically maps message history to the Gemini metadata for multi-turn conversations.

### Temporary Chat

Setting `inner_req_list[45] = 1` prevents the conversation from being saved to Gemini history. This is controlled via the `temporary` flag in the request or per-provider config default.

### Listing Conversations

Gemini conversation listing uses the batchexecute RPC endpoint with rpcid `MaZiqc`. The payload format is `[13, null, [pinned_flag, null, 1]]` where `pinned_flag` is 1 for pinned chats and 0 for unpinned. Both are fetched in parallel and deduplicated. The response format follows the standard batchexecute framing: each part's `[2]` field is a JSON string containing `part_body[2]` as the chat list array. Each chat entry: `[cid, title, is_pinned, ..., [seconds, nanos]]`.

## Session Expiry

The `SNlM0e` token extracted from `gemini.google.com/app` expires within hours. Google session cookies themselves expire after hours to days. When Gemini returns 401 `session_expired`, re-run `polychat login gemini` to refresh cookies.

## Tool Calling

Gemini web does not expose custom native tools through the consumer endpoint Polychat uses, so Polychat applies its emulated tool-call bridge for Gemini requests with tools.
