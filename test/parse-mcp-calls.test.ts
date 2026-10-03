import { expect, test } from "bun:test";
import { parseMcpCalls } from "../src/executors/parse-mcp-calls.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import { resolveMcpGrants } from "../src/executors/mcp-config.ts";
import type { McpServer } from "../src/core/types.ts";

function server(overrides: Partial<McpServer> & Pick<McpServer, "id">): McpServer {
  return {
    label: overrides.id,
    transport: { kind: "stdio", command: "/bin/true", args: [] },
    tools: [],
    enabled: true,
    ...overrides,
  };
}

const pool = McpServerPool.from([server({ id: "slack" }), server({ id: "jira" })]);
const grants = resolveMcpGrants(
  [
    { server: "slack", tools: ["send_message"] },
    { server: "jira", tools: ["get_issue"] },
  ],
  pool,
);

// Fixture built against the officially-documented shapes researched this
// session (not an invented one — see parse-mcp-calls.ts's own doc comment
// for the exact doc citations). IMPORTANT: this is corroborated via docs,
// not observed — no live round-trip against a real attached MCP server was
// run (sandbox blocked the subprocess spawn). The generic envelope below is
// well corroborated (render-task-output.js already depends on it in
// production); the genuinely MCP-specific piece — whether a granted MCP
// tool really surfaces as a tool_use block named mcp__<server>__<tool> in
// practice — has not been seen fire for real. See docs/SDD-mcp-
// orchestration.md's "Revision (subtask 2, shipped)" callout for the full
// caveat and the open empirical item this leaves for subtask 7.
//   - a tool_use block ({type,id,name,input}) inside a top-level
//     type:"assistant" message's message.content array — confirmed via
//     code.claude.com/docs/en/agent-sdk/streaming-output's "Message
//     flow" (a complete AssistantMessage is emitted per content block
//     even with partial messages enabled).
//   - a tool_result block ({type,tool_use_id,content,is_error}) inside a
//     top-level type:"user" message's message.content array, correlated
//     by tool_use_id == the tool_use block's own id — confirmed via
//     platform.claude.com/docs/en/agents-and-tools/tool-use/overview's
//     full request/response round trip, and already load-bearing
//     elsewhere in this codebase (render-task-output.js).
//   - mcp__<server>__<tool> naming — documented via
//     code.claude.com/docs/en/mcp, but not observed live.
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

test("parses a single granted MCP tool call into {server, tool, args, result, ok: true}", () => {
  const stdout = [
    line({ type: "system", subtype: "init" }),
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_01", name: "mcp__slack__send_message", input: { channel: "#general", text: "hi" } }] },
    }),
    line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok: sent", is_error: false }] },
    }),
    line({ type: "result", subtype: "success", is_error: false, result: "done" }),
  ].join("\n");

  expect(parseMcpCalls(stdout, grants)).toEqual([
    { server: "slack", tool: "send_message", args: { channel: "#general", text: "hi" }, result: "ok: sent", ok: true },
  ]);
});

test("ok: false when the tool_result carries is_error: true", () => {
  const stdout = [
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_01", name: "mcp__jira__get_issue", input: { id: "FOO-1" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "not found", is_error: true }] } }),
  ].join("\n");

  expect(parseMcpCalls(stdout, grants)).toEqual([{ server: "jira", tool: "get_issue", args: { id: "FOO-1" }, result: "not found", ok: false }]);
});

test("captures multiple granted calls across servers, in order, each correlated by its own tool_use_id", () => {
  const stdout = [
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__slack__send_message", input: { text: "a" } }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__jira__get_issue", input: { id: "X-1" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "sent", is_error: false }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "found", is_error: false }] } }),
  ].join("\n");

  expect(parseMcpCalls(stdout, grants)).toEqual([
    { server: "slack", tool: "send_message", args: { text: "a" }, result: "sent", ok: true },
    { server: "jira", tool: "get_issue", args: { id: "X-1" }, result: "found", ok: true },
  ]);
});

test("ignores a tool_use for a tool this run wasn't granted — e.g. a plain Read/Bash call", () => {
  const stdout = [
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt", is_error: false }] } }),
  ].join("\n");

  expect(parseMcpCalls(stdout, grants)).toBeUndefined();
});

test("ignores an MCP tool_use whose server/tool wasn't actually granted, even if it matches the mcp__ naming shape", () => {
  const stdout = [
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__slack__delete_channel", input: {} }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "deleted", is_error: false }] } }),
  ].join("\n");

  expect(parseMcpCalls(stdout, grants)).toBeUndefined();
});

test("returns undefined for zero grants, regardless of what the stream contains", () => {
  const stdout = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__slack__send_message", input: {} }] } });
  expect(parseMcpCalls(stdout, [])).toBeUndefined();
});

test("returns undefined when grants exist but no matching call ever appears in the stream", () => {
  const stdout = line({ type: "result", subtype: "success", is_error: false, result: "done, no tools used" });
  expect(parseMcpCalls(stdout, grants)).toBeUndefined();
});

test("a tool_use with no matching tool_result yet (call started but never completed) is simply dropped, not half-reported", () => {
  const stdout = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__slack__send_message", input: {} }] } });
  expect(parseMcpCalls(stdout, grants)).toBeUndefined();
});

test("tolerates a blank/unparseable line in the stream without losing the real calls around it", () => {
  const stdout = [
    "",
    "not json at all",
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__slack__send_message", input: { text: "hi" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "sent", is_error: false }] } }),
  ].join("\n");

  expect(parseMcpCalls(stdout, grants)).toEqual([{ server: "slack", tool: "send_message", args: { text: "hi" }, result: "sent", ok: true }]);
});

test("a message with multiple content blocks captures only the matching tool_use entries, same assistant/user line", () => {
  const stdout = [
    line({
      type: "assistant",
      message: { content: [{ type: "text", text: "Let me check that." }, { type: "tool_use", id: "t1", name: "mcp__jira__get_issue", input: { id: "X-9" } }] },
    }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "found", is_error: false }] } }),
  ].join("\n");

  expect(parseMcpCalls(stdout, grants)).toEqual([{ server: "jira", tool: "get_issue", args: { id: "X-9" }, result: "found", ok: true }]);
});
