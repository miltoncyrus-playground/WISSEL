// Design tokens (docs/SDD-wissel-app.md §3.1). The one source for the
// app's colours and fonts: main.tsx turns them into CSS custom
// properties (tokensToCss) and every stylesheet reads var(--name).
// test/tokens.test.ts checks every text pair below meets WCAG AA.

export const COLORS = {
  ground: "#0D0E12",
  surface: "#17191F",
  "surface-2": "#1F222A",
  line: "#2A2D36",
  text: "#F3F1EA",
  muted: "#A3A6B0",
  /** Primary actions, the active tab, focus rings. */
  accent: "#C8F25A",
  /** You, and anything running. */
  violet: "#9C8CFF",
  /** Needs you. */
  coral: "#FF8A5C",
} as const;

export type ColorToken = keyof typeof COLORS;

export const FONTS = {
  display: '"Bricolage Grotesque", system-ui, sans-serif',
  body: 'Geist, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Every foreground/background pair the app draws text with. Text on a
 *  lime, violet or coral fill uses `ground`. */
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

/** The `:root` block of CSS custom properties: `--ground`, ...,
 *  `--font-display`, `--font-body`, `--font-mono`. */
export function tokensToCss(): string {
  const lines = [
    ...Object.entries(COLORS).map(([name, value]) => `  --${name}: ${value};`),
    ...Object.entries(FONTS).map(([name, value]) => `  --font-${name}: ${value};`),
  ];
  return `:root {\n  color-scheme: dark;\n${lines.join("\n")}\n}\n`;
}
