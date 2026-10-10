import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/api/server.ts";
import { DEFAULT_APP_DIST, isAppPath, serveAppAsset } from "../src/api/serve-app.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";

// docs/SDD-wissel-app.md §3.1/§4.1: /app static serving, SPA fallback
// and traversal refusal, against a fixture dist/ so no `vite build` is
// needed.

let root: string;
let dist: string;
let distUrl: URL;
const INDEX = "<!doctype html><title>wissel</title><div id=root></div>";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wissel-serve-app-test-"));
  dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), INDEX);
  await writeFile(join(dist, "assets", "index-abc123.js"), "console.log('app');");
  await writeFile(join(dist, "assets", "index-abc123.css"), "body{}");
  await writeFile(join(dist, "assets", "geist-latin-400-normal-x1.woff2"), "wOF2");
  await writeFile(join(dist, "robots.txt"), "User-agent: *");
  // A file next to dist/, the thing a traversal would be after.
  await writeFile(join(root, "secret.txt"), "do not serve");
  distUrl = new URL(`file://${dist}/`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function makeApp(opts?: CreateAppOptions) {
  const registry = await Registry.load();
  return createApp(new SqliteBoard(), registry, undefined, { appDist: distUrl, ...opts });
}

test("isAppPath matches /app and below, nothing that merely starts with 'app'", () => {
  expect(isAppPath("/app")).toBe(true);
  expect(isAppPath("/app/")).toBe(true);
  expect(isAppPath("/app/assets/x.js")).toBe(true);
  expect(isAppPath("/apps")).toBe(false);
  expect(isAppPath("/application")).toBe(false);
  expect(isAppPath("/board")).toBe(false);
});

test("the default dist is app/dist at the repo root", () => {
  expect(DEFAULT_APP_DIST.pathname).toEndWith("/app/dist/");
});

test("GET /app and /app/ serve index.html, revalidated", async () => {
  const app = await makeApp();
  for (const path of ["/app", "/app/"]) {
    const res = await app(req(path));
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(INDEX);
  }
});

test("client routes fall back to index.html (SPA)", async () => {
  const app = await makeApp();
  for (const path of ["/app/feed", "/app/board/abc-123", "/app/some/deep/route"]) {
    const res = await app(req(path));
    expect(res.status, path).toBe(200);
    expect(await res.text()).toBe(INDEX);
  }
});

test("static files are served as is with the right type; hashed assets cache hard", async () => {
  const app = await makeApp();
  const js = await app(req("/app/assets/index-abc123.js"));
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toMatch(/javascript/);
  expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await js.text()).toBe("console.log('app');");

  const css = await app(req("/app/assets/index-abc123.css"));
  expect(css.headers.get("content-type")).toMatch(/^text\/css/);

  const font = await app(req("/app/assets/geist-latin-400-normal-x1.woff2"));
  expect(font.status).toBe(200);
  expect(font.headers.get("content-type")).toMatch(/woff2/);

  const txt = await app(req("/app/robots.txt"));
  expect(txt.status).toBe(200);
  expect(txt.headers.get("cache-control")).toBe("no-cache");
});

test("a missing file is a 404, not index.html posing as a script", async () => {
  const app = await makeApp();
  expect((await app(req("/app/assets/gone-zzz.js"))).status).toBe(404);
  expect((await app(req("/app/missing.css"))).status).toBe(404);
});

test("a directory is not a file: /app/assets falls back to index.html", async () => {
  const app = await makeApp();
  const res = await app(req("/app/assets"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(INDEX);
});

test("traversal through the HTTP entry point never escapes dist/", async () => {
  const app = await makeApp();
  for (const path of [
    "/app/../secret.txt",
    "/app/%2e%2e/secret.txt",
    "/app/..%2fsecret.txt",
    "/app/..%2Fsecret.txt",
    "/app/assets/..%2f..%2fsecret.txt",
    "/app/%2e%2e%2fsecret.txt",
    "/app/..%5csecret.txt",
    "/app/%00",
  ]) {
    const res = await app(req(path));
    const body = await res.text();
    expect(body, path).not.toContain("do not serve");
    expect(res.status, path).toBe(404);
  }
});

test("serveAppAsset's own guard refuses raw '..' paths (no URL normalisation in front)", async () => {
  for (const path of ["/app/../secret.txt", "/app/../../../../etc/passwd", "/app/assets/../../secret.txt"]) {
    const res = await serveAppAsset(path, distUrl);
    expect(res.status, path).toBe(404);
    expect(await res.text()).not.toContain("do not serve");
  }
});

test("a path that stays inside dist/ after '..' still works", async () => {
  const res = await serveAppAsset("/app/assets/../robots.txt", distUrl);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("User-agent: *");
});

test("bad percent-encoding is a 404, not a crash", async () => {
  const app = await makeApp();
  expect((await app(req("/app/%E0%A4%A"))).status).toBe(404);
});

test("only GET: POST /app is not found", async () => {
  const app = await makeApp();
  expect((await app(req("/app", { method: "POST" }))).status).toBe(404);
  expect((await app(req("/app/assets/index-abc123.js", { method: "DELETE" }))).status).toBe(404);
});

test("503 with the fix when the app is not built", async () => {
  const empty = await mkdtemp(join(tmpdir(), "wissel-serve-app-unbuilt-"));
  try {
    const app = await makeApp({ appDist: new URL(`file://${empty}/`) });
    for (const path of ["/app", "/app/feed", "/app/assets/index-abc123.js"]) {
      const res = await app(req(path));
      expect(res.status, path).toBe(503);
      expect(await res.text()).toContain("bun run build:app");
    }
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("/apps is not the app (falls through to the API's 404)", async () => {
  const app = await makeApp();
  expect((await app(req("/apps"))).status).toBe(404);
});
