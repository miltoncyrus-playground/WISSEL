import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeVersionInfo, getVersionInfo } from "../src/core/version.ts";

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

test("getVersionInfo memoizes — same reference on repeat calls", () => {
  const a = getVersionInfo();
  const b = getVersionInfo();
  expect(a).toBe(b);
});

test("computeVersionInfo resolves real git identity for this repo", () => {
  const info = computeVersionInfo(process.cwd());
  expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(info.commitShort).toBe(info.commit.slice(0, 7));
  expect(info.packageVersion).toBe("0.0.0");
});

test("computeVersionInfo falls back to unknown fields outside any git repo, without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-version-test-"));
  try {
    const info = computeVersionInfo(dir);
    expect(info.commit).toBe("unknown");
    expect(info.commitShort).toBe("unknown");
    expect(info.branch).toBe("unknown");
    expect(info.dirty).toBe(false);
    expect(info.packageVersion).toBe("0.0.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeVersionInfo reports dirty only once there's an uncommitted change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-version-test-"));
  try {
    git(["init"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    await writeFile(join(dir, "file.txt"), "one\n");
    git(["add", "file.txt"], dir);
    git(["commit", "-m", "initial"], dir);

    const clean = computeVersionInfo(dir);
    expect(clean.dirty).toBe(false);
    expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(dir, "file.txt"), "two\n");
    const dirty = computeVersionInfo(dir);
    expect(dirty.dirty).toBe(true);
    expect(dirty.commit).toBe(clean.commit);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WISSEL_COMMIT override wins over the git-resolved commit", () => {
  const original = process.env.WISSEL_COMMIT;
  process.env.WISSEL_COMMIT = "override-sha";
  try {
    const info = computeVersionInfo(process.cwd());
    expect(info.commit).toBe("override-sha");
    expect(info.commitShort).toBe("override-sha");
  } finally {
    if (original === undefined) delete process.env.WISSEL_COMMIT;
    else process.env.WISSEL_COMMIT = original;
  }
});
