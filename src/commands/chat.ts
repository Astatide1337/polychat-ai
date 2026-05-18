import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { isServerRunning } from "../utils/binary.js";
import { serverUrl, startServerProcess } from "../utils/server-runtime.js";
import { startRepl } from "../tui/repl.js";

export function registerChatCommand(program: Command) {
  program
    .command("chat")
    .description("Start an interactive chat session")
    .option("--model <string>", "Model to use")
    .action(async (options: { model?: string }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("polychat chat requires an interactive terminal.");
        process.exitCode = 1;
        return;
      }

      const config = loadConfig();
      const port = config.server.port;
      const host = config.server.host;
      const url = process.env.POLYCHAT_SERVER_URL ?? serverUrl(host, port);
      let child: import("node:child_process").ChildProcess | undefined;

      if (!(await isServerRunning(url))) {
        try {
          ({ child } = await startServerProcess(host, port, "ignore", 8_000));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return;
        }

        process.on("exit", () => { child?.kill("SIGTERM"); });
        process.on("SIGINT", () => { child?.kill("SIGTERM"); process.exit(0); });
        process.on("SIGTERM", () => { child?.kill("SIGTERM"); process.exit(0); });
      }

      const model = options.model ?? config.defaultModel;
      startRepl(model).catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
    });
}
