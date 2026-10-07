import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Since card B2 (docs/SDD-ui-cleanup.md §4.2) the editor is mounted
// inside the board shell, not served as its own page: board.html does
// `import("/pipelines/edit/pipeline-editor.js")` and calls its
// mountPipelineEditor export. So the build's input is src/main.tsx, not
// index.html (that's the `bun run dev` harness only), and:
// - the entry has a fixed name, so the board needs no manifest. It
//   must match PIPELINE_EDITOR_ENTRY in src/api/server.ts
//   (test/api.test.ts checks both);
// - preserveEntrySignatures keeps the entry's exports, which an app
//   build would otherwise drop;
// - CSS is imported `?inline` in main.tsx and injected at mount, so
//   there's no stylesheet to link.
// `base` matches the server's mount point (servePipelineEditorAsset), so
// any other chunk or asset URL resolves under /pipelines/edit/. The dev
// proxy makes `bun run dev` at the repo root (:8787) the API backend.
export default defineConfig({
  plugins: [react()],
  base: "/pipelines/edit/",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "src/main.tsx",
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: "pipeline-editor.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    proxy: {
      "/agents": "http://localhost:8787",
      "/pipelines": "http://localhost:8787",
      "/board": "http://localhost:8787",
    },
  },
});
