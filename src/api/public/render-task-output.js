// Turns a task's raw JSONL output (claude's `--output-format stream-json`
// lines, or codex's native JSONL — see docs/SDD-live-task-output.md §3.5)
// into a flat array of render-ready rows. A pure function: no DOM, no
// global state, no side effects — takes the full array of raw lines seen
// so far and returns the full array of rows to display, recomputed from
// scratch every call. Plain, dependency-free browser JS (matches this
// file's own house style, see board.html) that's also directly
// `import`-able from bun test via the `module.exports` guard at the
// bottom — no build step either way.
//
// Each row is `{ kind, text, ok? }`:
//   - "thinking" / "text": accumulated streamed text for one content block,
//     assembled from `stream_event`/`content_block_delta` lines.
//   - "tool-use": "→ Bash: ls -la" — tool name plus its most identifying
//     input field, once the block's (possibly delta-streamed) input JSON
//     is fully assembled (also from `stream_event` lines).
//   - "tool-result": "✓ ..." / "✗ ..." — ok reflects `is_error`. A
//     tool_result is NEVER nested inside a stream_event content block —
//     per Anthropic's own streaming docs (code.claude.com/docs/en/agent-sdk/streaming-output's
//     "Message flow", code.claude.com/docs/en/headless's "Follow subagent
//     messages"), it arrives as a content block inside a separate
//     top-level `type: "user"` line's `message.content` array. See
//     docs/SDD-live-task-output.md §9's revision callout — an earlier
//     version of this file and of §3.5 wrongly stated tool_result as a
//     `content_block_start` shape, which never occurs against real CLI
//     output.
//   - a complete top-level `type: "assistant"` line is intentionally
//     rendered as no row at all: it duplicates the same turn's content
//     already rendered incrementally from `stream_event` deltas (also
//     per §9's revision callout) — rendering it too would double every
//     text/tool-use row.
//   - "result": the terminal `type: "result"` line — the signal the run
//     is over.
//   - "raw": a compact fallback ("· <type>") for anything unrecognized,
//     so nothing an agent emits is ever silently dropped.

function renderTaskOutputRows(rawLines) {
  var blocks = {};
  var rows = [];

  (rawLines || []).forEach(function (raw) {
    var line;
    try {
      line = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      return; // an unparseable/partial line is tolerated, never breaks rendering
    }
    if (!line || typeof line !== "object") return;
    handleLine(line, blocks, rows);
  });

  return rows;
}

function handleLine(line, blocks, rows) {
  if (line.type === "stream_event" && line.event) {
    handleStreamEvent(line.event, blocks, rows);
    return;
  }

  // Complete assistant message for a turn already covered by this same
  // turn's stream_event deltas above — see the file header comment and
  // docs/SDD-live-task-output.md §9's revision callout. No row.
  if (line.type === "assistant") {
    return;
  }

  // Real shape for a tool_result: a top-level `type: "user"` line whose
  // `message.content` array carries one or more tool_result blocks (see
  // file header comment). Never nested in a stream_event.
  if (line.type === "user" && line.message && Array.isArray(line.message.content)) {
    line.message.content.forEach(function (block) {
      if (block && block.type === "tool_result") {
        rows.push({ kind: "tool-result", ok: !block.is_error, text: (block.is_error ? "✗ " : "✓ ") + truncate(toolResultPreview(block.content)) });
      }
    });
    return;
  }

  if (line.type === "result") {
    var costPart = typeof line.total_cost_usd === "number" ? " — $" + line.total_cost_usd.toFixed(4) : "";
    var deniedPart = line.permission_denials && line.permission_denials.length ? " [" + line.permission_denials.length + " permission denial(s)]" : "";
    rows.push({ kind: "result", ok: !line.is_error, text: (line.is_error ? "✗ " : "✔ ") + (line.result || "(no result)") + costPart + deniedPart });
    return;
  }

  // codex's native JSONL shapes (see src/executors/codex-cli.ts's own
  // CodexEvent interface) — same store, same modal, see
  // docs/SDD-live-task-output.md §3.7.
  if (line.type === "item.completed" && line.item) {
    var item = line.item;
    if (item.type === "agent_message") {
      rows.push({ kind: "text", text: item.text || "" });
    } else if (item.status === "failed") {
      rows.push({ kind: "tool-result", ok: false, text: "✗ " + (item.type || "item") + " failed" });
    } else {
      rows.push({ kind: "tool-use", text: "→ " + item.type });
    }
    return;
  }

  if (line.type === "turn.completed") {
    rows.push({ kind: "result", ok: true, text: "✔ turn completed" });
    return;
  }

  if (line.type === "turn.failed") {
    rows.push({ kind: "result", ok: false, text: "✗ " + (line.error && line.error.message ? line.error.message : "turn failed") });
    return;
  }

  // "system"/"init" (one per run, not interesting to a human watching
  // output) is deliberately excluded from the fallback below — everything
  // else unrecognized still gets a compact marker row rather than
  // silently vanishing.
  if (line.type && line.type !== "system") {
    rows.push({ kind: "raw", text: "· " + line.type });
  }
}

