import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRemoteControlResponse,
  remoteControlSessionName,
  remoteControlStdin,
  REMOTE_CONTROL_REQUEST_ID,
  runClaude,
  type CommandRunner,
} from "../src/executors/claude-cli.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "triager",
  name: "Triager",
  kind: "agent",
  tier: "readonly",
  description: "d",
  whenToUse: "w",
  tags: ["triage"],
  executor: "readonly",
  inputs: [],
  outputs: [],
  trustLevel: "medium",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.1 },
};

const task: TaskCard = { id: "t1", title: "Sort the inbox", body: "Do it.", labels: ["triage"], repo: "/tmp", status: "ready" };

const SESSION_URL = "https://claude.ai/code/session_01ABC";

/** The control_response line claude 2.1.296 printed live for this request. */
function successLine(url = SESSION_URL): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: REMOTE_CONTROL_REQUEST_ID,
      response: { session_url: url, connect_url: "https://claude.ai/code?environment=", environment_id: "", bridge_epoch: 1, bridge_session_id: "cse_01ABC" },
    },
  });
}

const resultLine = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-1" });

interface Call {
  cmd: string[];
  stdin?: string;
}

function recording(stdout: string, exitCode = 0): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (cmd, opts) => {
      calls.push({ cmd, stdin: opts.stdin });
      return { stdout, stderr: "", exitCode };
    },
  };
}

test("remoteControlStdin sends the remote_control request first, then the prompt as one user message", () => {
  const lines = remoteControlStdin("line one\nline two", "wissel: x").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!)).toEqual({
    type: "control_request",
    request_id: REMOTE_CONTROL_REQUEST_ID,
    request: { subtype: "remote_control", enabled: true, name: "wissel: x" },
  });
  expect(JSON.parse(lines[1]!)).toEqual({ type: "user", message: { role: "user", content: "line one\nline two" } });
});

test("remoteControlSessionName prefixes wissel and caps long titles at 80 characters", () => {
  expect(remoteControlSessionName({ title: "Fix the board" })).toBe("wissel: Fix the board");
  const long = remoteControlSessionName({ title: "x".repeat(200) });
  expect(long.length).toBe(80);
  expect(long.endsWith("…")).toBe(true);
});

test("parseRemoteControlResponse finds the session URL among other stream lines", () => {
  const stdout = [JSON.stringify({ type: "system", subtype: "bridge_state", state: "ready" }), successLine(), resultLine].join("\n");
  expect(parseRemoteControlResponse(stdout)).toEqual({ sessionUrl: SESSION_URL });
});

test("parseRemoteControlResponse reports a refusal and ignores other requests' answers", () => {
  const refused = JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: REMOTE_CONTROL_REQUEST_ID, error: "Remote Control is disabled by your organization" } });
  const other = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "something-else", response: { session_url: "https://claude.ai/code/other" } } });
  expect(parseRemoteControlResponse([other, refused].join("\n"))).toEqual({ error: "Remote Control is disabled by your organization" });
  expect(parseRemoteControlResponse([other, resultLine].join("\n"))).toBeUndefined();
  expect(parseRemoteControlResponse(`${REMOTE_CONTROL_REQUEST_ID} not json`)).toBeUndefined();
});

test("with remoteControl on, runClaude uses stream-json in and out and pipes the request plus prompt", async () => {
  const { runner, calls } = recording([successLine(), resultLine].join("\n"));
  const result = await runClaude({ runner, task, agent, permissionMode: "plan", remoteControl: true });

  const cmd = calls[0]!.cmd;
  expect(cmd.slice(0, 4)).toEqual(["claude", "-p", "--output-format", "stream-json"]);
  expect(cmd.join(" ")).toContain("--input-format stream-json");
  expect(cmd).toContain("--verbose");
  const [control, user] = calls[0]!.stdin!.trimEnd().split("\n").map((l) => JSON.parse(l));
  expect(control.request).toEqual({ subtype: "remote_control", enabled: true, name: "wissel: Sort the inbox" });
  expect(user.message.content).toContain("Sort the inbox");

  expect(result.ok).toBe(true);
  expect(result.summary).toBe("done");
  expect(result.remoteSessionUrl).toBe(SESSION_URL);
});

