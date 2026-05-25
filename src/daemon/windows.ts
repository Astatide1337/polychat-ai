import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import { windowsVbsPath } from "./mod.js";

export interface WindowsDaemonOptions {
  binaryPath: string;
  port: number;
  host: string;
}

function generateVbs(opts: WindowsDaemonOptions): string {
  const exe = opts.binaryPath;
  return `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${exe}"" --port ${opts.port} --host ${opts.host}", 0, False
`;
}

export function installWindowsDaemon(opts: WindowsDaemonOptions): void {
  const vbsPath = windowsVbsPath();
  const dir = dirname(vbsPath);
  mkdirSync(dir, { recursive: true });

  writeFileSync(vbsPath, generateVbs(opts), { encoding: "utf8" });

  // Also start the server now so no reboot is needed
  try {
    execSync(`cscript //nologo "${vbsPath}"`, { stdio: "ignore" });
  } catch {
    // cscript may not be available or may fail — the user can start manually
  }
}

export function uninstallWindowsDaemon(): void {
  const vbsPath = windowsVbsPath();

  // Kill the running polychat-server process
  try {
    execSync("taskkill /F /IM polychat-server.exe", { stdio: "ignore" });
  } catch {
    // Process may not be running — that's fine
  }

  if (existsSync(vbsPath)) {
    unlinkSync(vbsPath);
  }
}

export function isWindowsDaemonInstalled(): boolean {
  return existsSync(windowsVbsPath());
}
