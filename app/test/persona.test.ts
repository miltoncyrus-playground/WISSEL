import { describe, expect, test } from "vitest";
import { chipsOf } from "../src/ask";
import { AVATAR_PALETTE, derivedGlyph, hashId, inkFor, personaOf, workingAgents } from "../src/persona";
import { COLORS, contrastRatio } from "../src/tokens";
import type { TaskCard } from "../src/types";

// docs/SDD-wissel-app.md §3.6: agent faces.

const MANIFEST_IDS = [
  "triager", "planner", "reviewer", "pipeline-reviewer", "mcp-tool-caller", "ai-news-gatherer", "world-news-gatherer",
  "ai-news-explainer", "world-news-explainer", "podcast-scriptwriter", "podcast-audio", "wissel-digest", "wissel-retro-analyst",
  "repo-briefer", "memory-curator", "concierge", "implementer", "fixer", "integrator", "commit-message-drafter",
  "pr-description-writer", "changelog-writer", "quick-answer", "lint-fixer",
];

describe("the palette", () => {
  test.each([...AVATAR_PALETTE])("%s takes a ground glyph at 4.5:1 and stands out from every surface at 3:1", (color) => {
    expect(contrastRatio(color, COLORS.ground)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [COLORS.ground, COLORS.surface, COLORS["surface-2"]]) expect(contrastRatio(color, bg)).toBeGreaterThanOrEqual(3);
    expect(inkFor(color)).toBe(COLORS.ground);
  });

  test("has no repeats and starts with the accent tokens", () => {
    expect(new Set(AVATAR_PALETTE.map((c) => c.toUpperCase())).size).toBe(AVATAR_PALETTE.length);
    expect(AVATAR_PALETTE.slice(0, 3)).toEqual([COLORS.accent, COLORS.violet, COLORS.coral]);
  });
});

describe("derived faces", () => {
  test("hashId is FNV-1a: stable, 32-bit, different for near ids", () => {
    expect(hashId("")).toBe(0x811c9dc5);
    expect(hashId("a")).toBe(0xe40c292c);
    expect(hashId("implementer")).toBe(hashId("implementer"));
    expect(hashId("fixer")).not.toBe(hashId("fixes"));
    for (const id of MANIFEST_IDS) expect(hashId(id)).toBeLessThan(2 ** 32);
  });

  test("glyph: first letters of the first two words, else the first two letters", () => {
    expect(derivedGlyph("podcast-scriptwriter")).toBe("PS");
    expect(derivedGlyph("ai-news-gatherer")).toBe("AN");
    expect(derivedGlyph("pr_description writer")).toBe("PD");
    expect(derivedGlyph("triager")).toBe("Tr");
    expect(derivedGlyph("x")).toBe("X");
    expect(derivedGlyph("élan")).toBe("Él");
    expect(derivedGlyph("--")).toBe("?");
    expect(derivedGlyph("")).toBe("?");
  });

  test("every manifest agent gets a palette colour and a one or two letter glyph, the same each time", () => {
    for (const id of MANIFEST_IDS) {
      const p = personaOf(id);
      expect(AVATAR_PALETTE).toContain(p.color);
      expect([...p.glyph].length).toBeGreaterThanOrEqual(1);
      expect([...p.glyph].length).toBeLessThanOrEqual(2);
      expect(personaOf(id)).toEqual(p);
    }
    // Spread: the 24 agents use most of the palette, not one colour.
    expect(new Set(MANIFEST_IDS.map((id) => personaOf(id).color)).size).toBeGreaterThanOrEqual(6);
  });
});

describe("manifest personas", () => {
  test("the manifest's colour and glyph win; what it leaves out is derived", () => {
    expect(personaOf("implementer", { color: "#c8f25a", glyph: "Im" })).toEqual({ color: "#C8F25A", glyph: "Im", ink: COLORS.ground });
    expect(personaOf("triager", { glyph: "🦉" })).toEqual({ ...personaOf("triager"), glyph: "🦉" });
    expect(personaOf("triager", { color: "#FFC857" })).toEqual({ color: "#FFC857", glyph: "Tr", ink: COLORS.ground });
  });

  test("a malformed colour or glyph falls back to the derived one", () => {
    const derived = personaOf("triager");
    expect(personaOf("triager", { color: "red", glyph: "Three" })).toEqual(derived);
    expect(personaOf("triager", { glyph: "  " })).toEqual(derived);
  });

  test("a dark manifest colour gets a light glyph that reads", () => {
    const p = personaOf("x", { color: "#203040" });
    expect(p.ink).toBe(COLORS.text);
    expect(contrastRatio(p.color, p.ink)).toBeGreaterThanOrEqual(4.5);
  });
});

function card(over: Partial<TaskCard>): TaskCard {
  return { id: "t", title: "T", body: "", labels: [], status: "inbox", ...over };
}

describe("working", () => {
  test("an agent is working while one of its cards is running or dispatched", () => {
    const tasks = [
      card({ id: "1", status: "running", routedTo: "implementer" }),
      card({ id: "2", status: "dispatched", routedTo: "reviewer" }),
      card({ id: "3", status: "done", routedTo: "planner" }),
      card({ id: "4", status: "running" }),
      card({ id: "5", status: "running", routedTo: "fixer", archivedAt: "2026-10-10T00:00:00Z" }),
      card({ id: "6", status: "running", routedTo: "implementer" }),
    ];
    expect([...workingAgents(tasks)].sort()).toEqual(["implementer", "reviewer"]);
  });

  test("an Ask chip carries the card's agent for its face", () => {
    const tasks = [card({ id: "a", status: "running", routedTo: "implementer" }), card({ id: "b", status: "inbox" })];
    const chips = chipsOf(
      {
        actions: [
          { type: "create_task", ok: true, taskId: "a", title: "A" },
          { type: "create_task", ok: true, taskId: "b", title: "B" },
        ],
      },
      tasks,
    );
    expect(chips.map((c) => [c.taskId, c.agentId, c.tone])).toEqual([
      ["a", "implementer", "running"],
      ["b", undefined, "queued"],
    ]);
  });
});
