import { describe, expect, test } from "vitest";
import { COLORS, TEXT_PAIRS, contrastRatio, relativeLuminance, tokensToCss } from "../src/tokens";

describe("design tokens (SDD §3.1)", () => {
  test("are exactly the spec's colours", () => {
    expect(COLORS).toEqual({
      ground: "#0D0E12",
      surface: "#17191F",
      "surface-2": "#1F222A",
      line: "#2A2D36",
      text: "#F3F1EA",
      muted: "#A3A6B0",
      accent: "#C8F25A",
      violet: "#9C8CFF",
      coral: "#FF8A5C",
    });
  });

  test.each(TEXT_PAIRS.map(([fg, bg]) => [fg, bg]))("%s text on %s meets 4.5:1", (fg, bg) => {
    const ratio = contrastRatio(COLORS[fg as keyof typeof COLORS], COLORS[bg as keyof typeof COLORS]);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("covers every text colour on every background it is drawn on", () => {
    const pairs = new Set(TEXT_PAIRS.map(([fg, bg]) => `${fg}/${bg}`));
    for (const fg of ["text", "muted", "accent", "violet", "coral"]) {
      for (const bg of ["ground", "surface", "surface-2"]) expect(pairs.has(`${fg}/${bg}`)).toBe(true);
    }
  });

  test("tokensToCss writes every token as a custom property", () => {
    const css = tokensToCss();
    for (const [name, value] of Object.entries(COLORS)) expect(css).toContain(`--${name}: ${value};`);
    expect(css).toContain("--font-display:");
    expect(css).toContain("--font-body:");
    expect(css).toContain("--font-mono:");
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
