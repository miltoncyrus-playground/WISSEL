#!/usr/bin/env bun
/**
 * Creates the two morning podcast schedules, "AI news podcast" and "World
 * news podcast", DISABLED (docs/SDD-schedules.md §7 step 1), on the board
 * database the server uses (`WISSEL_DB_PATH`, default
 * `~/.wissel/board.sqlite`). Each points at the stored pipeline of the same
 * name, the names ops/systemd/wissel-morning-podcasts.service passes to
 * scripts/run-pipelines.ts.
 *
 * Disabled because the systemd timer still runs the same pipelines at the
 * same time: enabling a schedule before Milton disables the timer would run
 * each podcast twice. Only a person enables them (board, app or Ask), after
 * `systemctl --user disable --now wissel-morning-podcasts.timer`; see
 * ops/systemd/README.md.
 *
 * Keyed by name. A schedule that already exists is left exactly as it is
 * (including `enabled`, cron and timezone a person may have changed), so
 * running this twice changes nothing the second time and it can never
 * enable or duplicate one. A pipeline that isn't stored (or whose name two
 * stored pipelines share) is reported and skipped, and the script exits non-zero (`bun run seed:ai-news` creates
 * the pipelines).
 *
 *   bun run seed:schedules
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScheduleDef } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore, type PipelineStore } from "../src/services/pipelines.ts";
import { SqliteScheduleStore, type ScheduleStore } from "../src/services/schedules.ts";

/** The pipelines the systemd unit runs, in its order. Each schedule has
 *  its pipeline's name. */
export const PODCAST_SCHEDULE_NAMES = ["AI news podcast", "World news podcast"] as const;
/** 06:00 Europe/Madrid, the systemd timer's `OnCalendar`. */
export const PODCAST_CRON = "0 6 * * *";
export const PODCAST_TIMEZONE = "Europe/Madrid";
export const PODCAST_CATCH_UP_HOURS = 12;

export type SeedScheduleResult =
  /** There was none: created, disabled. */
  | { name: string; outcome: "created"; schedule: ScheduleDef }
  /** One with this name already exists: not touched. */
  | { name: string; outcome: "unchanged"; schedule: ScheduleDef }
  /** No stored pipeline has this name, or more than one does (the same
   *  refusal scripts/run-pipelines.ts makes): nothing created. */
  | { name: string; outcome: "missing-pipeline"; matches: number };

/** Seeds every podcast schedule; one result per name, in order. */
export async function seedPodcastSchedules(schedules: ScheduleStore, pipelines: PipelineStore): Promise<SeedScheduleResult[]> {
  const stored = await pipelines.list();
  const results: SeedScheduleResult[] = [];
  for (const name of PODCAST_SCHEDULE_NAMES) {
    const existing = await schedules.getByName(name);
    if (existing) {
      results.push({ name, outcome: "unchanged", schedule: existing });
      continue;
    }
    const matches = stored.filter((p) => p.name === name);
    const pipeline = matches[0];
    if (!pipeline || matches.length > 1) {
      results.push({ name, outcome: "missing-pipeline", matches: matches.length });
      continue;
    }
    const schedule = await schedules.create({
      name,
      kind: "pipeline",
      pipelineId: pipeline.id,
      cron: PODCAST_CRON,
      timezone: PODCAST_TIMEZONE,
      enabled: false,
      catchUpHours: PODCAST_CATCH_UP_HOURS,
    });
    results.push({ name, outcome: "created", schedule });
  }
  return results;
}

/** One line per result, for the CLI. */
export function describeSeedResult(r: SeedScheduleResult, dbPath: string): string {
  if (r.outcome === "missing-pipeline") {
    return r.matches === 0
      ? `No pipeline named "${r.name}" in ${dbPath}; schedule not created. Run \`bun run seed:ai-news\` first.`
      : `${r.matches} pipelines are named "${r.name}" in ${dbPath}; schedule not created. Rename or delete the extra ones first.`;
  }
  const s = r.schedule;
  const state = s.enabled ? "enabled" : "disabled";
  return r.outcome === "created"
    ? `Created schedule "${s.name}" (${s.id}) in ${dbPath}: ${s.cron} ${s.timezone}, catchUpHours ${s.catchUpHours}, disabled.`
    : `Schedule "${s.name}" (${s.id}) in ${dbPath} already exists (${s.cron} ${s.timezone}, ${state}); left unchanged.`;
}

if (import.meta.main) {
  const dbPath = process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite");
  const board = new SqliteBoard(dbPath);
  const results = await seedPodcastSchedules(new SqliteScheduleStore(board.db), new SqlitePipelineStore(board.db));
  for (const r of results) console.log(describeSeedResult(r, dbPath));
  if (results.every((r) => r.outcome === "unchanged")) console.log("Nothing to do: both schedules already exist.");
  if (results.some((r) => r.outcome === "created")) {
    console.log("The new schedules are disabled. Enable them only after `systemctl --user disable --now wissel-morning-podcasts.timer` (ops/systemd/README.md).");
  }
  if (results.some((r) => r.outcome === "missing-pipeline")) process.exit(1);
}
