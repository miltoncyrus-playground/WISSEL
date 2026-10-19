/**
 * The write-tier verification contract's project-specific half
 * (docs/SDD-project-settings.md §7). A write-tier agent's
 * `verificationContract` in agents/manifest.yaml names *where* the
 * project's check commands go with two tokens; this module renders them
 * from `Project.verification` (set with `POST /projects/:id/settings`),
 * or from today's Bun defaults when the project has none.
 *
 * Two tokens, both optional in any contract:
 *
 * - `{{verification.run}}`: the whole "Before reporting done, run: ..."
 *   paragraph, commands listed one per line, with the fix-and-re-run
 *   and pre-existing-failure rules.
 * - `{{verification.commands}}`: the commands as an inline list
 *   (`` `uv run pytest`, `uv run ruff check` and `terraform validate` ``)
 *   for a sentence the manifest owns, such as "Run ... as plain
 *   commands: no pipes, no `time`, no redirects."
 *
 * With no project verification set, each token renders to the literal
 * text the manifest carried before the tokens existed (DEFAULT_RUN_BLOCK,
 * DEFAULT_COMMANDS_INLINE), so a project with no settings gets a prompt
 * byte-identical to before. A contract with no tokens (every readonly
 * agent) is returned untouched whatever the project says.
 *
 * Pure: no file or store access. WriteExecutor/CodexWriteExecutor look
 * the setting up (ProjectStore.settingsFor, keyed by `task.repo`, the
 * human-controlled checkout, never a file in the worktree) and pass it
 * down through runClaude/runCodex to buildAgentPrompt.
 */

import type { Project } from "./types.ts";

export type Verification = NonNullable<Project["verification"]>;

/** What a project with no `verification` set gets: the two commands
 *  wissel's own implementer has always run, and the two command-scoped
 *  grants that let it. The order of `allowedTools` is the order
 *  `--allowedTools` has always carried. */
export const DEFAULT_VERIFICATION: Verification = {
  commands: [
    ["bun", "run", "typecheck"],
    ["bun", "test", "test/"],
  ],
  allowedTools: ["Bash(bun test:*)", "Bash(bun run typecheck:*)"],
};

export const VERIFICATION_RUN_TOKEN = "{{verification.run}}";
export const VERIFICATION_COMMANDS_TOKEN = "{{verification.commands}}";
export const VERIFICATION_TOKENS: readonly string[] = [VERIFICATION_RUN_TOKEN, VERIFICATION_COMMANDS_TOKEN];

/** The implementer's run paragraph exactly as agents/manifest.yaml
 *  carried it before `{{verification.run}}` replaced it. Literal, not
 *  generated from DEFAULT_VERIFICATION: its "either"/"both" wording is
 *  two-command English, and byte-identity for the default case is the
 *  backward-compatibility guarantee, so it is pinned here and in
 *  test/prompt.test.ts. */
export const DEFAULT_RUN_BLOCK = [
  "Before reporting done, run:",
  "  bun run typecheck",
  "  bun test test/",
  "If either fails, fix it and re-run both — do not report done with",
  "either one red. If a failure is pre-existing and clearly unrelated",
  "to your change (confirm this by checking whether it also fails on",
  "a clean checkout before your edits), say so explicitly in your",
  "summary instead of silently leaving it broken.",
].join("\n");

/** The inline command list every write-tier steering sentence carried
 *  before `{{verification.commands}}` replaced it, including the line
 *  break the manifest wrapped it at. Literal for the same reason as
 *  DEFAULT_RUN_BLOCK (it names `bun test` without the `test/` argument
 *  the run block uses, and the wrap is part of the bytes). */
export const DEFAULT_COMMANDS_INLINE = "`bun test` and\n`bun run typecheck`";

const TOKEN_RE = /\{\{([^{}]*)\}\}/g;

/** Every `{{...}}` token in `text` that isn't one this module renders.
 *  Registry.from fails the manifest load on any, so a typo can never
 *  reach a paid prompt as literal braces. */
export function unknownVerificationTokens(text: string): string[] {
  const unknown: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0];
    if (!VERIFICATION_TOKENS.includes(token) && !unknown.includes(token)) unknown.push(token);
  }
  return unknown;
}

/**
 * Renders the two tokens in a verificationContract. `verification`
 * undefined means the project has none set: the defaults above, byte for
 * byte. A contract without tokens comes back unchanged either way.
 */
export function renderVerificationContract(contract: string, verification?: Pick<Verification, "commands">): string {
  if (!contract.includes("{{")) return contract;
  const run = verification ? runBlock(verification.commands) : DEFAULT_RUN_BLOCK;
  const inline = verification ? commandsInline(verification.commands) : DEFAULT_COMMANDS_INLINE;
  return contract.split(VERIFICATION_RUN_TOKEN).join(run).split(VERIFICATION_COMMANDS_TOKEN).join(inline);
}

/** The "Before reporting done" paragraph for a project's own commands:
 *  run each plain, fix and re-run until all are green, the same
 *  pre-existing-failure rule as the default. Zero commands (a
 *  verification set for its `allowedTools` alone) says so instead of
 *  listing nothing. */
export function runBlock(commands: string[][]): string {
  if (commands.length === 0) {
    return [
      "This project has no verification commands configured. Before",
      "reporting done, re-read every change you made and the tests that",
      "cover it.",
    ].join("\n");
  }
  return [
    "Before reporting done, run each of these as a plain command (no",
    "pipes, no redirects):",
    ...commands.map((c) => `  ${formatCommand(c)}`),
    "If any fails, fix it and re-run all of them until every one is",
    "green. Do not report done with any of them red. If a failure is",
    "pre-existing and clearly unrelated to your change (confirm this by",
    "checking whether it also fails on a clean checkout before your",
    "edits), say so explicitly in your summary instead of silently",
    "leaving it broken.",
  ].join("\n");
}

/** `` `a`, `b` and `c` `` for a sentence the manifest owns. Zero commands
 *  reads as a noun phrase that still fits that sentence. */
export function commandsInline(commands: string[][]): string {
  if (commands.length === 0) return "the project's verification commands";
  const names = commands.map((c) => `\`${formatCommand(c)}\``);
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** An argv as the agent should type it: words joined by one space, a
 *  word with whitespace or shell-special characters single-quoted. */
export function formatCommand(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(" ");
}
