import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The FastAPI service (sawt_sakinah.service.app:app) runs on :8000 in dev.
// Routes are mounted at root (/projects, /jobs) with no CORS, so we proxy them
// here to keep the app same-origin. Override the target with SAWT_API_URL.
const API_TARGET = process.env.SAWT_API_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/projects": { target: API_TARGET, changeOrigin: true },
      "/jobs": { target: API_TARGET, changeOrigin: true },
    },
  },
});
