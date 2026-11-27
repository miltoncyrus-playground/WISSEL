#!/usr/bin/env bun
/**
 * Exits 0 when the host has room for new cards, 1 (printing what is
 * short) when it doesn't. The host guard's owner task runs this on Done
 * (src/services/host-guard.ts, docs/SDD-coordinator.md §4.12).
 *
 *   bun run host:check
 *
 * Reads each project's temp directory (its env.TMPDIR) from the board's
 * database read-only, with the same WISSEL_DB_PATH and WISSEL_HOST_GUARD_*
 * thresholds as the server.
 */
import { Database } from "bun:sqlite";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hostProblems, readHost, thresholdsFromEnv } from "../src/services/host-guard.ts";

export function projectTempDirs(dbPath: string): string[] {
  const dirs = new Set<string>([tmpdir()]);
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      for (const row of db.query("SELECT env FROM projects").all() as { env: string | null }[]) {
        const env = row.env ? (JSON.parse(row.env) as Record<string, string>) : undefined;
        if (env?.TMPDIR) dirs.add(env.TMPDIR);
      }
    } finally {
      db.close();
    }
  } catch {
    // No board yet, or no env column: the system temp directory only.
  }
  return [...dirs];
}

if (import.meta.main) {
  const dbPath = process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite");
  const problems = hostProblems(readHost(join(homedir(), ".wissel"), projectTempDirs(dbPath)), thresholdsFromEnv(process.env));
  if (problems.length > 0) {
    console.log(`The host is still short: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("The host has room for new cards.");
}
