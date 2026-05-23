import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { launchdPlistPath } from "./mod.js";

export interface LaunchdDaemonOptions {
  binaryPath: string;
  port: number;
  host: string;
}

function generatePlist(opts: LaunchdDaemonOptions): string {
  const logPath = join(homedir(), ".polychat", "server.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.polychat.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.binaryPath}</string>
    <string>--port</string>
    <string>${opts.port}</string>
    <string>--host</string>
    <string>${opts.host}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>12</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

export function installLaunchdDaemon(opts: LaunchdDaemonOptions): void {
  const plistPath = launchdPlistPath();
  const dir = dirname(plistPath);
  mkdirSync(dir, { recursive: true });

  // Unload existing agent if it's already loaded
  try {
    execSync(`launchctl unload -w "${plistPath}"`, { stdio: "ignore" });
  } catch {
    // Not currently loaded — that's fine
  }

  writeFileSync(plistPath, generatePlist(opts), { mode: 0o644 });

  execSync(`launchctl load -w "${plistPath}"`, { stdio: "inherit" });
}

export function uninstallLaunchdDaemon(): void {
  const plistPath = launchdPlistPath();

  try {
    execSync(`launchctl unload -w "${plistPath}"`, { stdio: "inherit" });
  } catch {
    // Not currently loaded — that's fine
  }

  if (existsSync(plistPath)) {
    unlinkSync(plistPath);
  }
}

export function isLaunchdDaemonInstalled(): boolean {
  return existsSync(launchdPlistPath());
}
