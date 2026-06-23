import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { openUrlInDefaultBrowser } from "../browser/external.js";
import { isServerRunning, resolveWebDist } from "../utils/binary.js";
import { parsePort, serverUrl, startServerProcess } from "../utils/server-runtime.js";

export function registerWebCommand(program: Command) {
  program
    .command("web")
    .description("Start the local WebUI")
    .option("--port <number>", "Port to listen on (default: 1443)")
    .option("--host <string>", "Host to bind (default: 127.0.0.1)")
    .option("--no-open", "Print the WebUI URL without opening a browser")
    .action(async (options: { port?: string; host?: string; open?: boolean }) => {
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
      const webDist = resolveWebDist();
      if (!webDist) {
        console.warn("WebUI assets were not found. Run `npm run build:web` before using `polychat web` from a source checkout.");
      }

      if (await isServerRunning(url)) {
        console.log(`Polychat WebUI available at ${url}`);
        if (options.open !== false) openUrlInDefaultBrowser(url);
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
      console.log(`Polychat WebUI running at ${url}`);
      if (options.open !== false) openUrlInDefaultBrowser(url);

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
