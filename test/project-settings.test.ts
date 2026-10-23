// Per-project execution settings: validation, store/read/clear, the
// additive migration, and POST /projects/:id/settings.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { domainError, MAX_SANDBOX_DOMAINS, protectedPathError, validateProjectSettings } from "../src/services/project-settings.ts";
import { grantError, validateExtraAllowedTools } from "../src/core/allowed-tools.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { createApp } from "../src/api/server.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wissel-project-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ACME = {
  sandboxAllowedDomains: ["pypi.org", "files.pythonhosted.org", "*.hashicorp.com"],
  verification: {
    commands: [["uv", "run", "pytest"], ["uv", "run", "ruff", "check"], ["terraform", "validate"]],
    allowedTools: ["Bash(uv run pytest:*)", "Bash(uv run ruff:*)", "Bash(terraform validate)"],
  },
  worktreeSetup: [["uv", "sync"]],
  protectedPaths: ["infra/prod/**", ".github/workflows/*.yml"],
};

function legacyDb(): Database {
  const db = new Database(":memory:");
  // The table as it was before the settings columns existed.
  db.run(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, source TEXT NOT NULL, sourceUrl TEXT, createdAt TEXT NOT NULL, eli5 TEXT, eli5UpdatedAt TEXT, mergeGate TEXT, mergeGateTimeoutMs INTEGER)",
  );
  db.run("INSERT INTO projects VALUES ('p', 'acme', '/r/acme', 'local', NULL, '2026-01-01', NULL, NULL, NULL, NULL)");
  return db;
}

// ---------- validation ----------

test("validateProjectSettings accepts a full acme-platform body and an empty one", () => {
  expect(validateProjectSettings(ACME)).toEqual({ ok: true, patch: ACME });
  expect(validateProjectSettings({})).toEqual({ ok: true, patch: {} });
});

test("validateProjectSettings: null clears, empty lists clear, duplicates drop", () => {
  expect(validateProjectSettings({ sandboxAllowedDomains: null, verification: null, worktreeSetup: null, protectedPaths: null })).toEqual({
    ok: true,
    patch: { sandboxAllowedDomains: null, verification: null, worktreeSetup: null, protectedPaths: null },
  });
  expect(validateProjectSettings({ sandboxAllowedDomains: [], verification: { commands: [], allowedTools: [] }, worktreeSetup: [], protectedPaths: [] })).toEqual({
    ok: true,
    patch: { sandboxAllowedDomains: null, verification: null, worktreeSetup: null, protectedPaths: null },
  });
  expect(validateProjectSettings({ sandboxAllowedDomains: ["pypi.org", "pypi.org"], protectedPaths: ["a", "a"] })).toEqual({
    ok: true,
    patch: { sandboxAllowedDomains: ["pypi.org"], protectedPaths: ["a"] },
  });
});

test("domainError: bare hostnames and *.host pass; wildcard-all, schemes, ports, paths, single labels refused", () => {
  for (const ok of ["pypi.org", "files.pythonhosted.org", "*.pythonhosted.org", "registry.terraform.io", "a-b.c0.dev"]) expect(domainError(ok)).toBeUndefined();
  for (const all of ["*", "*.*", "*.org", "*."]) expect(domainError(all)).toContain("every host");
  for (const bad of ["https://pypi.org", "pypi.org:443", "pypi.org/simple", "localhost", "PyPI.org", "-a.org", "a..org", "", " pypi.org", "*.*.org", "a.*.org"]) {
    expect(domainError(bad)).toContain("not a bare lowercase hostname");
  }
  expect(domainError(`${"a".repeat(250)}.org`)).toBeDefined();
});

test("protectedPathError: relative globs pass; absolute, home, .., backslash, empty refused", () => {
  for (const ok of ["infra/prod/**", "*.tf", ".github/workflows/deploy.yml", "./README.md", "a..b/c"]) expect(protectedPathError(ok)).toBeUndefined();
  expect(protectedPathError("/etc/passwd")).toContain("relative");
  expect(protectedPathError("~/x")).toContain("relative");
  expect(protectedPathError("C:/x")).toContain("relative");
  expect(protectedPathError("..")).toContain("..");
  expect(protectedPathError("a/../../b")).toContain("..");
  expect(protectedPathError("a\\b")).toContain("forward slashes");
  expect(protectedPathError("")).toContain("non-empty");
});

