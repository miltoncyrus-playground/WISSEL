import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TASK_STATUSES } from "../app/src/types.ts";

// docs/SDD-wissel-app.md §3.1 (card 1): what ties app/ to the rest of
// the repo. The app's own logic is tested in app/test (vitest).

const root = join(import.meta.dir, "..");
const read = (p: string) => readFile(join(root, p), "utf8");

test("app/src/types.ts lists exactly TaskCard.status's values", async () => {
  const src = await read("src/core/types.ts");
  const card = src.slice(src.indexOf("export interface TaskCard {"));
  const m = /\n\s*status:\s*([^;]+);/.exec(card);
  expect(m).not.toBeNull();
  const values = [...m![1]!.matchAll(/"([^"]+)"/g)].map((v) => v[1]!);
  const ours: string[] = [...TASK_STATUSES];
  expect(ours.sort()).toEqual(values.sort());
});

test("app/src/types.ts FEED_KINDS matches src/services/feed.ts (card 2)", async () => {
  const { FEED_KINDS: app } = await import("../app/src/types.ts");
  const { FEED_KINDS: server } = await import("../src/services/feed.ts");
  expect([...app]).toEqual([...server]);
});

/** The field names of `export interface <name> {...}` in a TS source. */
function fieldsOf(src: string, name: string): string[] {
  const start = src.indexOf(`export interface ${name} {`);
  expect(start, name).toBeGreaterThan(-1);
  const body = src.slice(src.indexOf("{", start) + 1, src.indexOf("\n}", start));
  return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!).sort();
}

test("app/src/types.ts PodcastEpisode and PodcastQuickRead match src/services/podcasts.ts (card 3)", async () => {
  const server = await read("src/services/podcasts.ts");
  const app = await read("app/src/types.ts");
  for (const name of ["PodcastEpisode", "PodcastQuickRead"]) {
    expect(fieldsOf(app, name), name).toEqual(fieldsOf(server, name));
  }
});

test("app/src/types.ts's Ask types match the server's (card 4)", async () => {
  const app = await read("app/src/types.ts");
  const conversations = await read("src/services/conversations.ts");
  for (const name of ["Conversation", "ChatMessage"]) {
    expect(fieldsOf(app, name), name).toEqual(fieldsOf(conversations, name));
  }
  expect(fieldsOf(app, "DroppedAction")).toEqual(fieldsOf(await read("src/services/concierge-actions.ts"), "DroppedAction"));
  expect(fieldsOf(app, "AskResult")).toEqual(fieldsOf(await read("src/services/concierge.ts"), "AskResult"));

  // The union types, compared as text with whitespace collapsed.
  const union = (src: string, name: string) => {
    const at = src.indexOf(`export type ${name} =`);
    expect(at, name).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf(";\n", at)).replace(/\s+/g, " ");
  };
  expect(union(app, "ExecutedAction")).toBe(union(conversations, "ExecutedAction"));
  expect(union(app, "AskEvent")).toBe(union(await read("src/services/concierge.ts"), "AskEvent"));

  const { MAX_MESSAGE_LENGTH: appMax, AUDIO_AGENT: appAudio } = await import("../app/src/ask.ts");
  const { MAX_MESSAGE_LENGTH: serverMax } = await import("../src/services/concierge.ts");
  const { AUDIO_AGENT: serverAudio } = await import("../src/services/news-run-checks.ts");
  expect(appMax).toBe(serverMax);
  expect(appAudio).toBe(serverAudio);
});

test("app/src/types.ts Wrapped and WrappedStreak match src/services/wrapped.ts and streaks.ts (card 6)", async () => {
  const app = await read("app/src/types.ts");
  expect(fieldsOf(app, "Wrapped")).toEqual(fieldsOf(await read("src/services/wrapped.ts"), "Wrapped"));
  expect(fieldsOf(app, "WrappedStreak")).toEqual(fieldsOf(await read("src/services/streaks.ts"), "Streak"));
  const { WRAPPED_PERIODS } = await import("../app/src/wrapped.ts");
  const { WRAPPED_DEFAULT_PERIOD } = await import("../src/services/wrapped.ts");
  expect(WRAPPED_PERIODS[0].input).toBe(WRAPPED_DEFAULT_PERIOD);
});

test("the app reuses board-news.js through the ESM wrapper, never a copy (card 3)", async () => {
  const wrapper = await read("app/src/news.ts");
  expect(wrapper).toContain('"../../src/api/public/board-news.js?browser-script"');
  expect(await read("app/vite.config.ts")).toContain("browserScript()");
  const files = (await readdir(join(root, "app/src"), { recursive: true })).filter((f) => /\.tsx?$/.test(f));
  for (const f of files) {
    const text = await read(`app/src/${f}`);
    // The board's shaping functions are defined in one place only.
    expect(text, f).not.toMatch(/function (quickReadView|joinExplained|newsHref|gatherUrlSet)\b/);
  }
});

test("board.html's header links to /app (the one board change card 1 makes)", async () => {
  const html = await read("src/api/public/board.html");
  const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>", html.indexOf('<header class="topbar">')));
  expect(header).toMatch(/<a [^>]*href="\/app"[^>]*>/);
});

test("app/dist is gitignored (built, never committed)", async () => {
  const ignore = (await read(".gitignore")).split("\n").map((l) => l.trim());
  expect(ignore.includes("dist/") || ignore.includes("app/dist/")).toBe(true);
});

test("app/bun.lock is committed, like pipeline-editor/bun.lock (serve and e2e build from it)", async () => {
  // bun run serve and the Playwright web server fail if build:app
  // fails, so app/ installs from a pinned lockfile, not ^ ranges.
  const lock = await read("app/bun.lock").catch(() => "");
  expect(lock, "run `cd app && bun install` and keep app/bun.lock").not.toBe("");
  const pkg = JSON.parse(await read("app/package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  for (const name of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) {
    expect(lock, name).toContain(`"${name}"`);
  }
});

test("vite builds the app for the /app mount point", async () => {
  const vite = await read("app/vite.config.ts");
  expect(vite).toContain('base: "/app/"');
  expect(vite).toContain('outDir: "dist"');
});

test("fonts are self-hosted @fontsource packages: no Google Fonts anywhere in app/", async () => {
  const pkg = JSON.parse(await read("app/package.json")) as { dependencies: Record<string, string> };
  for (const name of ["@fontsource/bricolage-grotesque", "@fontsource/geist", "@fontsource/geist-mono"]) {
    expect(pkg.dependencies[name], name).toBeDefined();
  }
  const files = ["app/index.html", ...(await readdir(join(root, "app/src"), { recursive: true })).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => `app/src/${f}`)];
  for (const f of files) {
    const text = await read(f);
    expect(text, f).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  }
});

test("app/ has no framework beyond the editor's stack (React, Vite, vitest); html-to-image is the one library (card 6)", async () => {
  const pkg = JSON.parse(await read("app/package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const deps = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@fontsource/"));
  // html-to-image (MIT) makes the Wrapped card PNG (SDD §3.6).
  expect(deps.sort()).toEqual(["html-to-image", "react", "react-dom"]);
  expect(Object.keys(pkg.devDependencies)).toContain("vitest");
  expect(Object.keys(pkg.devDependencies)).toContain("vite");
});

test("UI copy has no em dashes", async () => {
  const files = (await readdir(join(root, "app/src"), { recursive: true })).filter((f) => /\.tsx$/.test(f));
  for (const f of files) {
    const text = await read(`app/src/${f}`);
    // Comments may use them; JSX text and strings may not. Strip
    // comments before checking.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code, f).not.toContain("—");
  }
});
