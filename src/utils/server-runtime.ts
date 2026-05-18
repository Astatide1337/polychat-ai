import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { isServerRunning, resolveBinary } from "./binary.js";

export function parsePort(value: string | number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(value)}`);
  }
  return port;
}

export function serverUrl(host: string, port: number): string {
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}

export async function waitForHealthy(url: string, child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`polychat-server exited before becoming healthy (code ${child.exitCode})`);
    }

    if (child.signalCode !== null) {
      throw new Error(`polychat-server exited before becoming healthy (${child.signalCode})`);
    }

    if (await isServerRunning(url, 1_000)) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${url}/health`);
}

export async function startServerProcess(
  host: string,
  port: number,
  stdio: "inherit" | "ignore",
  timeoutMs = 15_000,
): Promise<{ child: ChildProcess; url: string }> {
  const binary = resolveBinary();
  const url = serverUrl(host, port);
  const child = spawn(binary, ["--port", String(port), "--host", host], {
    stdio,
    detached: false,
  });

  child.on("error", (err) => {
    console.error(`Failed to start polychat-server: ${err.message}`);
    process.exitCode = 1;
  });

  try {
    await waitForHealthy(url, child, timeoutMs);
  } catch (err) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    throw err;
  }

  return { child, url };
}
