import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { systemdUnitPath } from "./mod.js";

export interface SystemdDaemonOptions {
  binaryPath: string;
  port: number;
  host: string;
}

function generateUnit(opts: SystemdDaemonOptions): string {
  return `[Unit]
Description=Polychat API Server
After=network.target

[Service]
Type=simple
ExecStart=${opts.binaryPath} --port ${opts.port} --host ${opts.host}
Restart=on-failure
StartLimitBurst=5
StartLimitIntervalSec=60
Environment=HOME=${homedir()}
EnvironmentFile=-%h/.polychat/.env

[Install]
WantedBy=default.target
`;
}

function generateDesktopEntry(opts: SystemdDaemonOptions): string {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Polychat
Comment=Polychat API Server
Exec=${opts.binaryPath} --port ${opts.port} --host ${opts.host}
StartupNotify=false
Terminal=false
`;
}

function autostartPath(): string {
  return join(homedir(), ".config", "autostart", "polychat.desktop");
}

/** Enable lingering so the user's systemd instance starts at boot without login. */
function enableLinger(): boolean {
  try {
    execSync("sudo loginctl enable-linger $(whoami)", { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

function isLingering(): boolean {
  try {
    const result = execSync("loginctl show-user $(whoami)", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return result.includes("Linger=yes");
  } catch {
    return false;
  }
}

export function installSystemdDaemon(opts: SystemdDaemonOptions): void {
  const unitPath = systemdUnitPath();
  const dir = dirname(unitPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(unitPath, generateUnit(opts), { mode: 0o644 });

  // Try to enable lingering for systemd user services at boot
  if (!isLingering()) {
    const lingerOk = enableLinger();
    if (!lingerOk) {
      // Fall back to XDG autostart — works without sudo
      const autostartDir = dirname(autostartPath());
      mkdirSync(autostartDir, { recursive: true });
      writeFileSync(autostartPath(), generateDesktopEntry(opts), { mode: 0o644 });
    }
  }

  execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  execSync("systemctl --user enable polychat.service", { stdio: "inherit" });
  execSync("systemctl --user start polychat.service", { stdio: "inherit" });
}

export function uninstallSystemdDaemon(): void {
  // Stop and remove systemd unit
  try {
    execSync("systemctl --user stop polychat.service", { stdio: "inherit" });
  } catch {
    // Service may not be running
  }

  try {
    execSync("systemctl --user disable polychat.service", { stdio: "inherit" });
  } catch {
    // Service may not be enabled
  }

  const unitPath = systemdUnitPath();
  if (existsSync(unitPath)) {
    unlinkSync(unitPath);
  }

  // Remove XDG autostart entry if it exists
  if (existsSync(autostartPath())) {
    unlinkSync(autostartPath());
  }

  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  } catch {
    // Best effort
  }
}

export function isSystemdDaemonInstalled(): boolean {
  return existsSync(systemdUnitPath()) || existsSync(autostartPath());
}