test("validateProjectSettings refuses bad input with a message naming the field", () => {
  const err = (body: unknown) => {
    const r = validateProjectSettings(body);
    if (r.ok) throw new Error(`accepted ${JSON.stringify(body)}`);
    return r.error;
  };
  expect(err(undefined)).toContain("must be an object");
  expect(err([])).toContain("must be an object");
  expect(err({ sandboxDomains: [] })).toContain('unknown setting "sandboxDomains"');
  expect(err({ sandboxAllowedDomains: "pypi.org" })).toContain("sandboxAllowedDomains must be a list of strings");
  expect(err({ sandboxAllowedDomains: [1] })).toContain("sandboxAllowedDomains must be a list of strings");
  expect(err({ sandboxAllowedDomains: ["*"] })).toContain("sandboxAllowedDomains:");
  const many = Array.from({ length: MAX_SANDBOX_DOMAINS + 1 }, (_, i) => `h${i}.example.com`);
  expect(err({ sandboxAllowedDomains: many })).toContain(`at most ${MAX_SANDBOX_DOMAINS}`);
  expect(validateProjectSettings({ sandboxAllowedDomains: many.slice(0, MAX_SANDBOX_DOMAINS) }).ok).toBe(true);
  expect(err({ verification: [] })).toContain("verification must be an object");
  expect(err({ verification: "uv run pytest" })).toContain("verification must be an object");
  expect(err({ verification: { commands: [["uv"]] } })).toContain("verification.allowedTools must be a list of strings");
  expect(err({ verification: { allowedTools: [] } })).toContain("verification.commands must be a list");
  expect(err({ verification: { commands: [[]], allowedTools: [] } })).toContain("non-empty list");
  expect(err({ verification: { commands: [], allowedTools: [], extra: 1 } })).toContain('unknown verification field "extra"');
  expect(err({ verification: { commands: [], allowedTools: ["Bash"] } })).toContain("command-scoped grant");
  expect(err({ verification: { commands: [], allowedTools: ["Bash(rm:*)"] } })).toContain("never granted");
  expect(err({ worktreeSetup: "uv sync" })).toContain("worktreeSetup must be a list of commands");
  expect(err({ worktreeSetup: [["uv", ""]] })).toContain("non-empty strings");
  expect(err({ protectedPaths: ["../outside"] })).toContain('protectedPaths: "../outside" must not contain ".."');
  expect(err({ protectedPaths: ["/abs"] })).toContain("relative");
});

// ---------- store ----------

test("setSettings stores, reads back, patches one field and clears with null; unknown id throws", async () => {
  const store = new SqliteProjectStore(legacyDb());
  const set = await store.setSettings("p", ACME);
  expect(set).toMatchObject(ACME);
  expect((await store.list())[0]).toMatchObject(ACME);

  // Absent keys are kept.
  const patched = await store.setSettings("p", { worktreeSetup: [["uv", "sync", "--frozen"]] });
  expect(patched).toMatchObject({ ...ACME, worktreeSetup: [["uv", "sync", "--frozen"]] });

  const cleared = await store.setSettings("p", { protectedPaths: null, sandboxAllowedDomains: null });
  expect(cleared.protectedPaths).toBeUndefined();
  expect(cleared.sandboxAllowedDomains).toBeUndefined();
  const [listed] = await store.list();
  expect(listed!.protectedPaths).toBeUndefined();
  expect(listed!.verification).toEqual(ACME.verification);

  // An empty patch changes nothing.
  expect(await store.setSettings("p", {})).toEqual(listed!);
  await expect(store.setSettings("nope", {})).rejects.toThrow("project not found");
});

