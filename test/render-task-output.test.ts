import { expect, test } from "bun:test";
import { renderTaskOutputRows } from "../src/api/public/render-task-output.js";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

test("renders accumulated text_delta chunks as one text row once the block stops", () => {
  const lines = [
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "p" } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ong" } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
  ];
  expect(renderTaskOutputRows(lines)).toEqual([{ kind: "text", text: "pong" }]);
});

test("renders thinking deltas as a distinct kind from text deltas", () => {
  const lines = [
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
  ];
  expect(renderTaskOutputRows(lines)).toEqual([{ kind: "thinking", text: "hmm" }]);
});

test("assembles a tool_use block's delta-streamed input_json_delta chunks and picks the most identifying field", () => {
  const lines = [
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "1", name: "Bash", input: {} } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"ls -la"}' } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
  ];
  expect(renderTaskOutputRows(lines)).toEqual([{ kind: "tool-use", text: "→ Bash: ls -la" }]);
});

test("picks file_path for Edit/Read-shaped tools when there's no command field", () => {
  const lines = [
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "1", name: "Read", input: {} } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"src/a.ts"}' } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
  ];
  expect(renderTaskOutputRows(lines)).toEqual([{ kind: "tool-use", text: "→ Read: src/a.ts" }]);
});

test("renders a tool_result carried in a top-level type:user message as a ✓ or ✗ preview based on is_error", () => {
  // Real shape (never nested in a stream_event) — see
  // code.claude.com/docs/en/agent-sdk/streaming-output's "Message flow"
  // and code.claude.com/docs/en/headless's "Follow subagent messages":
  // a tool_result arrives as a content block inside a top-level
  // `type: "user"` line's `message.content` array.
  const ok = [line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "file written", is_error: false }] } })];
  expect(renderTaskOutputRows(ok)).toEqual([{ kind: "tool-result", ok: true, text: "✓ file written" }]);

  const fail = [line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "permission denied", is_error: true }] } })];
  expect(renderTaskOutputRows(fail)).toEqual([{ kind: "tool-result", ok: false, text: "✗ permission denied" }]);
});

test("flattens an array-shaped tool_result content block into one preview string", () => {
  const lines = [
    line({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "line one" }, "line two"], is_error: false }] },
    }),
  ];
  expect(renderTaskOutputRows(lines)).toEqual([{ kind: "tool-result", ok: true, text: "✓ line one line two" }]);
});

test("renders multiple tool_result blocks in a single type:user message as separate rows, in order", () => {
  const lines = [
    line({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "first", is_error: false },
          { type: "tool_result", tool_use_id: "2", content: "second", is_error: true },
        ],
      },
    }),
  ];
  expect(renderTaskOutputRows(lines)).toEqual([
    { kind: "tool-result", ok: true, text: "✓ first" },
    { kind: "tool-result", ok: false, text: "✗ second" },
  ]);
});

test("a complete type:assistant message produces no row — it duplicates content already rendered from this turn's stream_event deltas", () => {
  const lines = [
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
  ];
  expect(renderTaskOutputRows(lines)).toEqual([{ kind: "text", text: "hi" }]);
});

test("renders the terminal result line as a result row, including cost and permission denials", () => {
  const lines = [line({ type: "result", subtype: "success", is_error: false, result: "pong", total_cost_usd: 0.1088 })];
  expect(renderTaskOutputRows(lines)).toEqual([{ kind: "result", ok: true, text: "✔ pong — $0.1088" }]);

  const denied = [
    line({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.02, permission_denials: [{}, {}] }),
  ];
  expect(renderTaskOutputRows(denied)).toEqual([{ kind: "result", ok: true, text: "✔ done — $0.0200 [2 permission denial(s)]" }]);

  const errored = [line({ type: "result", subtype: "error", is_error: true, result: "boom" })];
  expect(renderTaskOutputRows(errored)).toEqual([{ kind: "result", ok: false, text: "✗ boom" }]);
});

test("full realistic sequence: text streaming, a tool call, its complete assistant echo, its result, then the final result line — in order", () => {
  const lines = [
    line({ type: "system", subtype: "init" }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "1", name: "Bash", input: {} } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
    // The complete assistant message for this same turn — real CLI output
    // emits this alongside the stream_event deltas above; it must not
    // produce duplicate rows (see the dedicated test above).
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } }] } }),
    // tool_result comes back as a top-level type:user line, not nested in
    // a stream_event — see the file header comment and §9's revision callout.
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "a.ts b.ts", is_error: false }] } }),
    line({ type: "result", subtype: "success", is_error: false, result: "done" }),
  ];
  expect(renderTaskOutputRows(lines)).toEqual([
    { kind: "text", text: "Let me check." },
    { kind: "tool-use", text: "→ Bash: ls" },
    { kind: "tool-result", ok: true, text: "✓ a.ts b.ts" },
    { kind: "result", ok: true, text: "✔ done" },
  ]);
});

test("codex shapes: agent_message text, a non-failed item as a generic tool-use row, a failed item, turn.completed/turn.failed", () => {
  expect(renderTaskOutputRows([line({ type: "item.completed", item: { id: "i", type: "agent_message", text: "hi" } })])).toEqual([{ kind: "text", text: "hi" }]);

  expect(renderTaskOutputRows([line({ type: "item.completed", item: { id: "i", type: "command_execution", status: "completed" } })])).toEqual([
    { kind: "tool-use", text: "→ command_execution" },
  ]);

  expect(renderTaskOutputRows([line({ type: "item.completed", item: { id: "i", type: "file_change", status: "failed" } })])).toEqual([
    { kind: "tool-result", ok: false, text: "✗ file_change failed" },
  ]);

  expect(renderTaskOutputRows([line({ type: "turn.completed" })])).toEqual([{ kind: "result", ok: true, text: "✔ turn completed" }]);

  expect(renderTaskOutputRows([line({ type: "turn.failed", error: { message: "404 not found" } })])).toEqual([
    { kind: "result", ok: false, text: "✗ 404 not found" },
  ]);
});

test("an unrecognized line type falls back to a compact raw row instead of vanishing silently", () => {
  expect(renderTaskOutputRows([line({ type: "some_future_event_type" })])).toEqual([{ kind: "raw", text: "· some_future_event_type" }]);
});

test("system/init lines produce no row at all — deliberately excluded noise, one per run", () => {
  expect(renderTaskOutputRows([line({ type: "system", subtype: "init", cwd: "/tmp" })])).toEqual([]);
});

test("tolerates an unparseable/garbled line without throwing or breaking the rest of the render", () => {
  const lines = [line({ type: "result", subtype: "success", is_error: false, result: "before" }), "not json at all", line({ type: "turn.completed" })];
  expect(renderTaskOutputRows(lines)).toEqual([
    { kind: "result", ok: true, text: "✔ before" },
    { kind: "result", ok: true, text: "✔ turn completed" },
  ]);
});

test("handles an empty input array", () => {
  expect(renderTaskOutputRows([])).toEqual([]);
});

test("also accepts already-parsed objects, not just raw JSON strings — a defensive convenience, not a required input shape", () => {
  expect(renderTaskOutputRows([{ type: "turn.completed" }])).toEqual([{ kind: "result", ok: true, text: "✔ turn completed" }]);
});
