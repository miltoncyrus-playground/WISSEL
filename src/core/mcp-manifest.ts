import { readFile, writeFile } from "node:fs/promises";
import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import type { McpServer } from "./types.ts";

/**
 * Persists a human's enable/disable decision for one MCP server back to
 * `mcp-servers.yaml` — mirrors `setHarnessEnabled` (harness-manifest.ts)
 * exactly: same Document-API round-trip (comments/formatting survive,
 * not a parse+stringify rewrite), same empty-flow-seq guard, same
 * missing-file-reads-as-empty contract, same "promote on first toggle"
 * path for a server that's never been written to this file before.
 *
 * `disabledReason` is always cleared here: a human's own enable/disable
 * decision supersedes whatever automatic diagnosis (e.g. "not
 * reachable") was on the server before — that field exists to explain a
 * *system*-driven disable, not a chosen one. A failed enable attempt
 * (still not reachable) never reaches this function at all — the caller
 * refuses before persisting anything (see `checkMcpServerReachable` and
 * the `/mcp-servers/:id/enable` handler).
 */
export async function setMcpServerEnabled(path: string, server: McpServer, enabled: boolean): Promise<void> {
  const raw = await readFile(path, "utf8").catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "mcp-servers: []\n";
    throw e;
  });

  const doc = parseDocument(raw);
  let seq = doc.getIn(["mcp-servers"]) as YAMLSeq | undefined;
  if (!seq) {
    doc.setIn(["mcp-servers"], []);
    seq = doc.getIn(["mcp-servers"]) as YAMLSeq;
  }
  // A freshly-created empty seq defaults to flow style (`[...]`) — force
  // block style so an appended entry renders as a normal `- id: ...`
  // list item. Same real regression harness-manifest.ts's own comment
  // documents for harnesses.yaml.
  if (seq.items.length === 0) seq.flow = false;

  const existing = seq.items.find((item) => {
    const map = item as { get?: (key: string) => unknown };
    return typeof map.get === "function" && map.get("id") === server.id;
  }) as { set: (key: string, value: unknown) => void; delete: (key: string) => void } | undefined;

  if (existing) {
    existing.set("enabled", enabled);
    existing.delete("disabledReason");
  } else {
    // disabledReason is a derived/runtime annotation, never something a
    // human hand-writes into this file — only the persistable fields
    // get copied over when promoting a not-yet-written server.
    const toStore: Omit<McpServer, "disabledReason"> = {
      id: server.id,
      label: server.label,
      transport: server.transport,
      tools: server.tools,
      enabled,
      ...(server.env ? { env: server.env } : {}),
    };
    seq.add(doc.createNode(toStore));
  }

  await writeFile(path, doc.toString());
}

/**
 * Persists a human's trust-tier edit for one named tool on one MCP
 * server back to `mcp-servers.yaml` — same Document-API round-trip
 * contract `setMcpServerEnabled` above holds (comments/formatting
 * survive, empty-flow-seq guard, missing-file-reads-as-empty, "promote
 * on first edit" for a server never written to this file before), just
 * reaching one level deeper into the server's own `tools` list instead
 * of setting a top-level field.
 *
 * `toolName` not existing on the resolved server is a caller bug (the
 * `/mcp-servers/:id/tools/:tool/trust` handler already 404s before this
 * is ever called) — silently no-ops on a promoted-but-brand-new entry's
 * `tools` array rather than throwing, since `McpServerPool.setToolTrust`
 * (the in-memory half, always called alongside this) already fails the
 * same way for the same input.
 */
export async function setMcpServerToolTrust(
  path: string,
  server: McpServer,
  toolName: string,
  trust: "auto" | "approval-required",
): Promise<void> {
  const raw = await readFile(path, "utf8").catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "mcp-servers: []\n";
    throw e;
  });

  const doc = parseDocument(raw);
  let seq = doc.getIn(["mcp-servers"]) as YAMLSeq | undefined;
  if (!seq) {
    doc.setIn(["mcp-servers"], []);
    seq = doc.getIn(["mcp-servers"]) as YAMLSeq;
  }
  if (seq.items.length === 0) seq.flow = false;

  const existing = seq.items.find((item) => {
    const map = item as { get?: (key: string) => unknown };
    return typeof map.get === "function" && map.get("id") === server.id;
  }) as YAMLMap | undefined;

  if (existing) {
    const toolsSeq = existing.get("tools") as YAMLSeq | undefined;
    const toolItem = toolsSeq?.items.find((item) => {
      const map = item as { get?: (key: string) => unknown };
      return typeof map.get === "function" && map.get("name") === toolName;
    }) as YAMLMap | undefined;
    toolItem?.set("trust", trust);
  } else {
    // Promote a server that's never been written to this file before —
    // same contract setMcpServerEnabled's own promotion path holds,
    // with the one named tool's trust already applied to the copy
    // being written.
    const toStore: Omit<McpServer, "disabledReason"> = {
      id: server.id,
      label: server.label,
      transport: server.transport,
      tools: server.tools.map((t) => (t.name === toolName ? { ...t, trust } : t)),
      enabled: server.enabled,
      ...(server.env ? { env: server.env } : {}),
    };
    seq.add(doc.createNode(toStore));
  }

  await writeFile(path, doc.toString());
}
