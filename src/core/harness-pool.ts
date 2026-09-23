import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { discoverApiKeyHarnesses, discoverCodexHarnesses, discoverHarnesses, validateHarness, type DiscoverHarnessesOptions } from "./harness-discovery.ts";
import type { Harness, HarnessTool } from "./types.ts";

/** Thrown by `HarnessPool.acquire` when a caller passes an explicit
 *  `harnessId` (a `TaskCard.harnessOverride`, not the normal automatic
 *  pick) that can't actually be honored — unknown id, disabled, or a
 *  tool mismatch. Distinct on purpose from `acquire()`'s existing
 *  `undefined` return for "no enabled harness for this tool at all,"
 *  which stays silently-tolerant by design (see the doc comment next to
 *  CostProfile in types.ts): an explicit override failing is a loud
 *  error, an empty pool with no override is not. */
export class HarnessOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessOverrideError";
  }
}

/**
 * Loads and selects from the harness manifest — mirrors Registry's shape
 * deliberately (load/from/all/get), since it's the same kind of static,
 * re-read-on-start descriptor list, just on a different axis (which
 * credentialed process runs work, not what kind of work it is).
 */
export class HarnessPool {
  private harnesses = new Map<string, Harness>();
  /** In-process in-flight count per harness id — what `acquire()`
   *  balances against and the source of truth for "is this harness
   *  active right now." Only meaningful within one wissel process,
   *  which matches the rest of wissel's in-memory state (Orchestrator's
   *  own `inFlight` set is the same shape, same scope). */
  private inFlight = new Map<string, number>();

  static async load(path = "harnesses.yaml"): Promise<HarnessPool> {
    const raw = await readFile(path, "utf8");
    const parsed = parse(raw) as { harnesses: Harness[] };
    return HarnessPool.from(parsed.harnesses ?? []);
  }

  /** The real startup path: auto-detects every already-authenticated
   *  account on this machine (see harness-discovery.ts) and layers
   *  `harnesses.yaml` on top — a manual entry wins on id collision
   *  (lets you rename/disable/pin what was auto-detected), and a
   *  manual-only entry (no matching discovered account, e.g. a future
   *  non-claude-cli tool discovery can't probe) is kept as-is. A missing
   *  `harnesses.yaml` is not an error here — unlike `load()`, which
   *  throws — since discovery alone is a complete, valid starting
   *  point; the file only ever adds overrides.
   *
   *  Every manual entry is re-verified the same way a discovered one is
   *  (`validateHarness`) before being layered in — `harnesses.yaml` is
   *  checked into git and can easily describe a different machine (a
   *  teammate's config path, an account that's since logged out); a
   *  manual entry that fails verification is kept but reported
   *  `enabled: false` rather than trusted at face value. */
  static async autoload(path = "harnesses.yaml", discoverOpts: DiscoverHarnessesOptions = {}): Promise<HarnessPool> {
    const manual = await HarnessPool.load(path).then(
      (pool) => pool.all(),
      () => [] as Harness[],
    );
    const [discoveredCli, discoveredCodex, validatedManual] = await Promise.all([
      discoverHarnesses(discoverOpts),
      discoverCodexHarnesses(discoverOpts),
      Promise.all(manual.map((h) => validateHarness(h, discoverOpts))),
    ]);
    const discoveredApiKeys = discoverApiKeyHarnesses(discoverOpts);

    const byId = new Map<string, Harness>();
    for (const h of [...discoveredCli, ...discoveredCodex, ...discoveredApiKeys]) byId.set(h.id, h);
    for (const h of validatedManual) byId.set(h.id, h);
    return HarnessPool.from([...byId.values()]);
  }

  /** Builds a pool directly from a list — the manifest loader's own path,
   *  minus the file read. Used by tests that need a real HarnessPool
   *  without a harnesses.yaml on disk. */
  static from(harnesses: Harness[]): HarnessPool {
    const pool = new HarnessPool();
    for (const harness of harnesses) {
      if (pool.harnesses.has(harness.id)) {
        throw new Error(`duplicate harness id: ${harness.id}`);
      }
      pool.harnesses.set(harness.id, harness);
    }
    return pool;
  }

