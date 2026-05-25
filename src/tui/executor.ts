import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolResult } from "./tools.js";

const BASH_TIMEOUT_MS = 30_000;
const READ_MAX_BYTES = 50 * 1024; // 50KB

export async function executeTool(
  name: string,
  args: Record<string, string>
): Promise<ToolResult> {
  switch (name) {
    case "bash":
      return executeBash(args.command ?? "");
    case "read":
      return executeRead(args.path ?? "");
    case "write":
      return executeWrite(args.path ?? "", args.content ?? "");
    case "edit":
      return executeEdit(args.path ?? "", args.oldText ?? "", args.newText ?? "");
    default:
      return { content: `Unknown tool: ${name}`, is_error: true };
  }
}

function executeBash(command: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", command],
      { timeout: BASH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const msg =
            error.killed
              ? `Command timed out after ${BASH_TIMEOUT_MS / 1000}s`
              : `Exit code ${error.code ?? error.signal}: ${stderr.trim() || error.message}`;
          resolve({ content: msg, is_error: true });
          return;
        }
        const parts: string[] = [];
        if (stdout.trim()) parts.push(stdout.trim());
        if (stderr.trim()) parts.push(`[stderr] ${stderr.trim()}`);
        resolve({ content: parts.join("\n") || "(no output)", is_error: false });
      }
    );
  });
}

async function executeRead(filePath: string): Promise<ToolResult> {
  try {
    const resolved = path.resolve(filePath);
    const buf = await fs.promises.readFile(resolved);
    if (buf.length > READ_MAX_BYTES) {
      const text = buf.slice(0, READ_MAX_BYTES).toString("utf8");
      return {
        content: `${text}\n\n... (truncated at ${READ_MAX_BYTES} bytes, file is ${buf.length} bytes)`,
        is_error: false,
      };
    }
    return { content: buf.toString("utf8"), is_error: false };
  } catch (err: any) {
    return { content: `Failed to read ${filePath}: ${err.message}`, is_error: true };
  }
}

async function executeWrite(filePath: string, content: string): Promise<ToolResult> {
  try {
    const resolved = path.resolve(filePath);
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, content, "utf8");
    return { content: `Wrote ${content.length} bytes to ${filePath}`, is_error: false };
  } catch (err: any) {
    return { content: `Failed to write ${filePath}: ${err.message}`, is_error: true };
  }
}

async function executeEdit(
  filePath: string,
  oldText: string,
  newText: string
): Promise<ToolResult> {
  try {
    const resolved = path.resolve(filePath);
    const content = await fs.promises.readFile(resolved, "utf8");
    const count = content.split(oldText).length - 1;
    if (count === 0) {
      return {
        content: `oldText not found in ${filePath}. No changes made.`,
        is_error: true,
      };
    }
    if (count > 1) {
      return {
        content: `oldText matches ${count} times in ${filePath} — edit is ambiguous. Provide a longer, unique oldText.`,
        is_error: true,
      };
    }
    const updated = content.replace(oldText, () => newText);
    await fs.promises.writeFile(resolved, updated, "utf8");
    return { content: `Edited ${filePath}: replaced 1 occurrence`, is_error: false };
  } catch (err: any) {
    return { content: `Failed to edit ${filePath}: ${err.message}`, is_error: true };
  }
}
