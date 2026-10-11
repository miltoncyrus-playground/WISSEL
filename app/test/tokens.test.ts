import { describe, expect, test } from "vitest";
import { COLORS, DARK_COLORS, TEXT_PAIRS, contrastRatio, relativeLuminance, tokensToCss } from "../src/tokens";

describe("design tokens (SDD §3.1)", () => {
  test("light set is exactly the spec's colours", () => {
    expect(COLORS).toEqual({
      ground: "#FFFFFF",
      surface: "#F6F9F7",
      "surface-2": "#F0F5F2",
      line: "#D5DDD8",
      text: "#0F1411",
      muted: "#566058",
      accent: "#1A7E4C",
      violet: "#4E65DA",
      coral: "#B15425",
    });
  });

  test("dark set has the same names as the light set and is exactly the spec's colours", () => {
    expect(Object.keys(DARK_COLORS).sort()).toEqual(Object.keys(COLORS).sort());
    expect(DARK_COLORS).toEqual({
      ground: "#0D110E",
      surface: "#141B16",
      "surface-2": "#1A241E",
      line: "#25302A",
      text: "#F0F4F1",
      muted: "#98A39B",
      accent: "#2ED38C",
      violet: "#A5B4FC",
      coral: "#FB923C",
    });
  });

  describe.each([
    ["light", COLORS],
    ["dark", DARK_COLORS],
  ] as const)("%s set", (_name, set) => {
    test.each(TEXT_PAIRS.map(([fg, bg]) => [fg, bg]))("%s text on %s meets 4.5:1", (fg, bg) => {
      const ratio = contrastRatio(set[fg as keyof typeof COLORS], set[bg as keyof typeof COLORS]);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    test("the hairline is visible against every surface (at least 1.1:1)", () => {
      for (const bg of ["ground", "surface", "surface-2"] as const) expect(contrastRatio(set.line, set[bg])).toBeGreaterThanOrEqual(1.1);
    });
  });

  test("covers every text colour on every background it is drawn on", () => {
    const pairs = new Set(TEXT_PAIRS.map(([fg, bg]) => `${fg}/${bg}`));
    for (const fg of ["text", "muted", "accent", "violet", "coral"]) {
      for (const bg of ["ground", "surface", "surface-2"]) expect(pairs.has(`${fg}/${bg}`)).toBe(true);
    }
  });

  test("tokensToCss writes the light set on :root and the dark set under prefers-color-scheme", () => {
    const css = tokensToCss();
    const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
    expect(dark).toBeDefined();
    for (const [name, value] of Object.entries(COLORS)) expect(light).toContain(`--${name}: ${value};`);
    for (const [name, value] of Object.entries(DARK_COLORS)) expect(dark).toContain(`--${name}: ${value};`);
    expect(light).toContain("color-scheme: light;");
    expect(dark).toContain("color-scheme: dark;");
    expect(css).toContain("--font-display:");
    expect(css).toContain("--font-body:");
    expect(css).toContain("--font-mono:");
  });

  test("dark tokens never appear outside the media block (no colour defined only in one theme)", () => {
    const [light] = tokensToCss().split("@media");
    for (const value of Object.values(DARK_COLORS)) expect(light).not.toContain(value);
  });
});

describe("contrast maths (WCAG 2.x)", () => {
  test("black on white is 21:1 and order does not matter", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
  });

  test("same colour is 1:1", () => {
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });

  test("a known reference pair: #767676 on white is about 4.54:1", () => {
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });

  test("luminance of white and black", () => {
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
  });

  test("rejects anything that is not #RRGGBB", () => {
    expect(() => relativeLuminance("#FFF")).toThrow();
    expect(() => relativeLuminance("red")).toThrow();
  });
});
