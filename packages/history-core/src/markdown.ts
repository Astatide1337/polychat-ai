import type { Conversation, Message } from "./types.js";
import { summarizeContent } from "./content.js";

const ROLE_LABELS: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
  unknown: "Unknown",
};

function normalizeTitle(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Conversation";
}

function formatDate(value: string | null): string {
  if (!value) return "Unknown";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().slice(0, 10);
}

export function renderConversationMarkdown(
  conversation: Conversation,
  messages: Message[]
): string {
  const lines: string[] = [];
  lines.push(`# ${normalizeTitle(conversation.title)}`);
  lines.push("");
  lines.push(`Provider: ${conversation.provider}`);
  lines.push(`Updated: ${formatDate(conversation.updatedAt ?? conversation.lastSyncedAt)}`);
  if (conversation.model) lines.push(`Model: ${conversation.model}`);
  if (conversation.url) lines.push(`URL: ${conversation.url}`);
  lines.push("");

  for (const message of messages) {
    const label = ROLE_LABELS[message.role] ?? ROLE_LABELS.unknown;
    lines.push(`## ${label}`);
    lines.push("");
    lines.push(message.content || summarizeContent(message.raw) || "");
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
