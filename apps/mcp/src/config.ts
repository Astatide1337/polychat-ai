import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type McpAppConfig = {
  dbPath: string;
  ingestToken: string;
  ingestHost: string;
  ingestPort: number;
};

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

export function loadConfig(): McpAppConfig {
  const dbPath = process.env.POLYCHAT_AI_DB_PATH ?? join(process.cwd(), "data", "polychat-history.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  return {
    dbPath,
    ingestToken: process.env.POLYCHAT_AI_INGEST_TOKEN ?? "",
    ingestHost: process.env.POLYCHAT_AI_INGEST_HOST ?? "127.0.0.1",
    ingestPort: parsePort(process.env.POLYCHAT_AI_INGEST_PORT, 3333),
  };
}
