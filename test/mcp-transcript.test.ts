import { expect, test } from "bun:test";
import { formatMcpTranscript } from "../src/services/mcp-transcript.ts";

test("formats a single call with server, tool, ok/failed, args, and result", () => {
  const text = formatMcpTranscript([{ server: "slack", tool: "send_message", args: { channel: "#general", text: "hi" }, result: "ok: sent", ok: true }]);
  expect(text).toBe('1. slack.send_message — ok\n   args: {"channel":"#general","text":"hi"}\n   result: "ok: sent"');
});

test("marks a failed call distinctly from an ok one", () => {
  const text = formatMcpTranscript([{ server: "jira", tool: "get_issue", args: { id: "X-1" }, result: "not found", ok: false }]);
  expect(text).toContain("jira.get_issue — failed");
});

test("formats multiple calls in call order, numbered", () => {
  const text = formatMcpTranscript([
    { server: "slack", tool: "send_message", args: { text: "a" }, result: "sent", ok: true },
    { server: "jira", tool: "get_issue", args: { id: "X-1" }, result: "found", ok: true },
  ]);
  const lines = text.split("\n");
  expect(lines[0]).toBe("1. slack.send_message — ok");
  expect(lines.some((l) => l === "2. jira.get_issue — ok")).toBe(true);
});

test("an empty array produces an explicit 'no calls' message rather than empty text", () => {
  expect(formatMcpTranscript([])).toBe("(no MCP tool calls were made)");
});