  all(): Harness[] {
    return [...this.harnesses.values()];
  }

  get(id: string): Harness | undefined {
    return this.harnesses.get(id);
  }

  /** Current in-flight task count for a harness — 0 if it's never been
   *  acquired. Exposed so callers (the `/harnesses` endpoint) can report
   *  live load without duplicating this bookkeeping. */
  activeCount(id: string): number {
    return this.inFlight.get(id) ?? 0;
  }

  /** Picks the least-loaded enabled harness for a tool (ties broken by
   *  manifest order) and marks it in-flight until `release()` is called.
   *  Returns undefined when no enabled harness exists for the tool —
   *  callers fall back to running with no harness at all, identical to
   *  wissel's behavior before harnesses existed (whatever `claude` is on
   *  PATH, under the ambient environment).
   *
   *  `harnessId`, when given, is a forced pick (`TaskCard.harnessOverride`)
   *  rather than the automatic least-loaded selection above: looks the id
   *  up directly and **throws** `HarnessOverrideError` if it's unknown,
   *  disabled, or belongs to a different tool than `tool` — never falls
   *  back to the automatic pick, since a human/API asked for this exact
   *  harness by name. Omitted entirely (the normal case), behavior is
   *  byte-identical to before this parameter existed. */
  acquire(tool: HarnessTool, harnessId?: string): Harness | undefined {
    if (harnessId !== undefined) {
      const harness = this.harnesses.get(harnessId);
      if (!harness) throw new HarnessOverrideError(`unknown harness id "${harnessId}"`);
      if (!harness.enabled) throw new HarnessOverrideError(`harness "${harnessId}" is disabled`);
      if (harness.tool !== tool) throw new HarnessOverrideError(`harness "${harnessId}" is a ${harness.tool} harness, not ${tool}`);
      this.inFlight.set(harness.id, this.activeCount(harness.id) + 1);
      return harness;
    }
    const candidates = this.all().filter((h) => h.enabled && h.tool === tool);
    if (candidates.length === 0) return undefined;
    const picked = candidates.reduce((best, h) => (this.activeCount(h.id) < this.activeCount(best.id) ? h : best));
    this.inFlight.set(picked.id, this.activeCount(picked.id) + 1);
    return picked;
  }

  release(id: string): void {
    const n = this.activeCount(id);
    if (n <= 1) this.inFlight.delete(id);
    else this.inFlight.set(id, n - 1);
  }

  /** Mutates the live pool's copy of a harness in place — the in-memory
   *  half of a human enable/disable decision (the other half,
   *  persisting to harnesses.yaml, is `setHarnessEnabled` in
   *  harness-manifest.ts — always done first by the caller, so a failed
   *  disk write never leaves memory and disk disagreeing about which
   *  one's the truth). Returns undefined, changing nothing, for an
   *  unknown id. Doesn't touch `inFlight`: disabling an already-acquired
   *  harness never interrupts whatever's currently running under it —
   *  `acquire()` only consults `enabled` for the *next* pick. See
   *  docs/SDD-harness-enable-disable.md §7. */
  setEnabled(id: string, enabled: boolean, disabledReason?: string): Harness | undefined {
    const existing = this.harnesses.get(id);
    if (!existing) return undefined;
    const updated: Harness = { ...existing, enabled, disabledReason };
    this.harnesses.set(id, updated);
    return updated;
  }

  /** Mutates the live pool's copy of a harness's default model in place
   *  — the in-memory half of a human's model-selection decision, same
   *  shape as `setEnabled` above (the disk half is `setHarnessModel` in
   *  harness-manifest.ts, always done first by the caller). Returns
   *  undefined, changing nothing, for an unknown id. `model: undefined`
   *  clears a previously-set override, matching Harness.model's own
   *  "undefined means no override" contract. */
  setModel(id: string, model: string | undefined): Harness | undefined {
    const existing = this.harnesses.get(id);
    if (!existing) return undefined;
    const updated: Harness = { ...existing, model };
    this.harnesses.set(id, updated);
    return updated;
  }
}
