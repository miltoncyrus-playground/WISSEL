import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served at /pipelines/edit by src/api/server.ts's static route (see
// servePipelineEditorAsset) — base must match that mount point so every
// built asset URL resolves correctly, both under the real Bun server and
// under `vite preview`. The dev-server proxy lets `bun run dev` (this
// project, at :8787 — see README.md) be the live API backend while this
// app's own `vite` dev server handles hot reload for the canvas itself.
export default defineConfig({
  plugins: [react()],
  base: "/pipelines/edit/",
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/agents": "http://localhost:8787",
      "/pipelines": "http://localhost:8787",
      "/board": "http://localhost:8787",
    },
  },
});
