import { expect, test } from "bun:test";
import { mcpApprovalRequestBlockPresent, parseMcpApprovalRequest } from "../src/executors/parse-mcp-approval-request.ts";

test("parses a valid block with server, tool, args, and reason", () => {
  const raw = ["I can't send this directly.", "", "```mcp-approval-request", '{"server": "slack", "tool": "send_message", "args": {"text": "hi"}, "reason": "notify the channel"}', "```"].join(
    "\n",
  );
  expect(parseMcpApprovalRequest(raw)).toEqual({ server: "slack", tool: "send_message", args: { text: "hi" }, reason: "notify the channel" });
});

test("accepts a non-object args value — the real tool's own argument shape isn't known to this parser", () => {
  const raw = ["```mcp-approval-request", '{"server": "s", "tool": "t", "args": "a plain string", "reason": "r"}', "```"].join("\n");
  expect(parseMcpApprovalRequest(raw)).toEqual({ server: "s", tool: "t", args: "a plain string", reason: "r" });
});

test("accepts args: null — the key being present is all that's required, not a specific type", () => {
  const raw = ["```mcp-approval-request", '{"server": "s", "tool": "t", "args": null, "reason": "r"}', "```"].join("\n");
  expect(parseMcpApprovalRequest(raw)).toEqual({ server: "s", tool: "t", args: null, reason: "r" });
});

test("returns null when the block is missing entirely", () => {
  expect(parseMcpApprovalRequest("Did the work, nothing to request.")).toBeNull();
});

test("returns null on malformed JSON inside the block", () => {
  const raw = ["```mcp-approval-request", '{"server": "slack"', "```"].join("\n");
  expect(parseMcpApprovalRequest(raw)).toBeNull();
});

test("returns null when server is missing, empty, or the wrong type", () => {
  const missing = ["```mcp-approval-request", '{"tool": "t", "args": {}, "reason": "r"}', "```"].join("\n");
  const empty = ["```mcp-approval-request", '{"server": "", "tool": "t", "args": {}, "reason": "r"}', "```"].join("\n");
  const wrongType = ["```mcp-approval-request", '{"server": 5, "tool": "t", "args": {}, "reason": "r"}', "```"].join("\n");
  expect(parseMcpApprovalRequest(missing)).toBeNull();
  expect(parseMcpApprovalRequest(empty)).toBeNull();
  expect(parseMcpApprovalRequest(wrongType)).toBeNull();
});

test("returns null when tool is missing, empty, or the wrong type", () => {
  const missing = ["```mcp-approval-request", '{"server": "s", "args": {}, "reason": "r"}', "```"].join("\n");
  const empty = ["```mcp-approval-request", '{"server": "s", "tool": "", "args": {}, "reason": "r"}', "```"].join("\n");
  expect(parseMcpApprovalRequest(missing)).toBeNull();
  expect(parseMcpApprovalRequest(empty)).toBeNull();
});

test("returns null when args is absent entirely — the key itself, not just a truthy value, is required", () => {
  const raw = ["```mcp-approval-request", '{"server": "s", "tool": "t", "reason": "r"}', "```"].join("\n");
  expect(parseMcpApprovalRequest(raw)).toBeNull();
});

test("returns null when reason is missing, empty, or the wrong type", () => {
  const missing = ["```mcp-approval-request", '{"server": "s", "tool": "t", "args": {}}', "```"].join("\n");
  const empty = ["```mcp-approval-request", '{"server": "s", "tool": "t", "args": {}, "reason": ""}', "```"].join("\n");
  const wrongType = ["```mcp-approval-request", '{"server": "s", "tool": "t", "args": {}, "reason": 5}', "```"].join("\n");
  expect(parseMcpApprovalRequest(missing)).toBeNull();
  expect(parseMcpApprovalRequest(empty)).toBeNull();
  expect(parseMcpApprovalRequest(wrongType)).toBeNull();
});

test("returns null on every shape that must never resolve to a guessed request", () => {
  const malformedInputs = [
    "",
    "server: slack",
    '```mcp-approval-request\n{"server": "slack"\n```', // truncated JSON
    '```mcp-approval-request\n["slack"]\n```', // wrong shape (array, not object)
    "```mcp-approval-request\nnull\n```",
  ];
  for (const input of malformedInputs) {
    expect(parseMcpApprovalRequest(input)).toBeNull();
  }
});

test("takes the last mcp-approval-request block when more than one is present", () => {
  const raw = [
    "Example of the format:",
    "```mcp-approval-request",
    '{"server": "example", "tool": "example_tool", "args": {}, "reason": "example"}',
    "```",
    "",
    "Actual request:",
    "```mcp-approval-request",
    '{"server": "slack", "tool": "send_message", "args": {}, "reason": "real"}',
    "```",
  ].join("\n");
  expect(parseMcpApprovalRequest(raw)).toEqual({ server: "slack", tool: "send_message", args: {}, reason: "real" });
});

test("parses correctly with prose before and extra content after the block", () => {
  const raw = [
    "# Notes",
    "",
    "I looked into it but can't call this directly.",
    "",
    "```mcp-approval-request",
    '{"server": "jira", "tool": "create_ticket", "args": {"title": "x"}, "reason": "needs a human to confirm the project"}',
    "```",
    "",
    "Let me know if you'd like me to proceed.",
  ].join("\n");
  expect(parseMcpApprovalRequest(raw)).toEqual({ server: "jira", tool: "create_ticket", args: { title: "x" }, reason: "needs a human to confirm the project" });
});

// --- mcpApprovalRequestBlockPresent ---------------------------------

test("mcpApprovalRequestBlockPresent is false when there's no block at all", () => {
  expect(mcpApprovalRequestBlockPresent("Did the work, nothing to request.")).toBe(false);
});

test("mcpApprovalRequestBlockPresent is true the moment the fence appears, even with malformed content inside", () => {
  const raw = ["```mcp-approval-request", "not even json", "```"].join("\n");
  expect(mcpApprovalRequestBlockPresent(raw)).toBe(true);
  expect(parseMcpApprovalRequest(raw)).toBeNull();
});

test("mcpApprovalRequestBlockPresent is true for a valid block too", () => {
  const raw = ["```mcp-approval-request", '{"server": "s", "tool": "t", "args": {}, "reason": "r"}', "```"].join("\n");
  expect(mcpApprovalRequestBlockPresent(raw)).toBe(true);
});

test("mcpApprovalRequestBlockPresent is stateless across repeated calls — no shared global-regex lastIndex bug", () => {
  const raw = ["```mcp-approval-request", '{"server": "s", "tool": "t", "args": {}, "reason": "r"}', "```"].join("\n");
  expect(mcpApprovalRequestBlockPresent(raw)).toBe(true);
  expect(mcpApprovalRequestBlockPresent(raw)).toBe(true);
  expect(mcpApprovalRequestBlockPresent(raw)).toBe(true);
});
