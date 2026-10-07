// The board's theme (src/api/public/board.html): `data-theme="light"` or
// `"dark"` on <html> is an explicit choice from Settings; no attribute
// means Auto, which follows the OS. The editor's CSS reads the board's
// colour tokens directly, so this only picks React Flow's `colorMode`
// for the few defaults the tokens don't override. Pure, so bun test
// covers it (test/pipeline-editor-templates.test.ts).
export type ColorMode = "light" | "dark";

export function colorModeFor(dataTheme: string | undefined, prefersDark: boolean): ColorMode {
  if (dataTheme === "light" || dataTheme === "dark") return dataTheme;
  return prefersDark ? "dark" : "light";
}
