// What the command palette offers (docs/SDD-wissel-app.md §3.1): jump
// to a screen, open a card by title, run a pipeline by name, New card.
// Pure: Palette.tsx filters these with fuzzyFilter and runs the chosen
// one's action.

import { fuzzyFilter } from "./fuzzy";
import { SCREENS, routeHash } from "./routes";
import type { PipelineDef, TaskCard } from "./types";

export type CommandAction =
  | { kind: "go"; hash: string }
  | { kind: "open-url"; url: string }
  | { kind: "run-pipeline"; pipelineId: string; name: string };

export interface Command {
  id: string;
  /** What the palette shows and matches against. */
  label: string;
  /** Small text after the label: the group, a status. */
  hint: string;
  action: CommandAction;
}

/** Cards worth opening: not archived, not superseded. */
function openable(t: TaskCard): boolean {
  return !t.archivedAt && !t.supersededBy;
}

export function buildCommands(input: { tasks: readonly TaskCard[]; pipelines: readonly PipelineDef[] }): Command[] {
  const screens: Command[] = SCREENS.map((s) => ({
    id: `screen:${s.id}`,
    label: s.label,
    hint: "Go to",
    action: { kind: "go", hash: routeHash({ screen: s.id }) },
  }));
  const newCard: Command = {
    id: "new-card",
    label: "New card",
    hint: "Opens the board",
    action: { kind: "open-url", url: "/board#/new" },
  };
  const fullBoard: Command = {
    id: "full-board",
    label: "Open full board",
    hint: "/board",
    action: { kind: "open-url", url: "/board" },
  };
  const pipelines: Command[] = input.pipelines.map((p) => ({
    id: `pipeline:${p.id}`,
    label: `Run ${p.name}`,
    hint: "Pipeline",
    action: { kind: "run-pipeline", pipelineId: p.id, name: p.name },
  }));
  const cards: Command[] = input.tasks.filter(openable).map((t) => ({
    id: `task:${t.id}`,
    label: t.title || t.id.slice(0, 8),
    hint: t.status,
    action: { kind: "go", hash: routeHash({ screen: "board", taskId: t.id }) },
  }));
  return [...screens, newCard, fullBoard, ...pipelines, ...cards];
}

/** At most `limit` matches, best first. With no query, the screens and
 *  actions come first (in buildCommands order), then pipelines, then
 *  cards. */
export function matchCommands(query: string, commands: readonly Command[], limit = 12): Command[] {
  return fuzzyFilter(query, commands, (c) => c.label).slice(0, limit);
}

/** ⌘K on a Mac, Ctrl-K elsewhere; either works anywhere, since people
 *  plug Mac keyboards into Linux boxes and the other way round. */
export function isPaletteShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** The hint the rail shows: ⌘K on Apple devices, Ctrl K elsewhere. */
export function shortcutLabel(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K";
}
