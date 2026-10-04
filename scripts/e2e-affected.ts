#!/usr/bin/env bun
/**
 * Scoped e2e runner: maps changed files to the e2e spec(s) that
 * actually exercise them (via scripts/e2e-affected-map.ts), so a
 * narrow change doesn't have to pay for the full ~70-test suite on
 * every iteration.
 *
 * THIS IS A SPEED TOOL FOR FAST ITERATION, NOT A SHIPPING GATE. A green
 * scoped run only proves the spec(s) it ran are green — it never proves
 * nothing else broke. Always run the full suite (`bun run test:e2e`)
 * before actually merging/shipping.
 *
 * Usage:
 *   bun run scripts/e2e-affected.ts                     # diff working tree against HEAD, print affected specs
 *   bun run scripts/e2e-affected.ts --base origin/main   # diff against a ref instead of HEAD
 *   bun run scripts/e2e-affected.ts path/a.ts path/b.ts  # resolve explicit paths, no git lookup at all
 *   bun run scripts/e2e-affected.ts --run                # also invoke playwright with the resolved spec(s)
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolveAffectedSpecs, type ChangedFileInput } from "./e2e-affected-map.ts";

const BOARD_HTML_PATH = "src/api/public/board.html";

function listAllSpecs(): string[] {
  return readdirSync(new URL("../e2e/", import.meta.url))
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.status}`);
  }
  return result.stdout;
}

/** Mirrors src/services/repo-diff.ts's own convention (git diff HEAD +
 *  git status --porcelain for untracked) when no explicit base ref is
 *  given, so "what changed" means the same thing here as it does
 *  elsewhere in this repo. */
function gitChangedPaths(base: string | undefined): string[] {
  const trackedDiff = base ? runGit(["diff", "--name-only", `${base}...HEAD`]) : runGit(["diff", "--name-only", "HEAD"]);
  const tracked = trackedDiff
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (base) return [...new Set(tracked)];

  const untracked = runGit(["status", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  return [...new Set([...tracked, ...untracked])];
}

function boardHtmlChangedLines(base: string | undefined): string[] {
  const diffTarget = base ? `${base}...HEAD` : "HEAD";
  const diff = runGit(["diff", "-U0", diffTarget, "--", BOARD_HTML_PATH]);
  return diff
    .split("\n")
    .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")))
    .map((l) => l.slice(1));
}

function parseArgs(argv: string[]): { run: boolean; base: string | undefined; paths: string[] } {
  let run = false;
  let base: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--run") {
      run = true;
    } else if (arg === "--base") {
      base = argv[++i];
    } else {
      paths.push(arg);
    }
  }
  return { run, base, paths };
}

function main(): void {
  const { run, base, paths } = parseArgs(process.argv.slice(2));
  const allSpecs = listAllSpecs();
  const changedPaths = paths.length > 0 ? paths : gitChangedPaths(base);

  if (changedPaths.length === 0) {
    console.log("No changed files detected — nothing to run.");
    return;
  }

  const changed: ChangedFileInput[] = changedPaths.map((path) => ({
    path,
    changedLines: path === BOARD_HTML_PATH && paths.length === 0 ? boardHtmlChangedLines(base) : undefined,
  }));

  const result = resolveAffectedSpecs(changed, allSpecs);

  console.log(`Changed path -> affected spec(s) (${changedPaths.length} path(s)):\n`);
  for (const f of result.files) {
    const label = f.specs === "ALL" ? "ALL (full suite)" : f.specs.length > 0 ? f.specs.join(", ") : "(none)";
    console.log(`  ${f.path}`);
    console.log(`    -> ${label}`);
    console.log(`    ${f.reason}`);
  }

  console.log("");
  if (result.fullSuite) {
    console.log(`Resolved: FULL SUITE — ${result.specs.length}/${allSpecs.length} spec(s): ${result.specs.join(", ")}`);
  } else {
    console.log(`Resolved: ${result.specs.length}/${allSpecs.length} spec(s): ${result.specs.join(", ") || "(none)"}`);
  }
  console.log(
    "\nReminder: this is a speed tool for fast iteration only, not a shipping gate. Run `bun run test:e2e` (the full suite) before merging/shipping.",
  );

  if (run) {
    if (result.specs.length === 0) {
      console.log("\nNothing to run.");
      return;
    }
    const specPaths = result.specs.map((s) => `e2e/${s}`);
    console.log(`\nRunning: bunx playwright test ${specPaths.join(" ")}\n`);
    const playwright = spawnSync("bunx", ["playwright", "test", ...specPaths], { stdio: "inherit" });
    process.exit(playwright.status ?? 1);
  }
}

main();