test("with remoteControl off, the command line and stdin are unchanged (plain prompt, json output)", async () => {
  const { runner, calls } = recording(resultLine);
  const result = await runClaude({ runner, task, agent, permissionMode: "plan" });
  expect(calls[0]!.cmd).toEqual(["claude", "-p", "--output-format", "json", "--permission-mode", "plan"]);
  expect(calls[0]!.stdin!.startsWith("{")).toBe(false);
  expect(result.remoteSessionUrl).toBeUndefined();
});

test("a refused remote_control request never fails the run", async () => {
  const refused = JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: REMOTE_CONTROL_REQUEST_ID, error: "not allowed" } });
  const { runner } = recording([refused, resultLine].join("\n"));
  const result = await runClaude({ runner, task, agent, permissionMode: "plan", remoteControl: true });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("done");
  expect(result.remoteSessionUrl).toBeUndefined();
});

test("a 429 with Remote Control on still schedules the retry and keeps the session URL", async () => {
  const limited = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    api_error_status: 429,
    result: "You've hit your session limit · resets 11pm (UTC)",
    session_id: "s-429",
  });
  const { runner } = recording([successLine(), limited].join("\n"), 1);
  const result = await runClaude({ runner, task, agent, permissionMode: "plan", remoteControl: true });
  expect(result.ok).toBe(false);
  expect(result.remoteSessionUrl).toBe(SESSION_URL);
  expect(result.sessionId).toBe("s-429");
});

test("a resumed run with Remote Control on sends --resume and the resume prompt as the user message", async () => {
  const { runner, calls } = recording([successLine(), resultLine].join("\n"));
  await runClaude({ runner, task: { ...task, resumeSessionId: "s-old" }, agent, permissionMode: "plan", remoteControl: true });
  const cmd = calls[0]!.cmd;
  expect(cmd[cmd.indexOf("--resume") + 1]).toBe("s-old");
  const user = JSON.parse(calls[0]!.stdin!.trimEnd().split("\n")[1]!);
  expect(user.message.content).toContain("stopped partway through this task by a usage limit");
});

test("ReadOnlyExecutor and WriteExecutor pass remoteControl through to the run", async () => {
  const ro = recording([successLine(), resultLine].join("\n"));
  const roResult = await new ReadOnlyExecutor({ runner: ro.runner, remoteControl: true }).run(task, agent);
  expect(ro.calls[0]!.cmd).toContain("--input-format");
  expect(roResult.remoteSessionUrl).toBe(SESSION_URL);

  const roOff = recording(resultLine);
  await new ReadOnlyExecutor({ runner: roOff.runner }).run(task, agent);
  expect(roOff.calls[0]!.cmd).not.toContain("--input-format");

  // WriteExecutor creates a worktree with git first; answer those calls
  // with success and only look at the claude call.
  const calls: Call[] = [];
  const writeRunner: CommandRunner = async (cmd, opts) => {
    calls.push({ cmd, stdin: opts.stdin });
    if (cmd[0] === "claude") return { stdout: [successLine(), resultLine].join("\n"), stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const writeAgent: AgentDef = { ...agent, id: "implementer", tier: "write", executor: "write", toolAccess: ["read", "write"] };
  const home = await mkdtemp(join(tmpdir(), "wissel-rc-test-"));
  const wResult = await new WriteExecutor({ runner: writeRunner, remoteControl: true, homeDir: home })
    .run(task, writeAgent)
    .finally(() => rm(home, { recursive: true, force: true }));
  const claudeCall = calls.find((c) => c.cmd[0] === "claude");
  expect(claudeCall?.cmd).toContain("--input-format");
  expect(wResult.remoteSessionUrl).toBe(SESSION_URL);
});
