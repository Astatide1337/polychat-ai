import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig, getConfigDir, getSessionDir } from "../config/index.js";
import { resolveBinary, isServerRunning } from "../utils/binary.js";
import { serverUrl } from "../utils/server-runtime.js";
import { detectPlatform, type DaemonPlatform } from "../daemon/mod.js";
import { installSystemdDaemon, uninstallSystemdDaemon } from "../daemon/linux.js";
import { installLaunchdDaemon, uninstallLaunchdDaemon } from "../daemon/macos.js";
import { installWindowsDaemon, uninstallWindowsDaemon } from "../daemon/windows.js";

/** Run init logic inline — same as `polychat init` but without the console output. */
function ensureInit(): void {
  const configDir = getConfigDir();
  const sessionDir = getSessionDir();
  mkdirSync(configDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const envFile = join(configDir, ".env");
  if (!existsSync(envFile)) {
    const secret = randomBytes(32).toString("hex");
    writeFileSync(
      envFile,
      [
        "# Polychat local secrets. Do not share this file.",
        `POLYCHAT_SECRET_KEY=${secret}`,
        "# Optional: require clients to send Authorization: Bearer <value>",
        "# POLYCHAT_API_KEY=",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    try {
      chmodSync(envFile, 0o600);
    } catch {
      // Best effort on platforms that do not support POSIX permissions.
    }
  }

  // Ensure config.json exists (loadConfig creates it if missing)
  loadConfig();
}

/** Send POST /shutdown to the running server. Returns true if shutdown was accepted. */
async function requestShutdown(host: string, port: number): Promise<boolean> {
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const apiKey = process.env.POLYCHAT_API_KEY?.trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  try {
    const res = await fetch(`${url}/shutdown`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 200) {
      // Wait briefly for the server to actually exit
      for (let i = 0; i < 20; i++) {
        if (!(await isServerRunning(url))) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function registerDaemonCommand(program: Command) {
  const daemon = program.command("daemon").description("Manage the Polychat background daemon");

  daemon
    .command("install")
    .description("Install the Polychat server as a startup daemon")
    .action(async () => {
      const platform = detectPlatform();

      // 1. Ensure init has been run
      ensureInit();

      // 2. Resolve the server binary
      let binaryPath: string;
      try {
        binaryPath = resolveBinary();
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      // 3. Read config for port/host
      const config = loadConfig();
      const port = config.server.port;
      const host = config.server.host;

      // 4. Stop any existing server instance so the daemon can take over the port
      const url = serverUrl(host, port);
      const wasRunning = await isServerRunning(url);
      if (wasRunning) {
        await requestShutdown(host, port);
        // Wait for the port to free up
        for (let i = 0; i < 20; i++) {
          if (!(await isServerRunning(url))) break;
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      // 5. Install platform-specific daemon (this also starts the server)
      try {
        switch (platform) {
          case "systemd":
            installSystemdDaemon({ binaryPath, port, host });
            break;
          case "launchd":
            installLaunchdDaemon({ binaryPath, port, host });
            break;
          case "startup":
            installWindowsDaemon({ binaryPath, port, host });
            break;
        }
      } catch (err) {
        console.error(
          `Failed to install daemon: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
        return;
      }

      // 6. Verify the server is running after install
      const healthy = await isServerRunning(url);
      const status = healthy ? "running" : "starting";

      console.log(`Polychat daemon installed (${platformLabel(platform)}).`);
      console.log(`Server: ${status} at http://${host}:${port}`);
      if (port !== 1443 || host !== "127.0.0.1") {
        console.log("If you change your port or host, re-run `polychat daemon install`.");
      }
    });

  daemon
    .command("uninstall")
    .description("Uninstall the Polychat startup daemon and stop the server")
    .action(async () => {
      const platform = detectPlatform();
      const config = loadConfig();
      const port = config.server.port;
      const host = config.server.host;
      const url = serverUrl(host, port);

      // 1. Try to gracefully shut down the server
      if (await isServerRunning(url)) {
        const shutDown = await requestShutdown(host, port);
        if (!shutDown) {
          // Fallback: try SIGTERM via process kill
          console.warn("POST /shutdown failed — attempting process kill...");
          try {
            const { execSync } = await import("node:child_process");
            if (platform === "systemd") {
              execSync("systemctl --user stop polychat.service", { stdio: "inherit" });
            } else if (platform === "launchd") {
              execSync("pkill -f polychat-server", { stdio: "ignore" });
            } else {
              execSync("taskkill /F /IM polychat-server.exe", { stdio: "ignore" });
            }
          } catch {
            // Best effort
          }
        }
      }

      // 2. Uninstall platform-specific daemon
      try {
        switch (platform) {
          case "systemd":
            uninstallSystemdDaemon();
            break;
          case "launchd":
            uninstallLaunchdDaemon();
            break;
          case "startup":
            uninstallWindowsDaemon();
            break;
        }
      } catch (err) {
        console.error(
          `Failed to uninstall daemon: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
        return;
      }

      console.log(`Polychat daemon uninstalled (${platformLabel(platform)}).`);
    });
}

function platformLabel(platform: DaemonPlatform): string {
  switch (platform) {
    case "systemd": return "systemd";
    case "launchd": return "launchd";
    case "startup": return "Windows Startup";
  }
}
