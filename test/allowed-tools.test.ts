import { expect, test } from "bun:test";
import { MAX_EXTRA_ALLOWED_TOOLS, validateExtraAllowedTools } from "../src/core/allowed-tools.ts";
import { commandKeys, summarizeDenials } from "../src/core/permission-denials.ts";

// Per-card tool grants (src/core/allowed-tools.ts) and the readable
// permission refusal keys (src/core/permission-denials.ts).

/** What the Wissel app cards 2 to 6 are granted (docs/SDD-wissel-app.md). */
const APP_GRANTS = [
  "Bash(bun install:*)",
  "Bash(bun --cwd app install:*)",
  "Bash(bun --cwd app run:*)",
  "Bash(bun --cwd pipeline-editor install:*)",
  "Bash(bun run build:app:*)",
  "Bash(bun run build:editor:*)",
  "Bash(bun run test:*)",
  "Bash(bunx playwright test:*)",
];

test("accepts command-scoped grants, drops duplicates, keeps order", () => {
  expect(validateExtraAllowedTools(APP_GRANTS)).toEqual({ ok: true, tools: APP_GRANTS });
  expect(validateExtraAllowedTools(["Bash(bun install:*)", "Bash(bun install:*)", "Bash(npm test)"])).toEqual({
    ok: true,
    tools: ["Bash(bun install:*)", "Bash(npm test)"],
  });
  expect(validateExtraAllowedTools(undefined)).toEqual({ ok: true, tools: [] });
  expect(validateExtraAllowedTools(null)).toEqual({ ok: true, tools: [] });
  expect(validateExtraAllowedTools([])).toEqual({ ok: true, tools: [] });
});

test("refuses blanket, non-Bash and malformed grants", () => {
  for (const bad of ["Bash", "Bash(*)", "Bash(:*)", "Write", "Edit(/etc/passwd)", "WebFetch", "bash(bun install)", "Bash(bun install", "Bash()"]) {
    const r = validateExtraAllowedTools([bad]);
    expect(r.ok, bad).toBe(false);
  }
  expect(validateExtraAllowedTools("Bash(bun install:*)")).toEqual({ ok: false, error: "extraAllowedTools must be a list of strings" });
  expect(validateExtraAllowedTools([1])).toEqual({ ok: false, error: "extraAllowedTools must be a list of strings" });
});

test("refuses shell operators, so a grant can't smuggle a second command", () => {
  for (const bad of ["Bash(bun install && rm -rf /:*)", "Bash(bun install; curl x:*)", "Bash(bun install | sh:*)", "Bash(bun run $(whoami):*)", "Bash(bun run `id`:*)", "Bash(bun install > /etc/x:*)"]) {
    expect(validateExtraAllowedTools([bad]).ok, bad).toBe(false);
  }
});

test("refuses dangerous programs and subcommands, and limits bunx/npx to named tools", () => {
  const refused: [string, string][] = [
    ["Bash(rm -rf:*)", '"Bash(rm -rf:*)" grants "rm", which is never granted per card'],
    ["Bash(git push:*)", '"Bash(git push:*)" grants "git", which is never granted per card'],
    ["Bash(curl:*)", '"Bash(curl:*)" grants "curl", which is never granted per card'],
    ["Bash(sudo systemctl:*)", '"Bash(sudo systemctl:*)" grants "sudo", which is never granted per card'],
    ["Bash(docker run:*)", '"Bash(docker run:*)" grants "docker", which is never granted per card'],
    ["Bash(bun publish:*)", '"Bash(bun publish:*)" grants "bun publish", which is never granted per card'],
    ["Bash(bun x:*)", '"Bash(bun x:*)" grants "bun x", which is never granted per card'],
    ["Bash(bun --cwd app publish:*)", '"Bash(bun --cwd app publish:*)" grants "bun publish", which is never granted per card'],
    ["Bash(bun -e:*)", '"Bash(bun -e:*)" grants "bun -e", which is never granted per card'],
    ["Bash(npm exec:*)", '"Bash(npm exec:*)" grants "npm exec", which is never granted per card'],
    ["Bash(npm publish:*)", '"Bash(npm publish:*)" grants "npm publish", which is never granted per card'],
    ["Bash(bunx cowsay:*)", '"Bash(bunx cowsay:*)": bunx may only run playwright, vite, vitest, tsc'],
    ["Bash(bunx:*)", '"Bash(bunx:*)": bunx may only run playwright, vite, vitest, tsc'],
    ["Bash(npx rimraf:*)", '"Bash(npx rimraf:*)": npx may only run playwright, vite, vitest, tsc'],
  ];
  for (const [grant, error] of refused) expect(validateExtraAllowedTools([grant])).toEqual({ ok: false, error });
});

test(`caps a card at ${MAX_EXTRA_ALLOWED_TOOLS} grants`, () => {
  const many = Array.from({ length: MAX_EXTRA_ALLOWED_TOOLS + 1 }, (_, i) => `Bash(bun run task${i}:*)`);
  expect(validateExtraAllowedTools(many)).toEqual({ ok: false, error: `extraAllowedTools has 13 entries; at most ${MAX_EXTRA_ALLOWED_TOOLS}` });
  expect(validateExtraAllowedTools(many.slice(0, MAX_EXTRA_ALLOWED_TOOLS)).ok).toBe(true);
});

// The three real refusals from the "Wissel app 1/6" card's output, verbatim.
const REAL_DENIALS = [
  { tool_name: "Bash", tool_use_id: "a", tool_input: { command: "cd /home/user/.wissel/worktrees/4e7da4ab/app && ls -la && cat package.json && timeout 300 bun install 2>&1 | tail -20" } },
  { tool_name: "Bash", tool_use_id: "b", tool_input: { command: "bun install --cwd /home/user/.wissel/worktrees/4e7da4ab/app" } },
  { tool_name: "Bash", tool_use_id: "c", tool_input: { command: "npm install --prefix app" } },
];

test("commandKeys finds the real command behind navigation, wrappers and redirects", () => {
  expect(commandKeys(REAL_DENIALS[0]!.tool_input.command)).toEqual(["bun install"]);
  expect(commandKeys(REAL_DENIALS[1]!.tool_input.command)).toEqual(["bun install"]);
  expect(commandKeys(REAL_DENIALS[2]!.tool_input.command)).toEqual(["npm install"]);
  // A script runner's script is part of the key.
  expect(commandKeys("bun --cwd app run build")).toEqual(["bun run build"]);
  expect(commandKeys("npm run eval:memory-curation-quality")).toEqual(["npm run eval:memory-curation-quality"]);
  expect(commandKeys("CI=1 bunx playwright test e2e/app.spec.ts")).toEqual(["bunx playwright"]);
  expect(commandKeys("cd app; ls")).toEqual([]);
  expect(commandKeys("docker ps || true")).toEqual(["docker ps"]);
  expect(commandKeys("./scripts/x.sh --flag")).toEqual(["./scripts/x.sh"]);
});

test("summarizeDenials: comparable keys, non-Bash tools by name, malformed entries skipped", () => {
  expect(summarizeDenials(REAL_DENIALS)).toEqual(["Bash: bun install", "Bash: npm install"]);
  expect(summarizeDenials([{ tool_name: "Write", tool_input: { file_path: "/etc/x" } }, { tool_name: "Bash", tool_input: { command: "cd x" } }, {}, null, 3, { tool_name: "" }])).toEqual(["Write", "Bash: cd (shell form)"]);
  expect(summarizeDenials(undefined)).toEqual([]);
  expect(summarizeDenials("nope")).toEqual([]);
});
