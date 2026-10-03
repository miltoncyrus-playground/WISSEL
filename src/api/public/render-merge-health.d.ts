// Type declaration for render-merge-health.js — a plain browser script
// (no build step, see its own header comment) that's also imported
// directly by bun test. Kept in sync by hand; the .js file is the
// source of truth for behavior.
export interface DanglingMerge {
  repo: string;
  branch: string;
}

export function formatMergeHealthBanner(mergeHealth: DanglingMerge[] | undefined): string | null;
