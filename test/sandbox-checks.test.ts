import { expect, test } from "bun:test";
import { bashCalls, findCall, isPermissionRefusal } from "../eval/sandbox-checks.ts";

// eval/sandbox-checks.ts: transcript parsing for the sandbox live check
// and eval. Shapes as claude's stream-json prints them.

const use = (id: string, command: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id: string, content: unknown, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });

test("bashCalls pairs each Bash tool_use with its tool_result, string or block content", () => {
  const lines = [
    { type: "system" },
    use("a", "grep -rn x . | head"),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/x" } }] } },
    result("r", "file text"),
    result("a", [{ type: "text", text: "./src/x.ts:1:x" }]),
    use("b", "touch ~/probe"),
    result("b", "touch: cannot touch '/home/u/probe': Read-only file system", true),
    use("c", "never answered"),
  ];
  expect(bashCalls(lines)).toEqual([
    { command: "grep -rn x . | head", output: "./src/x.ts:1:x", isError: false },
    { command: "touch ~/probe", output: "touch: cannot touch '/home/u/probe': Read-only file system", isError: true },
  ]);
});

test("isPermissionRefusal tells a refusal from a command's own failure", () => {
  const calls = bashCalls([
    use("a", "bun -e 1"),
    result("a", "Claude requested permissions to use Bash, but you haven't granted it yet.", true),
    use("b", "touch ~/x"),
    result("b", "Read-only file system", true),
  ]);
  expect(isPermissionRefusal(findCall(calls, "bun -e")!)).toBe(true);
  expect(isPermissionRefusal(findCall(calls, "touch")!)).toBe(false);
  expect(findCall(calls, "nope")).toBeUndefined();
});
