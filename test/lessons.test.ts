import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { globRegex, LessonDecisions, lessonsForFiles, parseLessons, proposals, ruleText } from "../src/services/lessons.ts";

// docs/SDD-coordinator.md §4.15, phase 4 card 23: each curated lesson has
// a scope; Wissel problems become issues to file, project rules are
// proposed for cardRules and applied only on approval, path lessons match
// a card's planned files. Nothing is injected into a prompt here.

const MD = [
  "# Lessons",
  "",
  "## The worktree sandbox needs bwrap user namespaces",
  "Scope: wissel",
  "On hosts with the AppArmor bwrap profile, sandboxed Bash fails.",
  "",
  "## Stage files by name",
  "Scope: project",
  "Never git add -A in this repo.",
  "More detail on a second line.",
  "",
  "## The importer retries are in one place",
  "Scope: path:src/importer/**",
  "Change retry counts in retry.ts only.",
  "",
  "## An old lesson with no scope",
  "It stays as it was.",
].join("\n");

describe("parsing", () => {
  test("each section's Scope line is read off; a section without one is unscoped; the key is stable", () => {
    const lessons = parseLessons(MD);
    expect(lessons.map((l) => [l.title, l.scope ?? null])).toEqual([
      ["The worktree sandbox needs bwrap user namespaces", { kind: "wissel" }],
      ["Stage files by name", { kind: "project" }],
      ["The importer retries are in one place", { kind: "path", glob: "src/importer/**" }],
      ["An old lesson with no scope", null],
    ]);
    expect(lessons[1]!.body).toBe("Never git add -A in this repo.\nMore detail on a second line.");
    expect(parseLessons(MD)[1]!.key).toBe(lessons[1]!.key);
    expect(parseLessons(MD.replace("Never git", "Do not git"))[1]!.key).not.toBe(lessons[1]!.key);
  });

  test("globs: * within a segment, ** across, ? one character", () => {
    expect(globRegex("src/importer/**").test("src/importer/a/b.ts")).toBe(true);
    expect(globRegex("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globRegex("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globRegex("**/retry.ts").test("src/importer/retry.ts")).toBe(true);
    expect(globRegex("a?.md").test("ab.md")).toBe(true);
  });

  test("path lessons match a card only through its planned files", () => {
    const lessons = parseLessons(MD);
    expect(lessonsForFiles(lessons, ["src/importer/retry.ts"]).map((l) => l.title)).toEqual(["The importer retries are in one place"]);
    expect(lessonsForFiles(lessons, ["docs/x.md"])).toEqual([]);
    expect(lessonsForFiles(lessons, undefined)).toEqual([]);
  });

  test("proposals: wissel lessons as issues, project lessons as card rules; a decision sticks", () => {
    const decisions = new LessonDecisions(new SqliteBoard().db);
    const lessons = parseLessons(MD);
    expect(proposals(lessons, decisions).map((p) => [p.kind, p.title, p.status])).toEqual([
      ["wissel-issue", "The worktree sandbox needs bwrap user namespaces", "proposed"],
      ["card-rule", "Stage files by name", "proposed"],
    ]);
    decisions.decide(lessons[1]!.key, "rejected");
    expect(proposals(lessons, decisions)[1]!.status).toBe("rejected");
    expect(ruleText(proposals(lessons, decisions)[1]!)).toBe("- Stage files by name: Never git add -A in this repo.");
  });
});

describe("the API", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-lessons-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("approving a card rule appends it to the project's cardRules; a Wissel issue becomes an owner task; a card sees its path lessons", async () => {
    const memoryPath = join(dir, "lessons.md");
    writeFileSync(memoryPath, MD);
    const board = new SqliteBoard();
    const app = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]), memoryPath });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const repo = join(dir, "shop");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const projectId = (await call("POST", "/projects/local", { path: repo })).body.id as string;
    await call("POST", `/projects/${projectId}/settings`, { cardRules: "Run the tests." });

    const props = (await call("GET", "/lessons/proposals")).body as unknown as Array<{ key: string; kind: string }>;
    const rule = props.find((p) => p.kind === "card-rule")!;
    const issue = props.find((p) => p.kind === "wissel-issue")!;
    expect((await call("POST", `/lessons/${rule.key}/approve`)).status).toBe(400);
    expect((await call("POST", `/lessons/${rule.key}/approve`, { projectId })).body).toMatchObject({ status: "approved", projectId });
    const project = ((await call("GET", "/projects")).body as unknown as Array<{ id: string; cardRules?: string }>).find((p) => p.id === projectId)!;
    expect(project.cardRules).toBe("Run the tests.\n- Stage files by name: Never git add -A in this repo.");

    const filed = await call("POST", `/lessons/${issue.key}/approve`);
    expect(filed.body).toMatchObject({ status: "approved", ownerTaskId: expect.any(String) });
    const tasks = (await call("GET", "/owner-tasks?status=open")).body as unknown as Array<{ title: string }>;
    expect(tasks.map((t) => t.title)).toEqual(["File a Wissel issue: The worktree sandbox needs bwrap user namespaces"]);

    const card = await board.create({ title: "Tune retries", body: "", labels: [], repo, files: ["src/importer/retry.ts"] });
    expect(((await call("GET", `/tasks/${card.id}/lessons`)).body as unknown as Array<{ title: string }>).map((l) => l.title)).toEqual(["The importer retries are in one place"]);
    expect((await call("GET", "/lessons")).body).toHaveLength(4);
  });
});
