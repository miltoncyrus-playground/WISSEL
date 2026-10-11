import { describe, expect, test } from "vitest";
import { buildCommands, isPaletteShortcut, matchCommands, shortcutLabel } from "../src/commands";
import type { TaskCard } from "../src/types";

const tasks: TaskCard[] = [
  { id: "t1", title: "Check the README", body: "", labels: [], status: "running" },
  { id: "t2", title: "Old attempt", body: "", labels: [], status: "failed", supersededBy: "t1" },
  { id: "t3", title: "Archived thing", body: "", labels: [], status: "done", archivedAt: "2026-10-01T00:00:00Z" },
];
const pipelines = [{ id: "p1", name: "AI news podcast", description: "" }];

describe("buildCommands", () => {
  const commands = buildCommands({ tasks, pipelines });

  test("offers every screen, New card, the full board, each pipeline and each live card", () => {
    expect(commands.map((c) => c.id)).toEqual([
      "screen:feed",
      "screen:ask",
      "screen:board",
      "screen:listen",
      "screen:you",
      "new-card",
      "full-board",
      "pipeline:p1",
      "task:t1",
    ]);
  });

  test("screens jump by hash, cards open on the Board tab", () => {
    expect(commands.find((c) => c.id === "screen:listen")!.action).toEqual({ kind: "go", hash: "#/listen" });
    expect(commands.find((c) => c.id === "task:t1")!.action).toEqual({ kind: "go", hash: "#/board/t1" });
  });

  test("New card opens Ask, which makes cards; pipelines run by id", () => {
    expect(commands.find((c) => c.id === "new-card")!.action).toEqual({ kind: "go", hash: "#/ask" });
    expect(commands.find((c) => c.id === "pipeline:p1")!.action).toEqual({ kind: "run-pipeline", pipelineId: "p1", name: "AI news podcast" });
  });
});

describe("matchCommands", () => {
  const commands = buildCommands({ tasks, pipelines });

  test("finds a card by part of its title", () => {
    expect(matchCommands("readme", commands)[0]!.id).toBe("task:t1");
  });

  test("finds a pipeline by name", () => {
    expect(matchCommands("news", commands)[0]!.id).toBe("pipeline:p1");
  });

  test("finds a screen by a prefix", () => {
    expect(matchCommands("lis", commands)[0]!.id).toBe("screen:listen");
  });

  test("caps the list", () => {
    expect(matchCommands("", commands, 3)).toHaveLength(3);
  });
});

describe("isPaletteShortcut", () => {
  const base = { key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  test("Cmd-K and Ctrl-K open it", () => {
    expect(isPaletteShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, key: "K", ctrlKey: true })).toBe(true);
  });

  test("plain k, other keys and extra modifiers do not", () => {
    expect(isPaletteShortcut(base)).toBe(false);
    expect(isPaletteShortcut({ ...base, key: "j", ctrlKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false);
  });
});

describe("shortcutLabel", () => {
  test("⌘K on Apple, Ctrl K elsewhere", () => {
    expect(shortcutLabel("MacIntel")).toBe("⌘K");
    expect(shortcutLabel("iPhone")).toBe("⌘K");
    expect(shortcutLabel("Linux x86_64")).toBe("Ctrl K");
    expect(shortcutLabel("Win32")).toBe("Ctrl K");
  });
});