function handleStreamEvent(event, blocks, rows) {
  if (event.type === "content_block_start" && event.content_block) {
    var cb = event.content_block;
    var idx = event.index;
    if (cb.type === "tool_use") {
      blocks[idx] = { kind: "tool_use", name: cb.name, json: "" };
    } else if (cb.type === "thinking") {
      blocks[idx] = { kind: "thinking", text: cb.thinking || "" };
    } else if (cb.type === "text") {
      blocks[idx] = { kind: "text", text: cb.text || "" };
    }
    // Deliberately no tool_result branch here — a tool_result is never a
    // stream_event content block against real CLI output; see the file
    // header comment and the "user" line handling in handleLine.
    return;
  }

  if (event.type === "content_block_delta" && event.delta) {
    var block = blocks[event.index];
    if (!block) return;
    if (event.delta.type === "text_delta") block.text = (block.text || "") + event.delta.text;
    else if (event.delta.type === "thinking_delta") block.text = (block.text || "") + event.delta.thinking;
    else if (event.delta.type === "input_json_delta") block.json = (block.json || "") + event.delta.partial_json;
    return;
  }

  if (event.type === "content_block_stop") {
    var idx2 = event.index;
    var finished = blocks[idx2];
    if (!finished) return;
    if ((finished.kind === "text" || finished.kind === "thinking") && finished.text) {
      rows.push({ kind: finished.kind, text: finished.text });
    } else if (finished.kind === "tool_use") {
      var input = {};
      try {
        input = finished.json ? JSON.parse(finished.json) : {};
      } catch (e) {
        // partial/malformed accumulated JSON — render with an empty
        // input rather than dropping the tool-use row entirely.
      }
      rows.push({ kind: "tool-use", text: describeToolUse(finished.name, input) });
    }
    delete blocks[idx2];
  }
}

function describeToolUse(name, input) {
  input = input || {};
  var preferredFields = ["command", "file_path", "path", "pattern", "url", "prompt", "query", "description"];
  var field = preferredFields.filter(function (k) {
    return input[k] !== undefined;
  })[0];
  var detail = field ? String(input[field]) : Object.keys(input).length ? JSON.stringify(input) : "";
  if (detail) detail = truncate(detail, 160);
  return "→ " + (name || "tool") + (detail ? ": " + detail : "");
}

function toolResultPreview(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(function (c) {
        return typeof c === "string" ? c : (c && c.text) || JSON.stringify(c);
      })
      .join(" ");
  }
  return JSON.stringify(content);
}

function truncate(text, max) {
  max = max || 200;
  if (typeof text !== "string") text = JSON.stringify(text);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderTaskOutputRows: renderTaskOutputRows };
}
