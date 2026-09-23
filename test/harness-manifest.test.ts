import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { setHarnessEnabled, setHarnessModel } from "../src/core/harness-manifest.ts";
import type { Harness } from "../src/core/types.ts";

async function fixture(content: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-harness-manifest-test-"));
  const path = join(dir, "harnesses.yaml");
  await writeFile(path, content);
  return { dir, path };
}

const claudePersonal: Harness = { id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true };

test("toggling an existing entry off preserves every comment and every other entry byte-for-byte", async () => {
  const { dir, path } = await fixture(`# header comment, explaining the whole file
harnesses:
  - id: claude-personal
    tool: claude-cli
    label: "Claude — personal"
    enabled: true
    env:
      # why this path
      CLAUDE_CONFIG_DIR: "/x"
  - id: untouched
    tool: claude-cli
    label: "Untouched"
    enabled: true
`);
  try {
    await setHarnessEnabled(path, claudePersonal, false);
    const out = await readFile(path, "utf8");

    expect(out).toContain("# header comment, explaining the whole file");
    expect(out).toContain("# why this path");
    expect(out).toContain("id: untouched");
    expect(out).toContain('label: "Untouched"');

    const parsed = parse(out) as { harnesses: Harness[] };
    const toggled = parsed.harnesses.find((h) => h.id === "claude-personal")!;
    expect(toggled.enabled).toBe(false);
    const other = parsed.harnesses.find((h) => h.id === "untouched")!;
    expect(other.enabled).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("re-enabling an entry clears disabledReason — a human's choice supersedes the auto-diagnosis", async () => {
  const { dir, path } = await fixture(`harnesses:
  - id: claude-personal
    tool: claude-cli
    label: "Claude — personal"
    enabled: false
    disabledReason: "not authenticated"
`);
  try {
    await setHarnessEnabled(path, { ...claudePersonal, enabled: false, disabledReason: "not authenticated" }, true);
    const parsed = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    const toggled = parsed.harnesses.find((h) => h.id === "claude-personal")!;
    expect(toggled.enabled).toBe(true);
    expect(toggled.disabledReason).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toggling a discovery-only harness (never in the file) promotes it into a new entry, preserving unrelated content", async () => {
  const { dir, path } = await fixture(`# header
harnesses:
  - id: claude-personal
    tool: claude-cli
    label: "Claude — personal"
    enabled: true
`);
  try {
    const discovered: Harness = { id: "codex-adevinta", tool: "codex-cli", label: "Codex — adevinta", enabled: true, env: { CODEX_HOME: "/home/x/.codex-adevinta" } };
    await setHarnessEnabled(path, discovered, false);
    const out = await readFile(path, "utf8");

    expect(out).toContain("# header");
    const parsed = parse(out) as { harnesses: Harness[] };
    expect(parsed.harnesses).toHaveLength(2);
    const promoted = parsed.harnesses.find((h) => h.id === "codex-adevinta")!;
    expect(promoted).toEqual({ id: "codex-adevinta", tool: "codex-cli", label: "Codex — adevinta", enabled: false, env: { CODEX_HOME: "/home/x/.codex-adevinta" } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a promoted entry never carries disabledReason into the file — it's a runtime annotation, not something to persist", async () => {
  const { dir, path } = await fixture("harnesses: []\n");
  try {
    const discovered: Harness = { id: "new-one", tool: "anthropic-api", label: "New one", enabled: true, apiKeyEnv: "MY_KEY", disabledReason: "not authenticated" };
    await setHarnessEnabled(path, discovered, false);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("disabledReason");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing file starts from an empty harnesses: [] document and produces valid, block-style YAML", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-harness-manifest-test-"));
  const path = join(dir, "does-not-exist.yaml");
  try {
    const solo: Harness = { id: "solo", tool: "anthropic-api", label: "Solo", enabled: true, apiKeyEnv: "MY_KEY" };
    await setHarnessEnabled(path, solo, false);
    const raw = await readFile(path, "utf8");

    // Real regression: an unset flow-style empty seq produced
    // technically-valid but ugly inline `[ {...} ]` output the first
    // time this was written — confirmed live before shipping, not
    // assumed fixed.
    expect(raw).not.toContain("[");
    expect(raw).toContain("  - id: solo");

    const parsed = parse(raw) as { harnesses: Harness[] };
    expect(parsed.harnesses).toEqual([{ id: "solo", tool: "anthropic-api", label: "Solo", enabled: false, apiKeyEnv: "MY_KEY" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an id with no env or apiKeyEnv promotes cleanly without either key present", async () => {
  const { dir, path } = await fixture("harnesses: []\n");
  try {
    const bare: Harness = { id: "bare", tool: "claude-cli", label: "Bare", enabled: true };
    await setHarnessEnabled(path, bare, true);
    const parsed = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    expect(parsed.harnesses).toEqual([{ id: "bare", tool: "claude-cli", label: "Bare", enabled: true }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- setHarnessModel: per-harness default model persistence ---

test("setHarnessModel sets model on an existing entry, preserving every comment and every other entry byte-for-byte", async () => {
  const { dir, path } = await fixture(`# header comment, explaining the whole file
harnesses:
  - id: claude-personal
    tool: claude-cli
    label: "Claude — personal"
    enabled: true
    env:
      # why this path
      CLAUDE_CONFIG_DIR: "/x"
  - id: untouched
    tool: claude-cli
    label: "Untouched"
    enabled: true
`);
  try {
    await setHarnessModel(path, claudePersonal, "claude-opus-5-5");
    const out = await readFile(path, "utf8");

    expect(out).toContain("# header comment, explaining the whole file");
    expect(out).toContain("# why this path");
    expect(out).toContain("id: untouched");

    const parsed = parse(out) as { harnesses: Harness[] };
    const updated = parsed.harnesses.find((h) => h.id === "claude-personal")!;
    expect(updated.model).toBe("claude-opus-5-5");
    const other = parsed.harnesses.find((h) => h.id === "untouched")!;
    expect(other.model).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setHarnessModel with undefined clears a previously-set model", async () => {
  const { dir, path } = await fixture(`harnesses:
  - id: claude-personal
    tool: claude-cli
    label: "Claude — personal"
    enabled: true
    model: claude-opus-5-5
`);
  try {
    await setHarnessModel(path, { ...claudePersonal, model: "claude-opus-5-5" }, undefined);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("model:");
    const parsed = parse(raw) as { harnesses: Harness[] };
    expect(parsed.harnesses.find((h) => h.id === "claude-personal")!.model).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setHarnessModel on a discovery-only harness (never in the file) promotes it into a new entry with model set", async () => {
  const { dir, path } = await fixture(`# header
harnesses:
  - id: claude-personal
    tool: claude-cli
    label: "Claude — personal"
    enabled: true
`);
  try {
    const discovered: Harness = { id: "codex-adevinta", tool: "codex-cli", label: "Codex — adevinta", enabled: true, env: { CODEX_HOME: "/home/x/.codex-adevinta" } };
    await setHarnessModel(path, discovered, "gpt-5-codex");
    const out = await readFile(path, "utf8");

    expect(out).toContain("# header");
    const parsed = parse(out) as { harnesses: Harness[] };
    expect(parsed.harnesses).toHaveLength(2);
    const promoted = parsed.harnesses.find((h) => h.id === "codex-adevinta")!;
    expect(promoted).toEqual({
      id: "codex-adevinta",
      tool: "codex-cli",
      label: "Codex — adevinta",
      enabled: true,
      env: { CODEX_HOME: "/home/x/.codex-adevinta" },
      model: "gpt-5-codex",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setHarnessModel promoting with model undefined never writes a model key", async () => {
  const { dir, path } = await fixture("harnesses: []\n");
  try {
    const bare: Harness = { id: "bare", tool: "claude-cli", label: "Bare", enabled: true };
    await setHarnessModel(path, bare, undefined);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("model:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setHarnessModel on a missing file starts from an empty harnesses: [] document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-harness-manifest-test-"));
  const path = join(dir, "does-not-exist.yaml");
  try {
    const solo: Harness = { id: "solo", tool: "anthropic-api", label: "Solo", enabled: true, apiKeyEnv: "MY_KEY" };
    await setHarnessModel(path, solo, "claude-sonnet-5");
    const parsed = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    expect(parsed.harnesses).toEqual([{ id: "solo", tool: "anthropic-api", label: "Solo", enabled: true, apiKeyEnv: "MY_KEY", model: "claude-sonnet-5" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
