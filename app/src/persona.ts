// Agent faces (docs/SDD-wissel-app.md §3.6), pure. An agent's manifest
// may set `persona: {color, glyph}`; whatever it leaves out is derived
// from the agent id, so the same agent has the same face on every
// screen and every reload. app/test/persona.test.ts checks the palette's
// contrast with the tokens.

import { COLORS, contrastRatio } from "./tokens";
import type { TaskCard } from "./types";

/** Avatar fills for agents with no colour of their own. Each one is
 *  light enough for a `ground` glyph at 4.5:1 and stands out from the
 *  surfaces at 3:1. The first three are the accent tokens. */
export const AVATAR_PALETTE = [
  COLORS.accent,
  COLORS.violet,
  COLORS.coral,
  "#5AD8F2",
  "#FFC857",
  "#F28AC8",
  "#7FE0A8",
  "#B9C4FF",
  "#FFB38A",
  "#E2E86B",
] as const;

export interface ManifestPersona {
  color?: string;
  glyph?: string;
}

export interface Persona {
  /** Avatar fill, `#RRGGBB`. */
  color: string;
  /** One or two characters. */
  glyph: string;
  /** The glyph's colour on that fill: `ground` or `text`. */
  ink: string;
}

/** 32-bit FNV-1a over the id's UTF-16 code units: small, stable, and
 *  spreads short ids that differ by one letter. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Two letters from the id: the first letters of its first two words
 *  (`podcast-scriptwriter` is "PS"), or the first two letters of a
 *  one-word id (`triager` is "Tr"). "?" for an id with no letters. */
export function derivedGlyph(id: string): string {
  const words = id.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const [a = "", b = ""] = [...words[0]!];
    return a.toUpperCase() + b.toLowerCase();
  }
  return ([...words[0]!][0]! + [...words[1]!][0]!).toUpperCase();
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** `ground` on a light fill, `text` on a dark one: whichever reads
 *  better. */
export function inkFor(color: string): string {
  return contrastRatio(color, COLORS.ground) >= contrastRatio(color, COLORS.text) ? COLORS.ground : COLORS.text;
}

/** The agent's face: the manifest's colour and glyph where it set
 *  them (and they are well formed), else derived from the id. */
export function personaOf(agentId: string, manifest?: ManifestPersona): Persona {
  const color = manifest?.color && HEX.test(manifest.color) ? manifest.color.toUpperCase() : AVATAR_PALETTE[hashId(agentId) % AVATAR_PALETTE.length]!;
  const g = manifest?.glyph ? [...manifest.glyph.trim()] : [];
  const glyph = g.length >= 1 && g.length <= 2 ? g.join("") : derivedGlyph(agentId);
  return { color, glyph, ink: inkFor(color) };
}

/** Agents with a card running right now (running or dispatched). */
export function workingAgents(tasks: readonly TaskCard[]): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) {
    if ((t.status === "running" || t.status === "dispatched") && t.routedTo && !t.archivedAt) out.add(t.routedTo);
  }
  return out;
}
