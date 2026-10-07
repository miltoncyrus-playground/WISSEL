import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Keeps README.md from drifting away from the code again: every command,
// env var and doc path it names has to exist. Each checker is a pure
// function over the README text so the "catches drift" cases below run
// against a fake README instead of trusting that the real one is wrong
// in the right way.

const ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

function scriptsOf(packageJsonPath: string): Set<string> {
  return new Set(Object.keys(JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts ?? {}));
}

const ROOT_SCRIPTS = scriptsOf(join(ROOT, "package.json"));
const EDITOR_SCRIPTS = scriptsOf(join(ROOT, "pipeline-editor", "package.json"));

function readSources(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out += readSources(path);
    else if (/\.(ts|js|html)$/.test(entry.name)) out += readFileSync(path, "utf8") + "\n";
  }
  return out;
}

const SRC = readSources(join(ROOT, "src"));

/** First line after the `# ` title that isn't blank or another heading. */
function firstBodyLine(readme: string): string {
  const lines = readme.split("\n");
  const title = lines.findIndex((l) => l.startsWith("# "));
  return lines.slice(title + 1).find((l) => l.trim() !== "" && !l.startsWith("#")) ?? "";
}

/** `bun run <name>` names that aren't scripts. Inside a fenced block, a
 *  `cd pipeline-editor` line switches the check to that package until
 *  `cd ..` or the end of the block. */
function unknownScripts(readme: string, rootScripts: Set<string>, editorScripts: Set<string>): string[] {
  const missing: string[] = [];
  let inFence = false;
  let scripts = rootScripts;
  for (const line of readme.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      scripts = rootScripts;
      continue;
    }
    if (inFence && /^\s*cd pipeline-editor\b/.test(line)) scripts = editorScripts;
    if (inFence && /^\s*cd \.\.\s*$/.test(line)) scripts = rootScripts;
    for (const m of line.matchAll(/bun run ([a-z][\w:-]*)/g)) {
      if (!scripts.has(m[1]!)) missing.push(m[1]!);
    }
  }
  return missing;
}

/** WISSEL_* names in the README that src/ never mentions. */
function unknownEnvVars(readme: string, src: string): string[] {
  const names = new Set(readme.match(/WISSEL_[A-Z0-9_]+/g) ?? []);
  return [...names].filter((n) => !new RegExp(`\\b${n}\\b`).test(src));
}

/** WISSEL_* vars src/ actually reads from process.env that the README
 *  doesn't list. */
function undocumentedEnvVars(readme: string, src: string): string[] {
  const read = new Set([...src.matchAll(/process\.env\.(WISSEL_[A-Z0-9_]+)/g)].map((m) => m[1]!));
  return [...read].filter((n) => !new RegExp(`\\b${n}\\b`).test(readme));
}

/** `docs/*.md` paths the README names that don't exist. */
function missingDocs(readme: string, root: string): string[] {
  const paths = new Set(readme.match(/docs\/[\w.-]+\.md/g) ?? []);
  return [...paths].filter((p) => !existsSync(join(root, p)));
}

describe("README.md", () => {
  test("first line under the title is the personal research project notice", () => {
    const line = firstBodyLine(README).toLowerCase();
    expect(line).toContain("personal research project");
    expect(line).toMatch(/chang\w* .*break/);
  });

  test("every `bun run <name>` is a real package.json script", () => {
    expect(unknownScripts(README, ROOT_SCRIPTS, EDITOR_SCRIPTS)).toEqual([]);
  });

  test("every WISSEL_* name appears in src/", () => {
    expect(unknownEnvVars(README, SRC)).toEqual([]);
  });

  test("every WISSEL_* var src/ reads from process.env is documented", () => {
    expect(undocumentedEnvVars(README, SRC)).toEqual([]);
  });

  test("every docs/*.md path exists", () => {
    expect(missingDocs(README, ROOT)).toEqual([]);
  });

  test("has no em dashes", () => {
    expect(README).not.toContain("—");
  });
});

describe("README checks catch drift", () => {
  test("a missing notice fails", () => {
    expect(firstBodyLine("# wissel\n\nRoutes tasks to agents.\n")).not.toContain("personal research project");
  });

  test("a fake script fails, and editor scripts only count inside `cd pipeline-editor`", () => {
    const fake = "`bun run nope`\n```bash\ncd pipeline-editor\nbun run build\ncd ..\nbun run build\n```\n";
    expect(unknownScripts(fake, ROOT_SCRIPTS, EDITOR_SCRIPTS)).toEqual(["nope", "build"]);
  });

  test("a fake env var fails", () => {
    expect(unknownEnvVars("`WISSEL_NOPE` and `WISSEL_PORT`", SRC)).toEqual(["WISSEL_NOPE"]);
  });

  test("an env var read in src/ but missing from the README fails", () => {
    expect(undocumentedEnvVars("only WISSEL_PORT", SRC)).toContain("WISSEL_DB_PATH");
  });

  test("a missing doc fails", () => {
    expect(missingDocs("see docs/SDD-nope.md and docs/SDD-pipelines.md", ROOT)).toEqual(["docs/SDD-nope.md"]);
  });
});
