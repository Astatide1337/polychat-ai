#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SUPPORTED_TARGETS = [
  { id: "linux-x64", os: "linux", arch: "x64", binary: "polychat-server" },
  { id: "linux-arm64", os: "linux", arch: "arm64", binary: "polychat-server" },
  { id: "darwin-x64", os: "darwin", arch: "x64", binary: "polychat-server" },
  { id: "darwin-arm64", os: "darwin", arch: "arm64", binary: "polychat-server" },
  { id: "win32-x64", os: "win32", arch: "x64", binary: "polychat-server.exe" },
];
const ALL_TARGET_IDS = SUPPORTED_TARGETS.map((target) => target.id);

function currentTarget() {
  return SUPPORTED_TARGETS.find(
    (target) => target.os === process.platform && target.arch === process.arch,
  ) ?? null;
}

function selectedTargets() {
  if (process.argv.includes("--all")) {
    return SUPPORTED_TARGETS;
  }

  const requested = process.env.POLYCHAT_PACKAGE_TARGETS?.trim();
  if (!requested) {
    const target = currentTarget();
    if (!target) {
      console.error(`Unsupported packaging platform: ${process.platform}-${process.arch}`);
      process.exit(1);
    }
    return [target];
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

export { ALL_TARGET_IDS };

function sourcePathFor(target) {
  if (process.platform === target.os && process.arch === target.arch) {
    const localBuild = join(root, "rust", "target", "release", target.binary);
    if (existsSync(localBuild)) return localBuild;
  }

  return join(root, "artifacts", target.id, target.binary);
}

for (const target of selectedTargets()) {
  const source = sourcePathFor(target);
  const targetDir = join(root, "bin", target.id);
  const destination = join(targetDir, target.binary);

  if (!existsSync(source)) {
    console.error(`Missing packaged binary for ${target.id}: ${source}`);
    process.exit(1);
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, destination);
  if (!target.binary.endsWith(".exe")) chmodSync(destination, 0o755);
  console.log(`Staged ${target.id}: ${destination}`);
}
