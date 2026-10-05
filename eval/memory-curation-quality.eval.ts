#!/usr/bin/env bun
/**
 * Periodic eval for memory-curator's SELECTIVITY judgment
 * (agents/manifest.yaml's memory-curator.outputContract, "Selectivity
 * bar" section): real `claude` calls, real cost. Not run by `bun test`
 * (gate lane) — invoke explicitly with `bun run eval:memory-curation-quality`
 * before ship / nightly.
 *
 * The gate tests (test/memory-scheduler.test.ts, test/orchestrator.test.ts,
 * test/prompt.test.ts) already prove the deterministic plumbing is
 * correct: gatherSessionLessons assembles the right input text, the
 * finishResult hook writes the raw output back to memory/lessons.md
 * wholesale, and the prompt-injection section renders correctly. None of
 * that touches the one thing that's actually in question here: whether
 * the real memory-curator agent, handed a realistic mixed batch, judges
 * WHICH session entries are durable lessons worth keeping and WHICH are
 * noise worth dropping. That's a genuine latent-space judgment call (see
 * CLAUDE.md's latent-vs-deterministic rule) — it has no single correct
 * byte-for-byte output, so it belongs in this paid eval lane, not a gate
 * test.
 *
 * This fixture is shaped exactly like gatherSessionLessons' real output
 * (src/core/memory-scheduler.ts: "Current memory/lessons.md:" section
 * + "Sessions since <date>:" bullet list, one `- Title: outcome
 * (routing, cost, harness)` line per task) — not a hand-wavy paragraph —
 * so the real memory-curator agent sees input in the exact shape it gets
 * in production. It mixes 4 entries that describe a genuinely durable,
 * generalizable lesson (a real gotcha/constraint tied to a specific
 * symbol a future agent would otherwise rediscover the hard way) with 4
 * entries that are pure noise under the new selectivity bar (a routine
 * success, a one-off rename with no generalizable lesson, a fact already
 * obvious from the type it describes, and a routine dependency bump).
 *
 * Judging "did it keep the durable ones and drop the noise" is done by a
 * deterministic rubric check, not a second paid LLM-judge call: each
 * durable entry carries a distinctive code-symbol marker (a function/
 * type name) the real curator is very likely to preserve verbatim if it
 * keeps the lesson at all, and each noise entry carries a distinctive
 * marker that should NOT survive if the selectivity bar is doing its
 * job. Checking substring presence/absence is same-input-same-output —
 * exactly the kind of check CLAUDE.md says belongs in deterministic
 * code, not a second round of model judgment. The *input* to the check
 * (did the real agent keep/drop each marker) is still a real,
 * unscripted model output — this is where the eval's real cost and real
 * signal come from.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/core/registry.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import type { TaskCard } from "../src/core/types.ts";

interface SessionEntry {
  title: string;
  summary: string;
  routing: string;
  cost: string;
  harness: string;
  /** Substring that must appear (durable) or must NOT appear (noise)
   *  in the curated output for this entry's category to count as kept
   *  — see DURABLE_MARKERS/NOISE_MARKERS below. */
  marker: string;
  category: "durable" | "noise";
}

const EXISTING_MEMORY = `## Flaky timestamp assertions
Don't assert that two back-to-back calls produce different timestamps unless you control the clock — wall-clock resolution isn't guaranteed fine enough to tell two fast calls apart.

Fixed by giving the function under test an injectable \`now: Date\` parameter and passing two distinct explicit instants in the test, rather than relying on real elapsed wall-clock time between two calls made with no delay.`;

