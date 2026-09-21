import { readFile, writeFile } from "node:fs/promises";
import { parseDocument, type YAMLSeq } from "yaml";
import type { Harness } from "./types.ts";

/**
 * Persists a human's enable/disable decision for one harness back to
 * `harnesses.yaml` — the file stays the single source of truth (same
 * "override layer" role it already plays for auto-detected accounts),
 * so the decision survives a restart instead of living only in memory.
 *
 * Uses `yaml`'s `Document` API rather than a plain parse+stringify
 * round-trip specifically so every comment and every other entry come
 * back byte-for-byte untouched — verified live against a
 * `harnesses.yaml`-shaped fixture before this was written (see
 * docs/SDD-harness-enable-disable.md §3/§5), not assumed.
 *
 * A harness that only ever existed via auto-discovery (no prior entry
 * here) gets promoted into an explicit one — its id/tool/label/env
 * copied in — the first time it's toggled; after that it's an override
 * like any hand-written entry, same precedent this file's own header
 * comment already documents for `claude-personal`.
 *
 * `disabledReason` is always cleared here: a human's own enable/disable
 * decision supersedes whatever automatic diagnosis (e.g. "not
 * authenticated") was on the harness before — that field exists to
 * explain a *system*-driven disable, not a chosen one. A failed enable
 * attempt (still not authenticated) never reaches this function at all
 * — the caller refuses before persisting anything (see
 * `checkHarnessAuth` and the `/harnesses/:id/enable` handler).
 *
 * A missing file starts from an empty `harnesses: []` document — same
 * "no manifest is a valid starting point" contract `HarnessPool.autoload()`
 * already has for reads.
 */
export async function setHarnessEnabled(path: string, harness: Harness, enabled: boolean): Promise<void> {
  const raw = await readFile(path, "utf8").catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "harnesses: []\n";
    throw e;
  });

  const doc = parseDocument(raw);
  let seq = doc.getIn(["harnesses"]) as YAMLSeq | undefined;
  if (!seq) {
    doc.setIn(["harnesses"], []);
    seq = doc.getIn(["harnesses"]) as YAMLSeq;
  }
  // A freshly-created empty seq (the ENOENT fallback, or a manifest
  // with `harnesses:` but no list under it) defaults to flow style
  // (`[...]`) — force block style so an appended entry renders as a
  // normal `- id: ...` list item, not ugly inline flow syntax.
  // Confirmed live this actually matters — an unset `.flow` here
  // produced malformed-looking (though technically valid) YAML.
  if (seq.items.length === 0) seq.flow = false;

  const existing = seq.items.find((item) => {
    const map = item as { get?: (key: string) => unknown };
    return typeof map.get === "function" && map.get("id") === harness.id;
  }) as { set: (key: string, value: unknown) => void; delete: (key: string) => void } | undefined;

  if (existing) {
    existing.set("enabled", enabled);
    existing.delete("disabledReason");
  } else {
    // disabledReason is a derived/runtime annotation, never something a
    // human hand-writes into this file — only the persistable fields
    // get copied over when promoting a discovery-only harness.
    const toStore: Omit<Harness, "disabledReason"> = {
      id: harness.id,
      tool: harness.tool,
      label: harness.label,
      enabled,
      ...(harness.env ? { env: harness.env } : {}),
      ...(harness.apiKeyEnv ? { apiKeyEnv: harness.apiKeyEnv } : {}),
    };
    seq.add(doc.createNode(toStore));
  }

  await writeFile(path, doc.toString());
}