test("migration: an existing DB without the columns gains them, reads as none set, and reopens idempotently", async () => {
  const db = legacyDb();
  const store = new SqliteProjectStore(db);
  const cols = (db.query("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining(["sandboxAllowedDomains", "verification", "worktreeSetup", "protectedPaths"]));
  const [p] = await store.list();
  for (const k of ["sandboxAllowedDomains", "verification", "worktreeSetup", "protectedPaths"]) expect(k in p!).toBe(false);

  await store.setSettings("p", { worktreeSetup: [["uv", "sync"]] });
  const reopened = new SqliteProjectStore(db);
  expect((await reopened.list())[0]!.worktreeSetup).toEqual([["uv", "sync"]]);
});

test("a project with none of the settings serialises exactly as before", async () => {
  const store = new SqliteProjectStore(legacyDb());
  const [p] = await store.list();
  expect(JSON.parse(JSON.stringify(p))).toEqual({ id: "p", name: "acme", path: "/r/acme", source: "local", createdAt: "2026-01-01" });
  // Set then cleared reads back the same.
  await store.setSettings("p", ACME);
  await store.setSettings("p", { sandboxAllowedDomains: null, verification: null, worktreeSetup: null, protectedPaths: null });
  expect((await store.list())[0]).toEqual(p!);
});

// ---------- route ----------

test("POST /projects/:id/settings sets, validates and clears; GET /projects returns the fields", async () => {
  const board = new SqliteBoard();
  const fetchApp = createApp(board, await Registry.load(), undefined, {});
  const repo = join(dir, "acme-platform");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  const created = await fetchApp(new Request("http://x/projects/local", { method: "POST", body: JSON.stringify({ path: repo }) }));
  const project = (await created.json()) as Record<string, unknown> & { id: string };
  const post = (body: string) => fetchApp(new Request(`http://x/projects/${project.id}/settings`, { method: "POST", body }));
  const listed = async () => ((await (await fetchApp(new Request("http://x/projects"))).json()) as Record<string, unknown>[]).find((p) => p.id === project.id)!;

  // Untouched: GET /projects is as before.
  expect(await listed()).toEqual(project);

  const set = await post(JSON.stringify(ACME));
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject(ACME);
  expect(await listed()).toMatchObject(ACME);

  for (const bad of [JSON.stringify({ sandboxAllowedDomains: ["*"] }), JSON.stringify({ protectedPaths: ["../x"] }), JSON.stringify({ nope: 1 }), "not json"]) {
    const res = await post(bad);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
  }
  // A refused body changes nothing.
  expect(await listed()).toMatchObject(ACME);

  const cleared = await post(JSON.stringify({ sandboxAllowedDomains: null, verification: null, worktreeSetup: null, protectedPaths: null }));
  expect(cleared.status).toBe(200);
  expect(await listed()).toEqual(project);

  expect((await fetchApp(new Request("http://x/projects/nope/settings", { method: "POST", body: "{}" }))).status).toBe(404);
});

// ---------- the write tier's lookup (§7) ----------

test("settingsFor: the set keys of the project at that path, {} for a project with none, undefined for an unregistered path, trailing slash tolerated", async () => {
  const store = new SqliteProjectStore(new Database(":memory:"));
  const repo = join(dir, "acme-platform");
  mkdirSync(repo);
  const gitOk = async () => ({ stdout: "", stderr: "", exitCode: 0 });
  const added = await store.addLocalProject(repo, {}, gitOk);
  if ("error" in added) throw new Error(added.error);

  expect(await store.settingsFor(repo)).toEqual({});
  expect(await store.settingsFor(join(dir, "elsewhere"))).toBeUndefined();

  await store.setSettings(added.project.id, { verification: ACME.verification });
  expect(await store.settingsFor(repo)).toEqual({ verification: ACME.verification });
  expect(await store.settingsFor(`${repo}/`)).toEqual({ verification: ACME.verification });
  expect(await store.settingsFor(join(repo, "..", "acme-platform"))).toEqual({ verification: ACME.verification });

  await store.setSettings(added.project.id, { protectedPaths: ACME.protectedPaths });
  expect(await store.settingsFor(repo)).toEqual({ verification: ACME.verification, protectedPaths: ACME.protectedPaths });

  await store.setSettings(added.project.id, { verification: null });
  expect(await store.settingsFor(repo)).toEqual({ protectedPaths: ACME.protectedPaths });
});

test("a uv/ruff/pyright/pytest verification passes the same checks as a per-card grant: `uv run pytest` is accepted, `python` stays refused", () => {
  const tools = ["Bash(uv run pytest:*)", "Bash(uv run ruff check:*)", "Bash(uv run ruff format --check:*)", "Bash(uv run pyright:*)"];
  const commands = [
    ["uv", "run", "pytest"],
    ["uv", "run", "ruff", "check"],
    ["uv", "run", "ruff", "format", "--check"],
    ["uv", "run", "pyright"],
  ];
  // The project setting and a per-card grant agree on every entry.
  expect(validateProjectSettings({ verification: { commands, allowedTools: tools } })).toEqual({ ok: true, patch: { verification: { commands, allowedTools: tools } } });
  expect(validateExtraAllowedTools(tools)).toEqual({ ok: true, tools });
  for (const t of tools) expect(grantError(t)).toBeUndefined();

  // An interpreter is never granted, through either door.
  for (const bad of ["Bash(python -m pytest:*)", "Bash(python3 -m pytest:*)", "Bash(python:*)"]) {
    const direct = validateExtraAllowedTools([bad]);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error).toContain("which is never granted per card");
    const viaSettings = validateProjectSettings({ verification: { commands: [["uv", "run", "pytest"]], allowedTools: [bad] } });
    expect(viaSettings.ok).toBe(false);
    if (!viaSettings.ok) expect(viaSettings.error).toBe(`verification.allowedTools: ${(direct as { error: string }).error}`);
  }
});
