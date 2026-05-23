/** OpenAI-compatible tool definition. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
      additionalProperties: boolean;
    };
  };
}

/** A single tool call returned by the server. */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Result of executing a tool locally. */
export interface ToolResult {
  content: string;
  is_error: boolean;
}

/** Tool approval mode. */
export type ApprovalMode = "auto" | "cautious" | "ask";

/** Tools that are safe (read-only) — auto-approved in cautious mode. */
const SAFE_TOOLS = new Set(["read"]);

export function isSafeTool(name: string): boolean {
  return SAFE_TOOLS.has(name);
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a bash command in the working directory and return its stdout and stderr. Use for running commands, inspecting the environment, listing files, grepping, etc. Timeout is 30 seconds.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read the contents of a file. Returns the full text content (truncated at 50KB). Supports text files only.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read (relative or absolute)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to write (relative or absolute)",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description:
        "Make a precise edit to a file using exact text replacement. The oldText must match exactly one unique region in the file. Do not pad with large unchanged regions.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit (relative or absolute)",
          },
          oldText: {
            type: "string",
            description:
              "The exact text to find and replace — must be unique in the file",
          },
          newText: {
            type: "string",
            description: "The replacement text",
          },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
];
