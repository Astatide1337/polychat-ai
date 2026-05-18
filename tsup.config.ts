import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  jsx: "react",
  format: ["esm"],
  target: "node22",
  clean: true,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [
    "commander",
    "chalk",
    "ora",
    "playwright-core",
    "chromium-bidi",
    "ink",
    "ink-text-input",
    "react",
    "react-devtools-core",
  ],
});
