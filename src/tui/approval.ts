import { isSafeTool, type ApprovalMode } from "./tools.js";

export interface ApprovalConfig {
  mode: ApprovalMode;
}

/**
 * Returns true if the tool should be auto-approved (no prompt needed).
 * Returns false if the user should be prompted for approval.
 */
export function shouldApprove(toolName: string, config: ApprovalConfig): boolean {
  if (config.mode === "auto") return true;
  if (config.mode === "cautious" && isSafeTool(toolName)) return true;
  return false;
}
