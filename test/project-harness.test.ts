import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { validateProjectSettings } from "../src/services/project-settings.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Registry } from "../src/core/registry.ts";
import { inheritedPlacement } from "../src/core/orchestrator.ts";
import type { Harness } from "../src/core/types.ts";

// A project's harness (Project.harness): the account every new card in
// the repo asks for, docs/SDD-project-harness.md.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wissel-project-harness-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const harness = (id: string): Harness => ({ id, tool: "claude-cli", label: id, enabled: true });

async function makeApp() {
  const board = new SqliteBoard();
  const harnesses = HarnessPool.from([harness("claude-work"), harness("claude-other")]);
  const app = createApp(board, await Registry.load(), undefined, { harnesses });
  const repo = join(dir, "acme-platform");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  const created = await app(new Request("http://x/projects/local", { method: "POST", body: JSON.stringify({ path: repo }) }));
  const project = (await created.json()) as { id: string };
  const setSettings = (body: unknown) => app(new Request(`http://x/projects/${project.id}/settings`, { method: "POST", body: JSON.stringify(body) }));
  const newCard = (body: Record<string, unknown>) =>
    app(new Request("http://x/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t", body: "", labels: ["intake"], ...body }) }));
  return { app, board, repo, project, setSettings, newCard };
}

test("validateProjectSettings: harness is a plain id or null; anything else is refused", () => {
  expect(validateProjectSettings({ harness: "claude-work" })).toEqual({ ok: true, patch: { harness: "claude-work" } });
  expect(validateProjectSettings({ harness: null })).toEqual({ ok: true, patch: { harness: null } });
  for (const bad of ["", "a b", "-x", 5, ["a"], "x".repeat(101)]) {
    expect(validateProjectSettings({ harness: bad }).ok).toBe(false);
  }
});

test("POST /projects/:id/settings stores a harness, refuses an unknown one, and null clears it", async () => {
  const { app, project, setSettings } = await makeApp();
  const unknown = await setSettings({ harness: "no-such-harness" });
  expect(unknown.status).toBe(400);
  expect(((await unknown.json()) as { error: string }).error).toContain("unknown harness");

  const ok = await setSettings({ harness: "claude-work" });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { harness?: string }).harness).toBe("claude-work");
  const listed = (await (await app(new Request("http://x/projects"))).json()) as { id: string; harness?: string }[];
  expect(listed.find((p) => p.id === project.id)?.harness).toBe("claude-work");

  const cleared = await setSettings({ harness: null });
  expect(((await cleared.json()) as { harness?: string }).harness).toBeUndefined();
});

test("a new card in the project's repo gets the project's harness; a card's own harness wins; another repo is untouched", async () => {
  const { board, repo, setSettings, newCard } = await makeApp();
  await setSettings({ harness: "claude-work" });

  const plain = (await (await newCard({ repo })).json()) as { id: string; harnessOverride?: string };
  expect(plain.harnessOverride).toBe("claude-work");
  expect((await board.get(plain.id))?.harnessOverride).toBe("claude-work");

  const own = (await (await newCard({ repo, harnessOverride: "claude-other" })).json()) as { harnessOverride?: string };
  expect(own.harnessOverride).toBe("claude-other");

  const elsewhere = (await (await newCard({ repo: join(dir, "not-a-project") })).json()) as { harnessOverride?: string };
  expect(elsewhere.harnessOverride).toBeUndefined();

  const noRepo = (await (await newCard({})).json()) as { harnessOverride?: string };
  expect(noRepo.harnessOverride).toBeUndefined();
});

test("PATCH on a card re-applies the project's harness when the card's own is cleared", async () => {
  const { app, repo, setSettings, newCard } = await makeApp();
  await setSettings({ harness: "claude-work" });
  const card = (await (await newCard({ repo, harnessOverride: "claude-other" })).json()) as { id: string };
  const res = await app(new Request(`http://x/tasks/${card.id}`, { method: "PATCH", body: JSON.stringify({ harnessOverride: null }) }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { harnessOverride?: string }).harnessOverride).toBe("claude-work");
});

test("inheritedPlacement: a derived card takes its parent's harness and merge target, and nothing it lacks", () => {
  expect(inheritedPlacement({ harnessOverride: "claude-work", mergeTarget: "spec/x" })).toEqual({ harnessOverride: "claude-work", mergeTarget: "spec/x" });
  expect(inheritedPlacement({ harnessOverride: "claude-work" })).toEqual({ harnessOverride: "claude-work" });
  expect(inheritedPlacement({})).toEqual({});
});
