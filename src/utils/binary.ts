import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const BINARY_NAME = "polychat-server";
const WIN = process.platform === "win32";
const BIN = WIN ? `${BINARY_NAME}.exe` : BINARY_NAME;


function platformTriple(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return `${platform}-${arch}`;
}
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

export function resolveWebDist(): string | null {
  const packaged = join(packageRoot(), "web-dist");
  if (existsSync(join(packaged, "index.html"))) return packaged;

  const local = join(process.cwd(), "web-dist");
  if (existsSync(join(local, "index.html"))) return local;

  return null;
}

function whichSync(name: string): string | null {
  const result = spawnSync(WIN ? "where" : "which", [name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    const line = result.stdout.trim().split("\n")[0].trim();
    return line || null;
  }
  return null;
}

export function resolveBinary(): string {
  const envOverride = process.env.POLYCHAT_SERVER_BINARY;
  if (envOverride) {
    if (!existsSync(envOverride)) {
      throw new Error(
        `POLYCHAT_SERVER_BINARY is set to '${envOverride}' but the file does not exist.`,
      );
    }
    return envOverride;
  }

  const packaged = join(packageRoot(), "bin", platformTriple(), BIN);
  if (existsSync(packaged)) return packaged;

  const onPath = whichSync(BINARY_NAME);
  if (onPath) return onPath;

  const localBuild = join(packageRoot(), "rust", "target", "release", BIN);
  if (existsSync(localBuild)) return localBuild;

  throw new Error(
    `polychat-server binary not found.\n` +
    `  Install globally:  npm install -g polychat-ai\n` +
    `  Expected package binary: bin/${platformTriple()}/${BIN}\n` +
    `  Or set env var:    POLYCHAT_SERVER_BINARY=/path/to/polychat-server`,
  );
}

export async function isServerRunning(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { status?: string } | null;
    return body?.status === "ok";
  } catch {
    return false;
  }
}

export async function isWebUiAvailable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return false;

    const body = await res.text();
    return body.includes("<!doctype html") || body.includes("<!DOCTYPE html");
  } catch {
    return false;
  }
}
