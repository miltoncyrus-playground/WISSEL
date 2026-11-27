import { describe, expect, test } from "bun:test";
import { type Failure, FailureCause, present } from "../src/core/failure-presentation.ts";
import { findInternalVocabulary } from "../src/core/user-vocabulary.ts";

const T = "1a2b3c4d-0000-0000-0000-000000000000";
const UTC = { timeZone: "UTC" };

interface Row {
  name: string;
  failure: Failure;
  cause: FailureCause;
  specifics: string[];
  action?: { label: string; href: string; method: "GET" | "POST" };
}

const rows: Row[] = [
  {
    name: "merge gate failed",
    failure: { cause: "merge-gate-failed", taskId: T, command: "bun test", lastLines: "a\nb\n\n(fail) login > rejects bad password\n 1 fail\n" },
    cause: FailureCause.MergeGateFailed,
    specifics: ["`bun test`", "(fail) login > rejects bad password", "1 fail"],
    action: { label: "Send it back for a fix", href: `/tasks/${T}/escalation/retry`, method: "POST" },
  },
  {
    name: "no harness free",
    failure: { cause: "no-harness-free", taskId: T, account: "claude-work", signedOut: true },
    cause: FailureCause.NoHarnessFree,
    specifics: ["claude-work", "signed out"],
    action: { label: "Use another account", href: `/tasks/${T}/harness`, method: "POST" },
  },
  {
    name: "session or spend limit (429)",
    failure: { cause: "session-limit", taskId: T, resetsAt: "2026-11-26T14:20:00Z", account: "claude-personal" },
    cause: FailureCause.SessionLimit,
    specifics: ["14:20", "claude-personal", "raise the limit"],
  },
  {
    name: "sandbox refused a command",
    failure: { cause: "sandbox-refused", taskId: T, commands: ["Bash(psql:*)"] },
    cause: FailureCause.SandboxRefused,
    specifics: ["`Bash(psql:*)`", "not allowed"],
    action: { label: "Allow and retry", href: `/tasks/${T}/escalation/grant-and-retry`, method: "POST" },
  },
  {
    name: "merge conflict",
    failure: { cause: "merge-conflict", taskId: T, target: "main", files: ["src/a.ts", "src/b.ts"] },
    cause: FailureCause.MergeConflict,
    specifics: ["`main` moved", "`src/a.ts` and `src/b.ts`"],
    action: { label: "Resolve it", href: `/app#/board/${T}`, method: "GET" },
  },
  {
    name: "review round cap reached",
    failure: { cause: "review-round-cap", taskId: T, rounds: 5 },
    cause: FailureCause.ReviewRoundCap,
    specifics: ["5 review rounds", "disagree", "a person should look"],
    action: { label: "Open", href: `/app#/board/${T}`, method: "GET" },
  },
  {
    name: "nothing matched",
    failure: { cause: "nothing-matched", taskId: T, project: "billing" },
    cause: FailureCause.NothingMatched,
    specifics: ["Nothing in billing can do this", "add an agent", "pick another project"],
    action: { label: "Open", href: `/app#/board/${T}`, method: "GET" },
  },
];

describe("present", () => {
  test.each(rows)("$name", (row) => {
    const p = present(row.failure, UTC);
    expect(p.cause).toBe(row.cause);
    for (const s of row.specifics) expect(p.sentence).toContain(s);
    if (row.action) expect(p.action).toEqual(row.action);
    else expect(p.action).toBeUndefined();
  });

  test.each(rows)("$name never makes the reader interpret a status name", (row) => {
    const p = present(row.failure, UTC);
    expect(findInternalVocabulary(p.sentence)).toEqual([]);
    expect(findInternalVocabulary(p.action?.label ?? "")).toEqual([]);
  });

  test.each(rows)("$name still reads as a sentence with no specifics", (row) => {
    const bare = { cause: row.failure.cause, taskId: T } as Failure;
    const p = present(bare, UTC);
    expect(p.cause).toBe(row.cause);
    expect(p.sentence.length).toBeGreaterThan(20);
    expect(p.sentence).not.toContain("undefined");
    expect(findInternalVocabulary(p.sentence)).toEqual([]);
  });

  test("a gate failure quotes only the last lines of output", () => {
    const out = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const p = present({ cause: "merge-gate-failed", taskId: T, command: "bun test", lastLines: out });
    expect(p.sentence).toContain("line 49");
    expect(p.sentence).not.toContain("line 40");
  });

  test("a sandbox refusal with no command named offers no button", () => {
    expect(present({ cause: "sandbox-refused", taskId: T }).action).toBeUndefined();
  });

  test("a spend limit says spend, and an unparseable reset time is not shown", () => {
    const p = present({ cause: "session-limit", resetsAt: "not a date", limit: "spend" }, UTC);
    expect(p.sentence).toContain("spend limit");
    expect(p.sentence).toContain("when the limit resets");
  });

  test("a failure with no known cause returns a sentence and no action rather than throwing", () => {
    const p = present({ cause: "disk-on-fire", taskId: T });
    expect(p.cause).toBe(FailureCause.Unknown);
    expect(p.sentence.length).toBeGreaterThan(0);
    expect(p.action).toBeUndefined();
  });

  test("an unknown failure quotes a plain message but not a machine one", () => {
    expect(present({ cause: "x", message: "The disk is full." }).sentence).toContain("The disk is full");
    const machine = present({ cause: "x", message: "worktree missing for task" }).sentence;
    expect(findInternalVocabulary(machine)).toEqual([]);
  });

  test("malformed input does not throw", () => {
    expect(() => present({ cause: "merge-conflict", taskId: T, files: null } as unknown as Failure)).not.toThrow();
    expect(() => present({} as Failure)).not.toThrow();
  });
});
