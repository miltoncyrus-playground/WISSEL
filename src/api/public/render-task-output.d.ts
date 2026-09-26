// Type declaration for render-task-output.js — a plain browser script
// (no build step, see its own header comment) that's also imported
// directly by bun test. Kept in sync by hand; the .js file is the
// source of truth for behavior.
export interface TaskOutputRow {
  kind: "text" | "thinking" | "tool-use" | "tool-result" | "result" | "raw";
  text: string;
  ok?: boolean;
}

export function renderTaskOutputRows(rawLines: unknown[]): TaskOutputRow[];
