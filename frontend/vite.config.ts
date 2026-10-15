import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The FastAPI service (sawt_sakinah.service.app:app) runs on :38427 in dev.
// Routes are mounted at root (/projects, /jobs, /models, /quran, /app/*) with no CORS, so
// we proxy them here to keep the app same-origin. Override the target with SAWT_API_URL.
const API_TARGET = process.env.SAWT_API_URL ?? "http://127.0.0.1:38427";
const DEV_PORT = Number(process.env.SAWT_VITE_PORT ?? "38428");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    // Same-origin through the proxy; no other local page should get CORS access.
    cors: false,
    proxy: {
      "/projects": { target: API_TARGET, changeOrigin: true },
      "/jobs": { target: API_TARGET, changeOrigin: true },
      "/models": { target: API_TARGET, changeOrigin: true },
      "/quran": { target: API_TARGET, changeOrigin: true },
      "/app/": { target: API_TARGET, changeOrigin: true },
    },
  },
});
