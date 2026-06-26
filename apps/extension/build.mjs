import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const dist = resolve(root, "dist");
const testMode = process.env.POLYCHAT_EXTENSION_TEST_MODE === "1";

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    "background/index": "src/background/index.ts",
    "content/index": "src/content/index.ts",
    "popup/index": "src/popup/index.ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["firefox115"],
  outdir: dist,
  define: {
    "process.env.POLYCHAT_EXTENSION_TEST_MODE": testMode ? "true" : "false",
  },
  minifySyntax: true,
  sourcemap: true,
  logLevel: "info",
});

cpSync(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
cpSync(resolve(root, "popup.html"), resolve(dist, "popup.html"));

const iconsSrc = resolve(root, "icons");
const iconsDist = resolve(dist, "icons");
if (existsSync(iconsSrc)) {
  cpSync(iconsSrc, iconsDist, { recursive: true });
}
