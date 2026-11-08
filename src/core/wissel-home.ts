import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where this instance keeps its state: worktrees, scratch, projects,
 *  task output, audio, the models cache, and the default board database
 *  and telemetry log. `WISSEL_HOME` moves all of them at once, so a
 *  second instance on the same host shares nothing with the first
 *  (docs/SDD-coordinator.md §12). Unset: `~/.wissel`, as before.
 *
 *  A caller that injects `homeDir` (tests) keeps the old meaning:
 *  `<homeDir>/.wissel`, with `WISSEL_HOME` ignored.
 *
 *  `WISSEL_HOME` is made absolute (a leading `~` expands to the home
 *  directory), so the sandbox deny pattern and the real paths agree. */
export function wisselHome(homeDir?: string): string {
  if (homeDir !== undefined) return join(homeDir, ".wissel");
  const fromEnv = process.env.WISSEL_HOME;
  if (!fromEnv) return join(homedir(), ".wissel");
  if (fromEnv === "~") return homedir();
  if (fromEnv.startsWith("~/")) return join(homedir(), fromEnv.slice(2));
  return resolve(fromEnv);
}
