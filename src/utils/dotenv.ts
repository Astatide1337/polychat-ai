import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadDotEnv() {
  const envFile = join(homedir(), ".polychat", ".env");
  if (!existsSync(envFile)) return;

  const lines = readFileSync(envFile, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
