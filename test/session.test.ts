import { expect, test } from "bun:test";
import { TmuxSupervisor } from "../src/services/session.ts";

test("spawn starts a real tmux session; healthy() reports it alive", async () => {
  const supervisor = new TmuxSupervisor();
  const handle = await supervisor.spawn("/tmp", ["sleep", "30"], {});

  expect(handle.kind).toBe("tmux");
  expect(handle.id).toMatch(/^wissel-/);
  expect(await supervisor.healthy(handle)).toBe(true);

  await supervisor.kill(handle);
});

test("kill stops the session; healthy() then reports it gone", async () => {
  const supervisor = new TmuxSupervisor();
  const handle = await supervisor.spawn("/tmp", ["sleep", "30"], {});

  await supervisor.kill(handle);

  expect(await supervisor.healthy(handle)).toBe(false);
});

test("kill on an already-dead session is a silent no-op", async () => {
  const supervisor = new TmuxSupervisor();
  const handle = await supervisor.spawn("/tmp", ["sleep", "1"], {});
  await supervisor.kill(handle);

  await expect(supervisor.kill(handle)).resolves.toBeUndefined();
});

test("healthy() on a session that never existed is false", async () => {
  const supervisor = new TmuxSupervisor();
  expect(await supervisor.healthy({ id: "wissel-does-not-exist", kind: "tmux", cwd: "/tmp" })).toBe(false);
});

test("env vars are passed through to the spawned session", async () => {
  const supervisor = new TmuxSupervisor();
  const marker = `/tmp/wissel-session-test-${Date.now()}`;
  const handle = await supervisor.spawn("/tmp", ["sh", "-c", `echo "$WISSEL_TEST_VAR" > ${marker}`], {
    WISSEL_TEST_VAR: "hello-from-env",
  });

  // The command runs and exits almost immediately; give tmux a beat to flush it.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const file = Bun.file(marker);
  expect((await file.text()).trim()).toBe("hello-from-env");
  await file.delete().catch(() => {});
  await supervisor.kill(handle);
});
