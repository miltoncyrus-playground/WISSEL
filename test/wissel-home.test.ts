import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { wisselHome } from "../src/core/wissel-home.ts";

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
});
