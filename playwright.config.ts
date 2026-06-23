import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "web/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build:web && npx vite preview --config web/vite.config.ts --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
