import chalk from "chalk";
import { Command } from "commander";
import { loadConfig, PROVIDERS } from "../config/index.js";
import { hasSession } from "../session/store.js";
import { isServerRunning } from "../utils/binary.js";

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show current status")
    .option("--check", "Validate sessions via the running server's /health endpoint")
    .action(async (options: { check?: boolean }) => {
      const config = loadConfig();
      const serverUrl = process.env.POLYCHAT_SERVER_URL ?? `http://${config.server.host}:${config.server.port}`;
      const rows = [] as Array<{ provider: string; status: string; defaultModel: string; session: string }>;

      // Optionally fetch live health from the server
      let serverHealth: Record<string, { connected?: boolean; session_valid?: boolean }> = {};
      if (options.check) {
        if (await isServerRunning(serverUrl)) {
          try {
            const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5_000) });
            const body = await res.json() as { providers?: Record<string, { connected?: boolean; session_valid?: boolean }> };
            serverHealth = body.providers ?? {};
          } catch { /* fall through — show local status only */ }
        } else {
          console.warn(`⚠ Server not running at ${serverUrl} — showing local session status only.`);
        }
      }

      for (const [key, provider] of Object.entries(PROVIDERS)) {
        const hasSessionFile = hasSession(key);
        const defaultModel = config.providers[key]?.defaultModel ?? provider.defaultModel;
        const statusLabel = hasSessionFile ? chalk.green("✓ Connected") : chalk.red("✗ Disconnected");

        let session = "—";
        if (options.check && hasSessionFile) {
          const liveInfo = serverHealth[key];
          if (liveInfo !== undefined) {
            session = liveInfo.session_valid ? chalk.green("Valid") : chalk.red("Expired");
          } else {
            session = chalk.yellow("Unknown");
          }
        }

        rows.push({ provider: provider.name, status: statusLabel, defaultModel, session });
      }

      const widths = {
        provider: Math.max("Provider".length, ...rows.map((row) => stripAnsi(row.provider).length)),
        status: Math.max("Status".length, ...rows.map((row) => stripAnsi(row.status).length)),
        defaultModel: Math.max("Default Model".length, ...rows.map((row) => stripAnsi(row.defaultModel).length)),
        session: Math.max("Session".length, ...rows.map((row) => stripAnsi(row.session).length)),
      };

      const header = [
        pad("Provider", widths.provider),
        pad("Status", widths.status),
        pad("Default Model", widths.defaultModel),
        pad("Session", widths.session),
      ].join("  ");
      const separator = "─".repeat(stripAnsi(header).length);
      console.log(header);
      console.log(separator);
      for (const row of rows) {
        console.log([
          pad(row.provider, widths.provider),
          pad(row.status, widths.status),
          pad(row.defaultModel, widths.defaultModel),
          pad(row.session, widths.session),
        ].join("  "));
      }
    });
}

function pad(value: string, width: number) {
  return value + " ".repeat(Math.max(0, width - stripAnsi(value).length));
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
