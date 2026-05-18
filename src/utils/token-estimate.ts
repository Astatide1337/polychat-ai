const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:[+\-*/=][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

export function countEstimatedTokens(text: string): number {
  if (!text) return 0;
  return text.match(TOKEN_PATTERN)?.length ?? 0;
}
