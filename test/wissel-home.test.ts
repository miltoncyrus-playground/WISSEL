import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { wisselHome } from "../src/core/wissel-home.ts";
import { buildSandboxSettings } from "../src/executors/sandbox.ts";

describe("wisselHome", () => {
  const saved = process.env.WISSEL_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.WISSEL_HOME;
    else process.env.WISSEL_HOME = saved;
  });

  test("defaults to ~/.wissel", () => {
    delete process.env.WISSEL_HOME;
    expect(wisselHome()).toBe(join(homedir(), ".wissel"));
  });

  test("WISSEL_HOME moves it", () => {
    process.env.WISSEL_HOME = "/srv/wissel-b";
    expect(wisselHome()).toBe("/srv/wissel-b");
  });

  test("an injected homeDir wins over WISSEL_HOME", () => {
    process.env.WISSEL_HOME = "/srv/wissel-b";
    expect(wisselHome("/tmp/fake-home")).toBe("/tmp/fake-home/.wissel");
  });

  test("a relative or ~ WISSEL_HOME is made absolute", () => {
    process.env.WISSEL_HOME = "~/wissel-b";
    expect(wisselHome()).toBe(join(homedir(), "wissel-b"));
    process.env.WISSEL_HOME = "rel/dir";
    expect(wisselHome()).toBe(join(process.cwd(), "rel/dir"));
  });
});

describe("sandbox read-deny for a second instance", () => {
  const saved = { home: process.env.WISSEL_HOME, db: process.env.WISSEL_DB_PATH };
  afterEach(() => {
    for (const [k, v] of [["WISSEL_HOME", saved.home], ["WISSEL_DB_PATH", saved.db]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const deny = () =>
    ((buildSandboxSettings({ repo: "/r" }).sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead);

  test("denies the instance board under WISSEL_HOME and an explicit WISSEL_DB_PATH", () => {
    process.env.WISSEL_HOME = "/srv/wissel-b";
    process.env.WISSEL_DB_PATH = "/data/b.sqlite";
    expect(deny()).toContain("/srv/wissel-b/board.sqlite*");
    expect(deny()).toContain("/data/b.sqlite*");
  });

  test("adds nothing when neither is set", () => {
    delete process.env.WISSEL_HOME;
    delete process.env.WISSEL_DB_PATH;
    expect(deny()).toContain("~/.wissel/board.sqlite*");
    expect(deny().length).toBe(8);
  });
});
