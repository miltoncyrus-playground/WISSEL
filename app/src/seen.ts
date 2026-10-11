// Which stories have been watched, kept in localStorage so the rings
// stay grey across reloads. Storage can be missing or full (private
// mode): then nothing is remembered and nothing breaks.

import type { SeenMap } from "./stories";

const KEY = "wissel.app.storiesSeen";

export function loadSeen(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): SeenMap {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SeenMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k as keyof SeenMap] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSeen(seen: SeenMap, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(seen));
  } catch {
    // Full or blocked: forget it.
  }
}
