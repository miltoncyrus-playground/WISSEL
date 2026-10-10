import { stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Where `app/` (docs/SDD-wissel-app.md §3.1) builds to: `app/dist/` at
 *  the repo root, resolved relative to this file like PUBLIC_DIR, not
 *  the cwd. gitignored; `bun run serve` and the e2e web server build it
 *  first (`bun run build:app`). */
export const DEFAULT_APP_DIST = new URL("../../app/dist/", import.meta.url);

/** `/app` and everything under it. Not `/apps` or `/application`. */
export function isAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A last path segment with an extension (`x.js`, `font.woff2`) names
 *  a file; anything else is a client route. */
function looksLikeFile(path: string): boolean {
  return /\.[a-z0-9]+$/i.test(basename(path));
}

/** Serves the built app for a `GET /app*` request:
 *  - a real file under `distDir` as is, with its type from the
 *    extension (Bun.file); hashed `assets/` files cached for a year,
 *    everything else revalidated;
 *  - any other path that isn't a file name falls back to `index.html`
 *    (the SPA entry; screens are hash routes, so this mostly serves
 *    `/app` and `/app/`);
 *  - a missing file name is a plain 404, never HTML posing as a script;
 *  - a path that decodes or resolves outside `distDir` is a 404, before
 *    anything touches the disk. `new URL(req.url)` already collapses
 *    `..` and `%2e%2e` segments, but an encoded slash (`..%2f`) survives
 *    it, so this decodes and resolves the path itself;
 *  - 503 with the fix while the app isn't built at all. */
export async function serveAppAsset(pathname: string, distDir: URL): Promise<Response> {
  const root = resolve(fileURLToPath(distDir));
  const sub = pathname.slice("/app".length).replace(/^\/+/, "");

  let decoded: string;
  try {
    decoded = decodeURIComponent(sub);
  } catch {
    return notFound();
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return notFound();
  const candidate = resolve(root, decoded);
  if (candidate !== root && !candidate.startsWith(root + sep)) return notFound();

  const index = join(root, "index.html");
  if (!(await isFile(index))) {
    return new Response("wissel app not built: run `bun run build:app` (or `bun run serve`, which builds it)", { status: 503 });
  }

  if (decoded && (await isFile(candidate))) {
    const immutable = decoded.startsWith("assets/");
    return new Response(Bun.file(candidate), {
      headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }
  if (decoded && looksLikeFile(decoded)) return notFound();

  return new Response(Bun.file(index), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}
