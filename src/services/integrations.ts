import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { JiraProvider, type FetchLike } from "./jira-provider.ts";
import { withLookupCache, type TicketProvider } from "./ticket-provider.ts";

/** What GET /tickets reports when there is no usable provider. */
export type TicketsUnavailable = { provider?: undefined; reason: string };
export type TicketsSetup = { provider: TicketProvider; reason?: undefined } | TicketsUnavailable;

interface JiraConfig {
  id: string;
  kind: "jira";
  site: string;
  emailEnv: string;
  tokenEnv: string;
  projectKeys?: string[];
  writeBack: boolean;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Why one integrations entry can't be used, or the parsed config. */
export function parseJiraEntry(entry: unknown): { ok: true; config: JiraConfig } | { ok: false; error: string } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, error: "an integration must be an object" };
  const e = entry as Record<string, unknown>;
  if (e.kind !== "jira") return { ok: false, error: `unknown integration kind ${JSON.stringify(e.kind)}; expected "jira"` };
  if (typeof e.site !== "string") return { ok: false, error: "jira: site must be a URL like https://your-team.atlassian.net" };
  let url: URL;
  try {
    url = new URL(e.site);
  } catch {
    return { ok: false, error: `jira: site ${JSON.stringify(e.site)} is not a URL` };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    return { ok: false, error: "jira: site must be https (http only for localhost)" };
  }
  if (url.username || url.password) return { ok: false, error: "jira: site must not contain credentials" };
  for (const field of ["emailEnv", "tokenEnv"] as const) {
    if (typeof e[field] !== "string" || !ENV_NAME_RE.test(e[field] as string)) {
      return { ok: false, error: `jira: ${field} must be the NAME of an environment variable (the value is never stored here)` };
    }
  }
  let projectKeys: string[] | undefined;
  if (e.projectKeys !== undefined) {
    if (!Array.isArray(e.projectKeys) || !e.projectKeys.every((k) => typeof k === "string" && /^[A-Z][A-Z0-9_]*$/.test(k))) {
      return { ok: false, error: "jira: projectKeys must be a list of project keys like [ABC, XYZ]" };
    }
    projectKeys = e.projectKeys as string[];
  }
  if (e.writeBack !== undefined && typeof e.writeBack !== "boolean") return { ok: false, error: "jira: writeBack must be true or false" };
  return {
    ok: true,
    config: {
      id: typeof e.id === "string" && e.id ? e.id : "jira",
      kind: "jira",
      site: `${url.protocol}//${url.host}`,
      emailEnv: e.emailEnv as string,
      tokenEnv: e.tokenEnv as string,
      ...(projectKeys ? { projectKeys } : {}),
      writeBack: e.writeBack === true,
    },
  };
}

/**
 * Reads integrations.yaml and builds the ticket provider it names. A
 * missing file, an empty one, or an unusable entry is not a startup
 * error: it comes back as `{ reason }` for GET /tickets to show, and
 * the board works as it did without tickets.
 */
export async function loadTicketProvider(path: string, env: Record<string, string | undefined>, fetchFn?: FetchLike): Promise<TicketsSetup> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { reason: `no ${path}; copy integrations.example.yaml to set up Jira` };
    return { reason: `cannot read ${path}: ${(e as Error).message}` };
  }
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (e) {
    return { reason: `${path} is not valid YAML: ${(e as Error).message}` };
  }
  const list = (doc as { integrations?: unknown } | null)?.integrations;
  if (!Array.isArray(list) || list.length === 0) return { reason: `${path} lists no integrations` };
  const checked = parseJiraEntry(list[0]);
  if (!checked.ok) return { reason: `${path}: ${checked.error}` };
  const c = checked.config;
  const email = env[c.emailEnv];
  const token = env[c.tokenEnv];
  if (!email || !token) {
    return { reason: `Jira is set up but ${!email ? c.emailEnv : c.tokenEnv} is not set in the server's environment` };
  }
  const provider = new JiraProvider({ site: c.site, email, token, projectKeys: c.projectKeys, writeBack: c.writeBack, id: c.id, fetchFn });
  return { provider: withLookupCache(provider) };
}
