import { expect, test } from "bun:test";
import { judge } from "../eval/resume.eval.ts";
import type { TaskResult } from "../src/core/types.ts";

// eval:resume's judge, checked for free: it passes the real shape and
// fails each way resume could go wrong.

const r = (over: Partial<TaskResult>): TaskResult => ({ taskId: "t", agentId: "a", ok: true, summary: "HERON-42", sessionId: "s1", ...over });
const passes = (fresh: TaskResult, resumed: TaskResult, fallback: TaskResult) => judge(fresh, resumed, fallback).map((s) => s.pass);

test("passes a fresh run, a resumed run of the same session, and a fresh fallback", () => {
  expect(passes(r({}), r({ resumed: true }), r({ sessionId: "s2" }))).toEqual([true, true, true]);
});

test("fails each way resume can go wrong", () => {
  expect(passes(r({ sessionId: undefined }), r({ resumed: true }), r({}))[0]).toBe(false); // no session to resume
  expect(passes(r({}), r({}), r({}))[1]).toBe(false); // not actually resumed
  expect(passes(r({}), r({ resumed: true, sessionId: "other" }), r({}))[1]).toBe(false); // a different conversation
  expect(passes(r({}), r({ resumed: true, summary: "OK" }), r({}))[1]).toBe(false); // lost the context
  expect(passes(r({}), r({ resumed: true }), r({ resumed: true }))[2]).toBe(false); // fallback claims a resume
  expect(passes(r({}), r({ resumed: true }), r({ ok: false }))[2]).toBe(false); // fallback failed
});
