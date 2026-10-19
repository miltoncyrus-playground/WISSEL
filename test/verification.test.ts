// The project-verification renderer (src/core/verification.ts,
// docs/SDD-project-settings.md §7): token rendering, command formatting,
// the fail-loud manifest check, and the real manifest's use of the tokens.

import { expect, test } from "bun:test";
import { Registry } from "../src/core/registry.ts";
import type { AgentDef } from "../src/core/types.ts";
import {
  commandsInline,
  DEFAULT_COMMANDS_INLINE,
  DEFAULT_RUN_BLOCK,
  DEFAULT_VERIFICATION,
  formatCommand,
  renderVerificationContract,
  runBlock,
  unknownVerificationTokens,
  VERIFICATION_COMMANDS_TOKEN,
  VERIFICATION_RUN_TOKEN,
} from "../src/core/verification.ts";

const FINN = [
  ["uv", "run", "pytest"],
  ["uv", "run", "ruff", "check"],
  ["uv", "run", "pyright"],
];

test("the defaults are the pair wissel has always run and granted, in --allowedTools order", () => {
  expect(DEFAULT_VERIFICATION).toEqual({
    commands: [
      ["bun", "run", "typecheck"],
      ["bun", "test", "test/"],
    ],
    allowedTools: ["Bash(bun test:*)", "Bash(bun run typecheck:*)"],
  });
});

test("renderVerificationContract: no tokens means the text comes back unchanged, with or without a verification", () => {
  const plain = "You run under `--permission-mode plan`. Never attempt `git add`.";
  expect(renderVerificationContract(plain)).toBe(plain);
  expect(renderVerificationContract(plain, { commands: FINN })).toBe(plain);
});

test("renderVerificationContract: no verification renders the literal defaults, so the default prompt never changes", () => {
  const contract = `${VERIFICATION_RUN_TOKEN}\n\nRun ${VERIFICATION_COMMANDS_TOKEN} plain.`;
  expect(renderVerificationContract(contract)).toBe(`${DEFAULT_RUN_BLOCK}\n\nRun ${DEFAULT_COMMANDS_INLINE} plain.`);
  expect(DEFAULT_RUN_BLOCK).toContain("  bun run typecheck\n  bun test test/\nIf either fails, fix it and re-run both");
  // The manifest wrapped the sentence between "and" and the second
  // command; the literal keeps that wrap so the bytes match.
  expect(DEFAULT_COMMANDS_INLINE).toBe("`bun test` and\n`bun run typecheck`");
});

test("renderVerificationContract: a verification renders its commands into both tokens, every occurrence", () => {
  const contract = `${VERIFICATION_RUN_TOKEN}\n\nRun ${VERIFICATION_COMMANDS_TOKEN} plain. Again: ${VERIFICATION_COMMANDS_TOKEN}.`;
  const out = renderVerificationContract(contract, { commands: FINN });
  expect(out).toBe(`${runBlock(FINN)}\n\nRun ${commandsInline(FINN)} plain. Again: ${commandsInline(FINN)}.`);
  expect(out).not.toContain("{{");
  expect(out).not.toContain("bun");
});

test("runBlock lists each command on its own line and keeps the fix-and-re-run and pre-existing-failure rules", () => {
  const block = runBlock(FINN);
  expect(block.split("\n").slice(0, 5)).toEqual([
    "Before reporting done, run each of these as a plain command (no",
    "pipes, no redirects):",
    "  uv run pytest",
    "  uv run ruff check",
    "  uv run pyright",
  ]);
  expect(block).toContain("If any fails, fix it and re-run all of them until every one is\ngreen. Do not report done with any of them red.");
  expect(block).toContain("confirm this by\nchecking whether it also fails on a clean checkout before your\nedits");
  expect(block).toContain("say so explicitly in your summary instead of silently\nleaving it broken.");
});

test("runBlock with no commands says so rather than printing an empty list", () => {
  expect(runBlock([])).toBe("This project has no verification commands configured. Before\nreporting done, re-read every change you made and the tests that\ncover it.");
});

test("commandsInline: one, two, three and zero commands read as English", () => {
  expect(commandsInline([["make", "check"]])).toBe("`make check`");
  expect(commandsInline([["uv", "run", "pytest"], ["terraform", "validate"]])).toBe("`uv run pytest` and `terraform validate`");
  expect(commandsInline(FINN)).toBe("`uv run pytest`, `uv run ruff check` and `uv run pyright`");
  expect(commandsInline([])).toBe("the project's verification commands");
});

test("formatCommand joins plain words with one space and single-quotes anything the shell would split or expand", () => {
  expect(formatCommand(["uv", "run", "pytest", "-q", "tests/unit", "--maxfail=1"])).toBe("uv run pytest -q tests/unit --maxfail=1");
  expect(formatCommand(["pytest", "-k", "not slow"])).toBe("pytest -k 'not slow'");
  expect(formatCommand(["echo", "it's", "$HOME", "a;b"])).toBe("echo 'it'\\''s' '$HOME' 'a;b'");
});

test("unknownVerificationTokens names every {{...}} that isn't one of the two rendered tokens, once each", () => {
  expect(unknownVerificationTokens(`${VERIFICATION_RUN_TOKEN} ${VERIFICATION_COMMANDS_TOKEN}`)).toEqual([]);
  expect(unknownVerificationTokens("no tokens here")).toEqual([]);
  expect(unknownVerificationTokens("{{verifcation.run}} and {{verification.cmds}} and {{verifcation.run}}")).toEqual(["{{verifcation.run}}", "{{verification.cmds}}"]);
});

const base: AgentDef = {
  id: "x",
  name: "X",
  kind: "agent",
  tier: "write",
  description: "d",
  whenToUse: "w",
  tags: ["x"],
  executor: "handoff",
  inputs: [],
  outputs: [],
  trustLevel: "high",
  toolAccess: ["read", "write", "bash"],
  costProfile: { model: "claude-fable-5-1", estUsdPerTask: 1 },
};

test("Registry.from fails the load on a verificationContract with an unknown token: a typo never reaches a paid prompt as literal braces", () => {
  expect(() => Registry.from([{ ...base, verificationContract: "Run {{verification.commands}} plain." }])).not.toThrow();
  expect(() => Registry.from([{ ...base, verificationContract: "Run {{verifcation.commands}} plain." }])).toThrow(
    'agent "x": verificationContract has unknown token(s) {{verifcation.commands}}; known: {{verification.run}}, {{verification.commands}}',
  );
});

test("the real manifest: the run token is the implementer's alone, every write-tier contract carries the commands token, and no readonly contract has either", async () => {
  const registry = await Registry.load();
  const withRun = registry.all().filter((a) => (a.verificationContract ?? "").includes(VERIFICATION_RUN_TOKEN));
  expect(withRun.map((a) => a.id)).toEqual(["implementer"]);
  for (const a of registry.all().filter((a) => a.tier === "write")) {
    expect({ id: a.id, hasCommands: (a.verificationContract ?? "").includes(VERIFICATION_COMMANDS_TOKEN) }).toEqual({ id: a.id, hasCommands: true });
  }
  for (const a of registry.all().filter((a) => a.tier !== "write")) {
    expect({ id: a.id, tokens: (a.verificationContract ?? "").includes("{{") }).toEqual({ id: a.id, tokens: false });
  }
});
