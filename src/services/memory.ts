import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Global, single-file memory — one repo-root file shared across every
 * repo wissel touches, not per-repo (see docs/SDD-memory-curator.md
 * §8.1). A plain relative path, same "repo-root config file" convention
 * `agents/manifest.yaml`/`harnesses.yaml` already use.
 */
export const DEFAULT_MEMORY_PATH = "memory/lessons.md";

/**
 * Reads the current curated memory file, if one exists yet. Undefined
 * (never an error) when nothing has been curated so far — the same "no
 * file yet is a valid starting state" contract setHarnessEnabled/
 * HarnessPool.autoload() already hold for their own optional files.
 */
export async function readMemoryLessons(path: string = DEFAULT_MEMORY_PATH): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * Replaces the memory file wholesale — never appended to. memory-curator
 * is handed the current file's own contents as part of its input (see
 * gatherSessionLessons) specifically so it can dedup/consolidate against
 * what's already there; writing its summary back verbatim here is what
 * applies that compaction. See finishResult's
 * `outputs.includes("memory-entries")` hook, the only caller.
 */
export async function writeMemoryLessons(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
