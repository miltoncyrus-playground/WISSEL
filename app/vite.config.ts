import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
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

/** Query that marks an import of one of the board's plain browser
 *  scripts (src/api/public/*.js). */
export const BROWSER_SCRIPT_QUERY = "?browser-script";

/**
 * The board's browser scripts (src/api/public/*.js) export only through
 * `if (typeof module !== "undefined") module.exports = {...}`, so board.html
 * can load them as plain <script>s. Imported with `?browser-script`, this
 * hands Vite (and vitest) the file unchanged with a local `module` in
 * front and `export default module.exports` after, so the app runs the
 * board's own code (SDD §3.3: Quick read via board-news.js, no copy).
 * app/src/news.ts is the typed ESM wrapper over it.
 */
export function browserScript(): Plugin {
  return {
    name: "wissel-browser-script",
    enforce: "pre",
    load(id) {
      if (!id.endsWith(BROWSER_SCRIPT_QUERY)) return null;
      const file = id.slice(0, -BROWSER_SCRIPT_QUERY.length);
      this.addWatchFile(file);
      return `const module = { exports: {} };\n${readFileSync(file, "utf8")}\nexport default module.exports;\n`;
    },
  };
}

export default defineConfig({
  plugins: [browserScript(), react()],
  base: "/app/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // The dev server may read the board's browser scripts (see browserScript).
    fs: { allow: [".", "../src/api/public"] },
    proxy: {
      "/tasks": api,
      "/pipelines": api,
      "/events": api,
      "/feed": api,
      "/podcasts": api,
      "/pipeline-runs": api,
      "/agents": api,
      "/board": api,
    },
  },
});
