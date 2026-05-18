import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function readJson(path) {
  return JSON.parse(read(path));
}

describe("Production readiness", () => {
  it("CLI registers init doctor and verify commands", () => {
    const index = read("src/index.ts");
    assert.match(index, /registerInitCommand\(program\)/);
    assert.match(index, /registerDoctorCommand\(program\)/);
    assert.match(index, /registerVerifyCommand\(program\)/);
    assert.equal(existsSync(new URL("../src/commands/init.ts", import.meta.url)), true);
    assert.equal(existsSync(new URL("../src/commands/doctor.ts", import.meta.url)), true);
    assert.equal(existsSync(new URL("../src/commands/verify.ts", import.meta.url)), true);
  });

  it("init command creates local config and secret with restrictive permissions", () => {
    const src = read("src/commands/init.ts");
    assert.match(src, /POLYCHAT_SECRET_KEY/);
    assert.match(src, /randomBytes\(32\)\.toString\("hex"\)/);
    assert.match(src, /chmodSync\(envFile, 0o600\)/);
    assert.match(src, /loadConfig\(\)/);
  });

  it("doctor command supports json output and checks binary browser config and sessions", () => {
    const src = read("src/commands/doctor.ts");
    assert.match(src, /\.option\("--json"/);
    assert.match(src, /resolveBinary\(/);
    assert.match(src, /detectBrowserKind\(/);
    assert.match(src, /loadConfig\(/);
    assert.match(src, /loadSession\(/);
  });

  it("binary resolver checks package-local platform binary before PATH", () => {
    const src = read("src/utils/binary.ts");
    const packageBinary = src.indexOf("bin", src.indexOf("platform"));
    const pathLookup = src.indexOf("whichSync(BINARY_NAME)");
    assert.ok(packageBinary > -1, "resolver must mention package-local bin directory");
    assert.ok(pathLookup > -1, "resolver must retain PATH fallback");
    assert.ok(packageBinary < pathLookup, "package-local binary must be checked before PATH");
  });

  it("package metadata supports npm release checks and binary artifacts", () => {
    const pkg = readJson("package.json");
    assert.equal(pkg.name, "polychat-ai");
    assert.deepEqual(pkg.files.includes("bin"), true);
    assert.match(pkg.scripts.prepack, /npm run build/);
    assert.match(pkg.scripts.prepack, /npm run build:server/);
    assert.match(pkg.scripts.prepack, /npm run stage:binary/);
    assert.match(pkg.scripts.prepack, /npm run verify:package/);
    assert.equal(pkg.scripts["stage:binary:all"], "node scripts/stage-binary.mjs --all");
    assert.equal(pkg.scripts["verify:package:all"], "node scripts/verify-package.mjs --all");
    assert.equal(pkg.scripts.prepublishOnly, "npm run verify:package:all");
    assert.equal(pkg.scripts["pack:check"], "npm pack --dry-run");
    assert.ok(pkg.repository?.url, "repository URL must be present");
    assert.ok(pkg.bugs?.url, "bugs URL must be present");
    assert.ok(pkg.homepage, "homepage must be present");
  });

  it("CI workflow runs TypeScript Rust and npm pack gates", () => {
    assert.equal(existsSync(new URL("../.github/workflows/ci.yml", import.meta.url)), true);
    const ci = read(".github/workflows/ci.yml");
    assert.match(ci, /npm run build/);
    assert.match(ci, /node --test/);
    assert.match(ci, /cargo test --bin polychat-server/);
    assert.match(ci, /cargo build --release/);
    assert.match(ci, /npm pack --dry-run/);
  });

  it("README documents quickstart security providers and OpenAI usage", () => {
    const src = read("README.md");
    assert.match(src, /npm install -g polychat-ai/);
    assert.match(src, /polychat init/);
    assert.match(src, /polychat doctor/);
    assert.match(src, /polychat verify/);
    assert.match(src, /Supported providers/);
    assert.match(src, /Security/);
    assert.match(src, /OpenAI-compatible/);
  });
});
