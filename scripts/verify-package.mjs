#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SUPPORTED_TARGETS = [
  { id: "linux-x64", binary: "polychat-server", executable: true },
  { id: "linux-arm64", binary: "polychat-server", executable: true },
  { id: "darwin-x64", binary: "polychat-server", executable: true },
  { id: "darwin-arm64", binary: "polychat-server", executable: true },
  { id: "win32-x64", binary: "polychat-server.exe", executable: false },
];

function currentTargetId() {
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  return null;
}

function selectedTargets() {
  if (process.argv.includes("--all")) {
    return SUPPORTED_TARGETS;
  }

  const requested = process.env.POLYCHAT_PACKAGE_TARGETS?.trim();
  if (!requested) {
    const current = currentTargetId();
    if (!current) {
      console.error(`Unsupported packaging platform: ${process.platform}-${process.arch}`);
      process.exit(1);
    }
    return SUPPORTED_TARGETS.filter((target) => target.id === current);
  }

  const wanted = new Set(requested.split(",").map((value) => value.trim()).filter(Boolean));
  const selected = SUPPORTED_TARGETS.filter((target) => wanted.has(target.id));

  if (selected.length !== wanted.size) {
    const known = new Set(SUPPORTED_TARGETS.map((target) => target.id));
    const unknown = [...wanted].filter((target) => !known.has(target));
    console.error(`Unknown packaging target(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  return selected;
}

for (const target of selectedTargets()) {
  const binaryPath = join(root, "bin", target.id, target.binary);
  if (!existsSync(binaryPath)) {
    console.error(`Packaged server binary missing for ${target.id}: ${binaryPath}`);
    process.exit(1);
  }

  const stat = statSync(binaryPath);
  if (!stat.isFile()) {
    console.error(`Packaged server binary is not a file for ${target.id}: ${binaryPath}`);
    process.exit(1);
  }

  if (target.executable && (stat.mode & 0o111) === 0) {
    console.error(`Packaged server binary is not executable for ${target.id}: ${binaryPath}`);
    process.exit(1);
  }

  console.log(`Verified ${target.id}: ${binaryPath}`);
}
