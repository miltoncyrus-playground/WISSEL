import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Writes per-session MCP server config into a session's
 * `.claude/settings.local.json`. Atomic write, merge-preserving: never
 * clobber keys this module did not author.
 *
 * Ported from agetor's `hook-installer.ts`. agetor's version also strips
 * stale hook/MCP entries left by its own earlier builds — wissel has no
 * legacy to clean up yet, so that part is dropped, but the safety shape
 * carries over unchanged: owned worktrees may self-heal a malformed file
 * (it's wissel's own scratch there), a user's source repo never gets its
 * malformed settings silently overwritten.
 */
export interface ProvisionOptions {
  cwd: string;
  originRepo: string;
  mcpServers?: Record<string, unknown>;
  /** True when `cwd` is inside wissel's owned worktree root. Owned trees
   *  self-heal a malformed settings file; anything else refuses to touch
   *  one rather than risk losing user-authored config. */
  owned?: boolean;
}

export class Provisioner {
  async provision(opts: ProvisionOptions): Promise<void> {
    if (!existsSync(opts.cwd)) {
      throw new Error(`provision: cwd does not exist: ${opts.cwd}`);
    }

    const settingsDir = path.join(opts.cwd, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsFile = path.join(settingsDir, "settings.local.json");

    const settings = await readExistingSettings(settingsFile, opts.owned ?? false);

    if (opts.mcpServers) {
      const existing =
        settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers)
          ? (settings.mcpServers as Record<string, unknown>)
          : {};
      settings.mcpServers = { ...existing, ...opts.mcpServers };
    }

    await writeJsonAtomic(settingsFile, settings);
  }
}

/**
 * Reads and parses an existing settings.local.json, if any.
 *
 * `owned: true` (wissel's own worktree): a malformed file is wissel's own
 * bug, safe to reset to `{}`.
 * `owned: false` (the user's source repo, isolation=none): refuse to
 * proceed on malformed JSON — overwriting a mid-edit file could lose
 * config the merge is supposed to preserve.
 */
async function readExistingSettings(settingsFile: string, owned: boolean): Promise<Record<string, unknown>> {
  if (!existsSync(settingsFile)) return {};

  const raw = await readFile(settingsFile, "utf8");
  if (!raw.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    if (!owned) {
      throw new Error(
        `refusing to merge: ${settingsFile} is not valid JSON. Fix or delete the file to provision this session. (${(e as Error).message})`,
      );
    }
    return {};
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  if (!owned) {
    throw new Error(
      `refusing to merge: ${settingsFile} is not a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed}).`,
    );
  }
  return {};
}

/** Atomic JSON write: stringify, write to a sibling tempfile, rename onto
 *  the target. rename is atomic on POSIX, so a partial write can never
 *  leave the destination corrupted. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}
