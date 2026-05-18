import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { isServerRunning } from "../utils/binary.js";
import { parsePort, serverUrl, startServerProcess } from "../utils/server-runtime.js";

export function registerServeCommand(program: Command) {
  program
    .command("serve")
    .description("Start the API server")
    .option("--port <number>", `Port to listen on (default: 1443)`)
    .option("--host <string>", "Host to bind (default: 127.0.0.1)")
    .action(async (options: { port?: string; host?: string }) => {
      const config = loadConfig();
      let port: number;
      try {
        port = parsePort(options.port ?? config.server.port);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      const host = options.host ?? config.server.host;
      const url = serverUrl(host, port);

      if (await isServerRunning(url)) {
        console.log(`Polychat server already running at http://${host}:${port}`);
        return;
      }

      let child: import("node:child_process").ChildProcess;
      try {
        ({ child } = await startServerProcess(host, port, "inherit"));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      let shuttingDown = false;
      console.log(`Polychat server running at http://${host}:${port}`);

      const shutdown = () => {
        shuttingDown = true;
        child.kill("SIGTERM");
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await new Promise<void>((resolve) => {
        child.on("exit", (code, signal) => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);

          if (shuttingDown || signal) {
            process.exitCode = 0;
          } else if (code !== 0) {
            console.error(`polychat-server exited with code ${code}`);
            process.exitCode = code ?? 1;
          }

          resolve();
        });
      });
    });
}
