import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A real single-page app (docs/SDD-wissel-app.md §3.1), unlike
// pipeline-editor/ which the board imports as a module: index.html is
// the entry, and src/api/server.ts (serveAppAsset) serves dist/ at /app
// with an SPA fallback to index.html. `base` matches that mount point so
// every chunk, font and asset URL resolves under /app/. Asset names are
// hashed, so the server can cache them hard and only index.html needs
// revalidating. The dev proxy makes `bun run dev` at the repo root
// (:8787) the API backend.
const api = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  base: "/app/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/tasks": api,
      "/pipelines": api,
      "/events": api,
      "/feed": api,
      "/pipeline-runs": api,
      "/agents": api,
      "/board": api,
    },
  },
});