const ENTRIES: SessionEntry[] = [
  // --- durable: real, generalizable, structural ---
  {
    title: "Fix harness retry deadlock",
    summary:
      "Root cause: retrying a task against a harness without first calling HarnessPool.release(harnessId) re-acquires the same already-held slot and hangs forever — reproduced 4/4 times. Any future retry path must release before re-acquiring; nothing in the type system enforces this, so it's easy to reintroduce.",
    routing: "retry path",
    cost: "0.1200",
    harness: "claude-cli",
    marker: "HarnessPool.release",
    category: "durable",
  },
  {
    title: "Debug intermittent e2e failure",
    summary:
      "Root cause: Playwright's default waitForSelector timeout (30s) is shorter than this repo's cold-start seed time on a freshly cloned worktree with no node_modules cache (up to 45s). Any e2e spec that can run against a cold worktree needs an explicit longer timeout — the default fails intermittently for a reason unrelated to the test's own logic.",
    routing: "e2e flake",
    cost: "0.3400",
    harness: "claude-cli",
    marker: "waitForSelector timeout",
    category: "durable",
  },
  {
    title: "Fix config loader crash on empty file",
    summary:
      "loadConfig() in src/config.ts throws an uncaught exception, not a rejected promise, when the YAML file exists but is empty: parse('') returns null and the loader immediately reads .agents off it. Any future caller of parse() on a user-editable YAML file must null-check before property access.",
    routing: "crash report",
    cost: "0.0800",
    harness: "claude-cli",
    marker: "parse('') returns null",
    category: "durable",
  },
  {
    title: "Debug task stuck permanently undispatchable",
    summary:
      "Router.score() silently returns 0 for any agent whose tags array is empty, so an agent with no declared tags can never be routed to by tag-overlap scoring and nothing warns about it at manifest-load time. Forgetting tags: on a new agent leaves it permanently undispatchable with no error anywhere.",
    routing: "routing bug",
    cost: "0.2100",
    harness: "claude-cli",
    marker: "Router.score()",
    category: "durable",
  },
  // --- noise: should NOT survive the new selectivity bar ---
  {
    title: "Add CSV export button",
    summary: "Added the export button to the dashboard, wired it to the existing /export endpoint, tests pass, no issues.",
    routing: "ui",
    cost: "0.4500",
    harness: "claude-cli",
    marker: "CSV export button",
    category: "noise",
  },
  {
    title: "Rename variable in billing module",
    summary: "Renamed tmp2Variable to invoiceTotalAmount in src/billing/calc.ts per code review comment. No behavior change.",
    routing: "cleanup",
    cost: "0.0300",
    harness: "claude-cli",
    marker: "tmp2Variable",
    category: "noise",
  },
  {
    title: "Explain TaskCard type to user",
    summary: "TaskCard has fields id, title, body, labels, status, and repo. Explained each field's purpose to the user on request.",
    routing: "question",
    cost: "0.0200",
    harness: "claude-cli",
    marker: "TaskCard has fields id, title, body",
    category: "noise",
  },
  {
    title: "Bump yaml dependency version",
    summary: "Bumped the yaml package from 2.4.0 to 2.5.0 in package.json, ran the full test suite, all green, no changes needed elsewhere.",
    routing: "deps",
    cost: "0.0500",
    harness: "claude-cli",
    marker: "yaml package from 2.4.0 to 2.5.0",
    category: "noise",
  },
];

function buildTaskBody(): string {
  const since = new Date("2026-09-28T00:00:00.000Z").toISOString();
  const lines = ENTRIES.map((e) => `- ${e.title}: ok — ${e.summary} (routing: ${e.routing}, cost: $${e.cost}, harness: ${e.harness})`);
  return [`Current memory/lessons.md:`, EXISTING_MEMORY.trim(), `Sessions since ${since}:\n${lines.join("\n")}`].join("\n\n");
}

const DURABLE_KEEP_THRESHOLD = 0.75; // at least 3 of 4 durable markers must survive
const NOISE_DROP_THRESHOLD = 0.75; // at least 3 of 4 noise markers must NOT survive

