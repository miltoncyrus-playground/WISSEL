import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Provisioner } from "../src/services/provisioner.ts";

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-provisioner-"));
}

test("provision writes mcpServers into a fresh settings.local.json", async () => {
  const cwd = await tempCwd();
  await new Provisioner().provision({ cwd, originRepo: cwd, mcpServers: { foo: { command: "foo" } } });

  const raw = await readFile(join(cwd, ".claude", "settings.local.json"), "utf8");
  const settings = JSON.parse(raw);
  expect(settings.mcpServers).toEqual({ foo: { command: "foo" } });

  await rm(cwd, { recursive: true, force: true });
});

test("provision merges mcpServers without clobbering unrelated keys", async () => {
  const cwd = await tempCwd();
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, mcpServers: { existing: { command: "keep-me" } } }),
  );

  await new Provisioner().provision({ cwd, originRepo: cwd, mcpServers: { foo: { command: "foo" } } });

  const settings = JSON.parse(await readFile(join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
  expect(settings.mcpServers).toEqual({ existing: { command: "keep-me" }, foo: { command: "foo" } });

  await rm(cwd, { recursive: true, force: true });
});

test("provision refuses to touch a malformed settings file when not owned", async () => {
  const cwd = await tempCwd();
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.local.json"), "{ not json");

  await expect(new Provisioner().provision({ cwd, originRepo: cwd, owned: false })).rejects.toThrow("refusing to merge");

  const raw = await readFile(join(cwd, ".claude", "settings.local.json"), "utf8");
  expect(raw).toBe("{ not json");

  await rm(cwd, { recursive: true, force: true });
});

test("provision self-heals a malformed settings file when owned", async () => {
  const cwd = await tempCwd();
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.local.json"), "{ not json");

  await new Provisioner().provision({ cwd, originRepo: cwd, owned: true, mcpServers: { foo: {} } });

  const settings = JSON.parse(await readFile(join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(settings.mcpServers).toEqual({ foo: {} });

  await rm(cwd, { recursive: true, force: true });
});

test("provision throws when cwd does not exist", async () => {
  await expect(new Provisioner().provision({ cwd: "/nonexistent/wissel-test-path", originRepo: "x" })).rejects.toThrow(
    "does not exist",
  );
});

test("write is atomic: no leftover tempfile after a successful provision", async () => {
  const cwd = await tempCwd();
  await new Provisioner().provision({ cwd, originRepo: cwd, mcpServers: { foo: {} } });

  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(cwd, ".claude"));
  expect(files).toEqual(["settings.local.json"]);

  await rm(cwd, { recursive: true, force: true });
});
