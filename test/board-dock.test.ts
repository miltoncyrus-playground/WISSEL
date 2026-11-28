import { describe, expect, test } from "bun:test";
import { DOCK_STORAGE_KEY, dockSrc, readDockState, workstreamOfHash, writeDockState } from "../src/api/public/board-dock.js";

// docs/SDD-coordinator.md §4.14: the coordinator window docked beside the
// board, as the app's window in embed mode.

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("the coordinator dock", () => {
  test("it shows the app's window in embed mode", () => {
    expect(dockSrc()).toBe("/app?embed=1#/coordinator");
    expect(dockSrc("ws 1")).toBe("/app?embed=1#/coordinator/ws%201");
  });

  test("open and the last window are remembered; bad or missing storage starts closed", () => {
    const s = memory();
    expect(readDockState(s)).toEqual({ open: false });
    writeDockState(s, { open: true, workstreamId: "ws1" });
    expect(s.m.get(DOCK_STORAGE_KEY)).toBe('{"open":true,"workstreamId":"ws1"}');
    expect(readDockState(s)).toEqual({ open: true, workstreamId: "ws1" });
    s.m.set(DOCK_STORAGE_KEY, "{not json");
    expect(readDockState(s)).toEqual({ open: false });
    expect(readDockState(undefined)).toEqual({ open: false });
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readDockState(throwing)).toEqual({ open: false });
    expect(() => writeDockState(throwing, { open: true })).not.toThrow();
  });

  test("it follows the window opened inside it", () => {
    expect(workstreamOfHash("#/coordinator/ws%201")).toBe("ws 1");
    expect(workstreamOfHash("#/coordinator")).toBeUndefined();
    expect(workstreamOfHash("#/board/abc")).toBeUndefined();
    expect(workstreamOfHash("#/coordinator/%E0%A4%A")).toBeUndefined();
  });
});