async function main() {
  const registry = await Registry.load();
  const curator = registry.get("memory-curator");
  if (!curator) {
    console.error("FAIL  agents/manifest.yaml has no memory-curator entry");
    process.exit(1);
  }

  const dir = await mkdtemp(join(tmpdir(), "wissel-memory-curation-eval-"));
  try {
    // Pin runClaude's own "Lessons learned from prior sessions" prompt
    // injection (readMemoryLessons, src/executors/claude-cli.ts) at this
    // tmp file so it matches the same EXISTING_MEMORY text embedded in
    // the task body below — otherwise it falls through to
    // DEFAULT_MEMORY_PATH ("memory/lessons.md") and leaks this repo's
    // real, unrelated lessons file into the prompt. Belt and braces as of
    // docs/SDD-memory-injection-toggle.md: injection is off by default
    // (WISSEL_MEMORY_INJECTION), so nothing here actually injects memory
    // today — this pin is what protects the eval if that flag is ever on
    // in the environment it runs in. Left in place rather than removed.
    const memoryPath = join(dir, "lessons.md");
    await writeFile(memoryPath, EXISTING_MEMORY.trim());

    const task: TaskCard = {
      id: "eval-memory-curation-1",
      title: "Curate session memory",
      body: buildTaskBody(),
      labels: ["memory", "housekeeping"],
      repo: dir,
      status: "ready",
    };

    const executor = new ReadOnlyExecutor({ memoryPath });
    const result = await executor.run(task, curator);

    if (!result.ok) {
      console.log(`FAIL  run did not complete ok (ok=false): ${result.summary.slice(0, 300)}`);
      process.exit(1);
    }

    const output = result.summary;
    // Markers are matched against output with markdown code-span backticks
    // stripped: the curator routinely wraps code identifiers in backticks
    // (e.g. "`waitForSelector` timeout"), which would otherwise break a
    // plain substring check even though the identifier survived intact.
    const strippedOutput = output.replace(/`/g, "");

    const formatChecks: { name: string; pass: boolean }[] = [
      { name: "no fenced code block wrapping the whole file", pass: !/^\s*```/.test(output) },
      { name: "no preamble before the first heading", pass: !/^\s*(here'?s|i'?ve|let me|sure[,!]|below is)/i.test(output.trim()) },
    ];

    const durable = ENTRIES.filter((e) => e.category === "durable");
    const noise = ENTRIES.filter((e) => e.category === "noise");

    const durableKept = durable.filter((e) => strippedOutput.includes(e.marker));
    const noiseDropped = noise.filter((e) => !strippedOutput.includes(e.marker));

    const durableKeptRate = durableKept.length / durable.length;
    const noiseDroppedRate = noiseDropped.length / noise.length;

    console.log("=== Curated output (real memory-curator run) ===\n");
    console.log(output);
    console.log("\n=== Marker trace ===");
    for (const e of durable) {
      console.log(`${strippedOutput.includes(e.marker) ? "KEPT   " : "DROPPED"}  [durable]  ${e.title}  (marker: ${JSON.stringify(e.marker)})`);
    }
    for (const e of noise) {
      console.log(`${strippedOutput.includes(e.marker) ? "LEAKED " : "DROPPED"}  [noise]    ${e.title}  (marker: ${JSON.stringify(e.marker)})`);
    }

    console.log("\n=== Format checks ===");
    for (const c of formatChecks) {
      console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
    }

    const durablePass = durableKeptRate >= DURABLE_KEEP_THRESHOLD;
    const noisePass = noiseDroppedRate >= NOISE_DROP_THRESHOLD;
    const formatPass = formatChecks.every((c) => c.pass);
    const pass = durablePass && noisePass && formatPass;

    console.log("\n=== Rubric ===");
    console.log(`Durable kept: ${durableKept.length}/${durable.length} (${(durableKeptRate * 100).toFixed(0)}%) — threshold ${(DURABLE_KEEP_THRESHOLD * 100).toFixed(0)}% — ${durablePass ? "PASS" : "FAIL"}`);
    console.log(`Noise dropped: ${noiseDropped.length}/${noise.length} (${(noiseDroppedRate * 100).toFixed(0)}%) — threshold ${(NOISE_DROP_THRESHOLD * 100).toFixed(0)}% — ${noisePass ? "PASS" : "FAIL"}`);
    console.log(`Format discipline: ${formatPass ? "PASS" : "FAIL"}`);
    console.log(`Real cost this run: $${(result.actualCost ?? 0).toFixed(4)}`);
    console.log(`\nOVERALL: ${pass ? "PASS" : "FAIL"}`);

    if (!pass) process.exit(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
