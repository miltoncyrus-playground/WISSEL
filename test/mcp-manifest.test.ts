import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { setMcpServerEnabled } from "../src/core/mcp-manifest.ts";
import type { McpServer } from "../src/core/types.ts";

async function fixture(content: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-mcp-manifest-test-"));
  const path = join(dir, "mcp-servers.yaml");
  await writeFile(path, content);
  return { dir, path };
}

const serverA: McpServer = {
  id: "a",
  label: "A",
  transport: { kind: "stdio", command: "/usr/local/bin/a-mcp", args: [] },
  tools: [{ name: "foo", trust: "approval-required" }],
  enabled: true,
};

test("toggling an existing entry off preserves every comment and every other entry byte-for-byte", async () => {
  const { dir, path } = await fixture(`# header comment, explaining the whole file
mcp-servers:
  - id: a
    label: A
    enabled: true
    transport:
      kind: stdio
      # why this command
      command: "/usr/local/bin/a-mcp"
      args: []
    tools:
      - name: foo
        trust: approval-required
  - id: untouched
    label: Untouched
    enabled: true
    transport:
      kind: stdio
      command: "/bin/true"
      args: []
    tools: []
`);
  try {
    await setMcpServerEnabled(path, serverA, false);
    const out = await readFile(path, "utf8");

    expect(out).toContain("# header comment, explaining the whole file");
    expect(out).toContain("# why this command");
    expect(out).toContain("id: untouched");

    const parsed = parse(out) as { "mcp-servers": McpServer[] };
    const toggled = parsed["mcp-servers"].find((s) => s.id === "a")!;
    expect(toggled.enabled).toBe(false);
    const other = parsed["mcp-servers"].find((s) => s.id === "untouched")!;
    expect(other.enabled).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("re-enabling an entry clears disabledReason — a human's choice supersedes the auto-diagnosis", async () => {
  const { dir, path } = await fixture(`mcp-servers:
  - id: a
    label: A
    enabled: false
    disabledReason: "not reachable"
    transport:
      kind: stdio
      command: "/usr/local/bin/a-mcp"
      args: []
    tools: []
`);
  try {
    await setMcpServerEnabled(path, { ...serverA, enabled: false, disabledReason: "not reachable" }, true);
    const parsed = parse(await readFile(path, "utf8")) as { "mcp-servers": McpServer[] };
    const toggled = parsed["mcp-servers"].find((s) => s.id === "a")!;
    expect(toggled.enabled).toBe(true);
    expect(toggled.disabledReason).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toggling a server not yet in the file promotes it into a new entry, preserving unrelated content", async () => {
  const { dir, path } = await fixture(`# header
mcp-servers:
  - id: a
    label: A
    enabled: true
    transport:
      kind: stdio
      command: "/usr/local/bin/a-mcp"
      args: []
    tools: []
`);
  try {
    const newServer: McpServer = {
      id: "b",
      label: "B",
      transport: { kind: "http", url: "https://example.internal/mcp" },
      tools: [{ name: "query", trust: "auto" }],
      enabled: true,
    };
    await setMcpServerEnabled(path, newServer, false);
    const out = await readFile(path, "utf8");

    expect(out).toContain("# header");
    const parsed = parse(out) as { "mcp-servers": McpServer[] };
    expect(parsed["mcp-servers"]).toHaveLength(2);
    const promoted = parsed["mcp-servers"].find((s) => s.id === "b")!;
    expect(promoted).toEqual({
      id: "b",
      label: "B",
      transport: { kind: "http", url: "https://example.internal/mcp" },
      tools: [{ name: "query", trust: "auto" }],
      enabled: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a promoted entry never carries disabledReason into the file — it's a runtime annotation, not something to persist", async () => {
  const { dir, path } = await fixture("mcp-servers: []\n");
  try {
    const withReason: McpServer = { ...serverA, disabledReason: "not reachable" };
    await setMcpServerEnabled(path, withReason, false);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("disabledReason");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing file starts from an empty mcp-servers: [] document and produces valid, block-style YAML", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-mcp-manifest-test-"));
  const path = join(dir, "does-not-exist.yaml");
  try {
    await setMcpServerEnabled(path, serverA, false);
    const raw = await readFile(path, "utf8");

    // Same real regression harness-manifest.ts's own comment documents:
    // an unset flow-style empty seq produces ugly inline `[ {...} ]`.
    expect(raw).not.toContain("[]\n  -");
    expect(raw).toContain("  - id: a");

    const parsed = parse(raw) as { "mcp-servers": McpServer[] };
    expect(parsed["mcp-servers"]).toEqual([{ ...serverA, enabled: false }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a server with no env promotes cleanly without the key present", async () => {
  const { dir, path } = await fixture("mcp-servers: []\n");
  try {
    await setMcpServerEnabled(path, serverA, true);
    const parsed = parse(await readFile(path, "utf8")) as { "mcp-servers": McpServer[] };
    expect(parsed["mcp-servers"]).toEqual([serverA]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a server's env is persisted when present", async () => {
  const { dir, path } = await fixture("mcp-servers: []\n");
  try {
    const withEnv: McpServer = { ...serverA, id: "c", env: { SOME_TOKEN_ENV: "MY_TOKEN_VAR" } };
    await setMcpServerEnabled(path, withEnv, true);
    const parsed = parse(await readFile(path, "utf8")) as { "mcp-servers": McpServer[] };
    expect(parsed["mcp-servers"].find((s) => s.id === "c")?.env).toEqual({ SOME_TOKEN_ENV: "MY_TOKEN_VAR" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
