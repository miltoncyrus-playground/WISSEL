/**
 * Writes per-session config (hooks, MCP servers) into a session's
 * settings.local.json. Atomic write, merge-preserving: never clobber
 * keys this module did not author.
 *
 * Port from agetor's hook-installer.ts.
 */
export interface ProvisionOptions {
  cwd: string;
  originRepo: string;
  mcpServers?: Record<string, unknown>;
}

export class Provisioner {
  async provision(opts: ProvisionOptions): Promise<void> {
    void opts;
    throw new Error("not implemented");
  }
}
