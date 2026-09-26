import { appendFile, mkdir, readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Same "~/.wissel/<subdir>" convention worktreesRoot/board.sqlite
 *  already use (see src/services/worktree.ts) — deliberately outside
 *  any repo directory. */
export const DEFAULT_TASK_OUTPUT_DIR = join(homedir(), ".wissel", "task-output");

/** Same 256KB cap agetor's own terminals.ts ring buffer uses, and for
 *  the same reason (see docs/SDD-live-task-output.md §3.2) — plenty for
 *  a screen of scrollback, bounded so a runaway loop can't grow memory
 *  unbounded. Applies only to the in-memory ring buffer
 *  (getBufferedOutput) — the durable JSONL file this module also writes
 *  is never capped or pruned (see §3.3/§5). */
export const RING_BUFFER_CAP_BYTES = 256 * 1024;

/**
 * Fires `chunk:<taskId>` with the raw JSONL line (a string) every time
 * appendTaskOutput writes one, for the SSE layer (src/api/server.ts) to
 * subscribe to. A plain node EventEmitter, same idiom Board's own
 * `events` property already uses for board-level events.
 */
export const TASK_OUTPUT_EVENTS = new EventEmitter();
// Many concurrent tasks, each with its own live SSE viewer(s), easily
// exceeds Node's default 10-listener warning threshold — this isn't a
// leak, it's the expected shape of the feature.
TASK_OUTPUT_EVENTS.setMaxListeners(0);

interface RingEntry {
  lines: string[];
  bytes: number;
}

const ringBuffers = new Map<string, RingEntry>();
// Per-taskId write queues so concurrent appendTaskOutput calls for the
// SAME task (fired synchronously, back to back, from a streaming read
// loop that never awaits its onChunk callback) never race each other's
// appendFile calls — each task's writes land on disk in the exact order
// they were appended, one at a time. Different taskIds are fully
// independent and run concurrently.
const writeQueues = new Map<string, Promise<void>>();

function outputPath(taskId: string, dir: string): string {
  return join(dir, `${taskId}.jsonl`);
}

// +1 accounts for the newline every line is eventually joined/written
// with — keeps the ring buffer's accounting consistent with what
// actually lands in the JSONL file.
function lineBytes(line: string): number {
  return Buffer.byteLength(line, "utf8") + 1;
}

function pushToRing(taskId: string, line: string): void {
  let entry = ringBuffers.get(taskId);
  if (!entry) {
    entry = { lines: [], bytes: 0 };
    ringBuffers.set(taskId, entry);
  }
  entry.lines.push(line);
  entry.bytes += lineBytes(line);
  // Always keeps at least the most recent line, even if a single line
  // alone exceeds the cap — a truncated-to-nothing buffer would be
  // strictly worse than one slightly over budget.
  while (entry.bytes > RING_BUFFER_CAP_BYTES && entry.lines.length > 1) {
    const evicted = entry.lines.shift()!;
    entry.bytes -= lineBytes(evicted);
  }
}

/**
 * Appends one line of a task's raw agent output — pushed onto the
 * in-memory ring buffer synchronously (so buffer order is always
 * correct regardless of how the durable write below is scheduled), then
 * queued for a durable, ordered append to
 * `<dir>/<taskId>.jsonl` (default `~/.wissel/task-output`, created
 * lazily — same pattern as writeMemoryLessons/createTaskWorktree), and
 * finally emitted on TASK_OUTPUT_EVENTS for any live SSE listener.
 *
 * `line` is JSON.stringify'd here — callers (the executors' onChunk)
 * pass the already-parsed JSONL object straight through, matching
 * CommandRunner's own `onChunk?: (line: unknown) => void` contract.
 *
 * Never throws: a disk write failure is logged, not propagated, since
 * this is always called from a fire-and-forget position inside a
 * subprocess's synchronous onChunk callback (see
 * docs/SDD-live-task-output.md §3.2) — a full disk must never fail the
 * task run it's merely observing.
 */
export function appendTaskOutput(taskId: string, line: unknown, dir: string = DEFAULT_TASK_OUTPUT_DIR): Promise<void> {
  const text = JSON.stringify(line);
  pushToRing(taskId, text);
  TASK_OUTPUT_EVENTS.emit(`chunk:${taskId}`, text);

  const path = outputPath(taskId, dir);
  const prior = writeQueues.get(taskId) ?? Promise.resolve();
  const next = prior
    .catch(() => {}) // a prior write's failure must never block this one
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text + "\n");
    })
    .catch((e) => {
      console.error(`task-output: failed to persist line for task ${taskId}: ${(e as Error).message}`);
    });
  writeQueues.set(taskId, next);
  return next;
}

/**
 * Recent, in-memory-only scrollback for a task — bounded by
 * RING_BUFFER_CAP_BYTES, lost on process restart. Used to give a
 * freshly-connecting SSE client immediate backlog instead of a blank
 * pane until the next new line arrives (see the `/tasks/:id/output/stream`
 * handler in src/api/server.ts). Empty array (never an error) for a
 * task with no buffered output, whether because nothing has run yet or
 * because the process restarted since.
 */
export function getBufferedOutput(taskId: string): string[] {
  return ringBuffers.get(taskId)?.lines.slice() ?? [];
}

/**
 * Full durable history for a task, oldest first — reads the JSONL file,
 * NOT the (capped, in-memory-only) ring buffer, so a long-running or
 * already-finished task's output is never silently truncated the way
 * the ring buffer alone would be (see docs/SDD-live-task-output.md
 * §3.3). Empty array (never an error) when nothing has been recorded
 * yet for this taskId.
 */
export async function getTaskOutput(taskId: string, dir: string = DEFAULT_TASK_OUTPUT_DIR): Promise<string[]> {
  try {
    const content = await readFile(outputPath(taskId, dir), "utf8");
    return content.split("\n").filter((line) => line.trim() !== "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
