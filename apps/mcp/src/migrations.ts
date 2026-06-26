import { readFileSync } from "node:fs";

export const MIGRATION_SQL = readFileSync(
  new URL("../migrations/0001_init.sql", import.meta.url),
  "utf8"
);
