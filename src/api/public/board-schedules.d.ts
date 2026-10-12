// Type declaration for board-schedules.js, a plain browser script (no
// build step, see its own header comment) that's also imported directly
// by bun test. Kept in sync by hand; the .js file is the source of truth
// for behavior.
import type { PipelineDef, ScheduleDef, ScheduleTaskTemplate, TaskCard } from "../../core/types.ts";

export type ScheduleMode = "daily" | "weekdays" | "weekly" | "hours" | "custom";

export interface SchedulePicker {
  mode: Exclude<ScheduleMode, "custom">;
  /** "HH:MM"; for "hours" only the minutes count. */
  time: string;
  /** 0-6, Sunday = 0; "weekly" only. */
  days: number[];
  /** 1-23; "hours" only. */
  everyHours: number;
}

/** A schedule as GET /schedules lists it. */
export type ListedSchedule = ScheduleDef & { cadence?: string; lastRunStatus?: TaskCard["status"] | null };

export interface SchedulePreview {
  valid: boolean;
  error?: string;
  cadence: string;
  next: string[];
}

export interface ScheduleRow<S extends ListedSchedule> {
  schedule: S;
  target: string;
  cadence: string;
  timezone: string;
  next: string;
  last: { when: string; outcome: string; runId: string | null; runStatus: TaskCard["status"] | null } | null;
  enabled: boolean;
}

export interface ScheduleDraft {
  kind: ScheduleDef["kind"];
  name: string;
  pipelineId?: string;
  input?: string;
  repo?: string;
  title?: string;
  body?: string;
  template?: Partial<ScheduleTaskTemplate>;
  cron: string;
  timezone: string;
  catchUpHours?: string | number | null;
}

type StartCard = Partial<Pick<TaskCard, "notBefore" | "archivedAt" | "pipelineId" | "routedTo">> & Pick<TaskCard, "status">;

export const SCHEDULE_DAYS: { day: number; label: string }[];
export const SCHEDULE_MODES: { mode: ScheduleMode; label: string }[];

export function buildCron(picker: Partial<SchedulePicker> | null | undefined): { ok: true; cron: string } | { ok: false; error: string };
export function parseCron(cron: string | null | undefined): SchedulePicker | null;

export function localDateTimeToIso(value: string | null | undefined, timeZone: string): string | null;
export function isoToLocalDateTime(iso: string, timeZone: string): string;
export function formatWhen(iso: string, now: Date, timeZone: string): string;

export function canHaveStartTime(task: StartCard | null | undefined): boolean;
export function startsChipText(task: StartCard | null | undefined, now: Date, timeZone: string): string | null;

export function scheduleRows<S extends ListedSchedule>(
  schedules: S[] | null | undefined,
  pipelines: Pick<PipelineDef, "id" | "name">[] | null | undefined,
  now: Date,
  timeZone: string,
): ScheduleRow<S>[];

export function nextRunsByPipeline<S extends ListedSchedule>(schedules: S[] | null | undefined): Record<string, S>;

export function previewView(
  preview: SchedulePreview | null | undefined,
  now: Date,
  timeZone: string,
  count?: number,
): { valid: boolean; error: string | null; cadence: string; lines: string[] };

export function defaultScheduleName(targetName: string, cadence: string): string;

export function scheduleBody(
  draft: Partial<ScheduleDraft> | null | undefined,
  mode: "create" | "edit",
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string };
