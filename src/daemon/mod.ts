import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DaemonPlatform = "systemd" | "launchd" | "startup";

export interface DaemonConfig {
  platform: DaemonPlatform;
  configPath: string;
  binaryPath: string;
  port: number;
  host: string;
}

export function detectPlatform(): DaemonPlatform {
  const platform = process.platform;
  if (platform === "linux") {
    if (!existsSync("/run/systemd/systemd")) {
      throw new Error(
        "Systemd is not available on this system. " +
        "On non-systemd Linux (WSL1, Docker, Alpine/OpenRC, etc.), start the server manually: polychat serve"
      );
    }
    return "systemd";
  }
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "startup";
  throw new Error(`Unsupported platform for daemon: ${platform}`);
}

export function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "polychat.service");
}

export function autostartDesktopPath(): string {
  return join(homedir(), ".config", "autostart", "polychat.desktop");
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.polychat.server.plist");
}

export function windowsVbsPath(): string {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA environment variable not set");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "polychat.vbs");
}

/** Returns the config file paths for the current platform (may have multiple on Linux). */
export function daemonConfigPaths(platform: DaemonPlatform): string[] {
  switch (platform) {
    case "systemd":
      return [systemdUnitPath(), autostartDesktopPath()];
    case "launchd":
      return [launchdPlistPath()];
    case "startup":
      return [windowsVbsPath()];
  }
}

export function isDaemonInstalled(): DaemonPlatform | false {
  const platform = detectPlatform();
  return daemonConfigPaths(platform).some((p) => existsSync(p)) ? platform : false;
}

export interface DaemonStatus {
  installed: DaemonPlatform | false;
  binaryValid: boolean;
  binaryPath: string | null;
}

export function getDaemonStatus(): DaemonStatus {
  const installed = isDaemonInstalled();
  if (!installed) {
    return { installed: false, binaryValid: false, binaryPath: null };
  }

  // Check all config paths and extract the binary path from whichever exists
  for (const configPath of daemonConfigPaths(installed)) {
    if (!existsSync(configPath)) continue;
    const binaryPath = extractBinaryPath(installed, configPath);
    if (binaryPath !== null) {
      const binaryValid = existsSync(binaryPath);
      return { installed, binaryValid, binaryPath };
    }
  }

  return { installed, binaryValid: false, binaryPath: null };
}

function extractBinaryPath(platform: DaemonPlatform, configPath: string): string | null {
  try {
    const content = readFileSync(configPath, "utf8");
    switch (platform) {
      case "systemd": {
        // systemd unit
        const execMatch = content.match(/^ExecStart=(.+)$/m);
        if (execMatch) return execMatch[1].trim().split(/\s+/)[0];
        // XDG desktop entry
        const desktopMatch = content.match(/^Exec=(.+)$/m);
        if (desktopMatch) return desktopMatch[1].trim().split(/\s+/)[0];
        return null;
      }
      case "launchd": {
        const match = content.match(/<string>(.+polychat-server[^<]*)<\/string>/);
        return match ? match[1] : null;
      }
      case "startup": {
        const match = content.match(/"([^"]*polychat-server[^"]*)"/);
        return match ? match[1] : null;
      }
    }
  } catch {
    return null;
  }
}
