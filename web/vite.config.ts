import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/health": "http://127.0.0.1:1443",
      "/v1": "http://127.0.0.1:1443",
      "/api": "http://127.0.0.1:1443",
    },
  },
});
