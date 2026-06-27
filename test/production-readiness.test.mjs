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

  it("MCP database uses an in-process SQLite binding", () => {
    const src = read("apps/mcp/src/db.ts");
    assert.match(src, /node-sqlite3-wasm/);
    assert.doesNotMatch(src, /execFileSync\("sqlite3"/);
  });

  it("package metadata supports npm release checks and binary artifacts", () => {
    const pkg = readJson("package.json");
    const extensionPkg = readJson("apps/extension/package.json");
    assert.equal(pkg.name, "polychat-ai");
    assert.deepEqual(pkg.files.includes("bin"), true);
    assert.match(pkg.scripts.prepack, /npm run build/);
    assert.match(pkg.scripts.prepack, /npm run build:workspaces/);
    assert.match(pkg.scripts.prepack, /npm run build:server/);
    assert.match(pkg.scripts.prepack, /npm run stage:binary/);
    assert.match(pkg.scripts.prepack, /npm run verify:package/);
    assert.equal(pkg.scripts["stage:binary:all"], "node scripts/stage-binary.mjs --all");
    assert.equal(pkg.scripts["verify:package:all"], "node scripts/verify-package.mjs --all");
    assert.equal(pkg.scripts["verify:polychat-history"], "node scripts/verify-polychat-history.mjs");
    assert.equal(pkg.scripts.prepublishOnly, "npm run verify && npm run verify:package:all");
    assert.equal(pkg.scripts["pack:check"], "npm pack --dry-run");
    assert.match(extensionPkg.scripts.build, /tsc -p tsconfig\.json --noEmit/);
    assert.ok(pkg.repository?.url, "repository URL must be present");
    assert.ok(pkg.bugs?.url, "bugs URL must be present");
    assert.ok(pkg.homepage, "homepage must be present");
  });

  it("CI workflow runs TypeScript Rust and npm pack gates", () => {
    assert.equal(existsSync(new URL("../.github/workflows/ci.yml", import.meta.url)), true);
    const ci = read(".github/workflows/ci.yml");
    assert.match(ci, /npm run verify/);
    assert.match(ci, /npm run verify:package:all/);
    assert.match(ci, /npm run test:e2e/);
    assert.match(ci, /cargo test --bin polychat-server/);
    assert.match(ci, /cargo build --release/);
    assert.match(ci, /npm pack --dry-run/);
    assert.match(ci, /id-token: write/);
    assert.match(ci, /npm install -g npm@11\.9\.0/);
    assert.match(ci, /npm publish --provenance --access public/);
  });

  it("verify script includes the polychat history verifier", () => {
    const pkg = readJson("package.json");
    assert.match(pkg.scripts.verify, /npm run verify:polychat-history/);
  });

  it("Claude provider no longer hard caps conversation discovery at 100", () => {
    const rustSrc = read("rust/server/src/providers/claude.rs");
    const webSrc = read("apps/extension/src/providers/claude.ts");
    assert.match(rustSrc, /fetch_claude_conversations/);
    assert.doesNotMatch(rustSrc, /limit=100/);
    assert.doesNotMatch(webSrc, /limit=100/);
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

  it("generated WebUI evidence outputs stay ignored and checkout paths stay out of tests", () => {
    const gitignore = read(".gitignore");
    const tracker = read("rust/server/src/routes/conversation_tracker.rs");
    assert.match(gitignore, /docs\/webui-assets\/webui-live-\*/);
    assert.doesNotMatch(tracker, /\/home\/sohamb\/Desktop\/polychat/);
  });
});
