import { resolve } from "node:path";

/**
 * One in-process async mutex per repo path: the merge path
 * (mergeTaskWorktree) holds it from merging the repo's HEAD into the
 * branch through landing and cleanup, so two merges into the same repo
 * (the orchestrator's auto-merge and a human's Merge button, or two
 * auto-merges finishing together) run one after the other instead of
 * colliding on `.git/index.lock` and reading as a merge failure.
 *
 * A plain promise chain per key: each caller waits on the previous
 * holder's release, nothing else. In-process only, like HarnessPool's
 * in-flight map; wissel runs one server process per board.
 */
const tails = new Map<string, Promise<void>>();

export interface LockTiming {
  /** How long the caller waited for the previous holder. */
  waitMs: number;
}

/** Runs `fn` while holding `repo`'s lock. The key is the resolved path,
 *  so `/a/b` and `/a/b/` are one lock. Released when `fn` settles,
 *  whether it resolves or throws. */
export async function withRepoLock<T>(repo: string, fn: (timing: LockTiming) => Promise<T>): Promise<T> {
  const key = resolve(repo);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = previous.then(() => mine);
  tails.set(key, tail);

  const waitStart = performance.now();
  await previous;
  const waitMs = Math.round(performance.now() - waitStart);
  try {
    return await fn({ waitMs });
  } finally {
    release();
    // Last one out drops the key, so the map doesn't grow per repo forever.
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** True while some caller holds or waits on `repo`'s lock. For tests. */
export function isRepoLocked(repo: string): boolean {
  return tails.has(resolve(repo));
}
