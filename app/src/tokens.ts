// Design tokens (docs/SDD-wissel-app.md §3.1). The one source for the
// app's colours and fonts: main.tsx turns them into CSS custom
// properties (tokensToCss) and every stylesheet reads var(--name).
// test/tokens.test.ts checks every text pair below meets WCAG AA.

/** The light set: the default. News-site white with one green. */
export const COLORS = {
  ground: "#FFFFFF",
  surface: "#F6F9F7",
  "surface-2": "#F0F5F2",
  line: "#D5DDD8",
  text: "#0F1411",
  muted: "#566058",
  /** Primary actions, the active tab, focus rings. */
  accent: "#1A7E4C",
  /** You, and anything running. */
  violet: "#4E65DA",
  /** Needs you. */
  coral: "#B15425",
} as const;

/** The dark set, for `prefers-color-scheme: dark`. Same names. */
export const DARK_COLORS: Record<keyof typeof COLORS, string> = {
  ground: "#0D110E",
  surface: "#141B16",
  "surface-2": "#1A241E",
  line: "#25302A",
  text: "#F0F4F1",
  muted: "#98A39B",
  accent: "#2ED38C",
  violet: "#A5B4FC",
  coral: "#FB923C",
};

export type ColorToken = keyof typeof COLORS;

export const FONTS = {
  display: 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif',
  body: 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Every foreground/background pair the app draws text with, checked in
 *  both colour sets. Text on a green, indigo or orange fill uses `ground`. */
export const TEXT_PAIRS: ReadonlyArray<readonly [fg: ColorToken, bg: ColorToken]> = [
  ["text", "ground"],
  ["text", "surface"],
  ["text", "surface-2"],
  ["muted", "ground"],
  ["muted", "surface"],
  ["muted", "surface-2"],
  ["accent", "ground"],
  ["accent", "surface"],
  ["accent", "surface-2"],
  ["violet", "ground"],
  ["violet", "surface"],
  ["violet", "surface-2"],
  ["coral", "ground"],
  ["coral", "surface"],
  ["coral", "surface-2"],
  ["ground", "accent"],
  ["ground", "violet"],
  ["ground", "coral"],
];

/** WCAG 2.x relative luminance of a `#RRGGBB` colour. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/** WCAG contrast ratio, 1 to 21, order independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** One colour set as custom-property lines. */
function colorLines(set: Record<string, string>, indent: string): string[] {
  return Object.entries(set).map(([name, value]) => `${indent}--${name}: ${value};`);
}

/** The CSS custom properties: the light set on `:root`, the dark set
 *  under `prefers-color-scheme: dark`, and `--font-display`,
 *  `--font-body`, `--font-mono`. */
export function tokensToCss(): string {
  const fonts = Object.entries(FONTS).map(([name, value]) => `  --font-${name}: ${value};`);
  return [
    ":root {",
    "  color-scheme: light;",
    ...colorLines(COLORS, "  "),
    ...fonts,
    "}",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    "    color-scheme: dark;",
    ...colorLines(DARK_COLORS, "    "),
    "  }",
    "}",
    "",
  ].join("\n");
}
