import { TicketError, KEY_RE, MINE_LIMIT, type Ticket, type TicketProvider, type TicketTransition } from "./ticket-provider.ts";

/** The slice of `fetch` this uses: injectable so tests never touch a
 *  network. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const REQUEST_TIMEOUT_MS = 10_000;
const KEYS_PER_SEARCH = 50;

interface JiraIssueFields {
  summary?: unknown;
  status?: { name?: unknown; statusCategory?: { key?: unknown } };
  assignee?: { displayName?: unknown } | null;
  parent?: { key?: unknown; fields?: { summary?: unknown } } | null;
}

const FIELDS = "summary,status,assignee,parent";

/** Jira Cloud over its REST API v3, with an email and an API token
 *  (basic auth). Nothing here writes unless `writeBack` is set. */
export class JiraProvider implements TicketProvider {
  readonly id: string;
  readonly writeBack: boolean;
  private readonly site: string;
  private readonly auth: string;
  private readonly projectKeys?: Set<string>;
  private readonly fetchFn: FetchLike;

  constructor(opts: { site: string; email: string; token: string; projectKeys?: string[]; writeBack: boolean; id?: string; fetchFn?: FetchLike }) {
    this.id = opts.id ?? "jira";
    this.writeBack = opts.writeBack;
    this.site = opts.site.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString("base64")}`;
    this.projectKeys = opts.projectKeys && opts.projectKeys.length > 0 ? new Set(opts.projectKeys) : undefined;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  }

  private allowed(key: string): boolean {
    return KEY_RE.test(key) && (!this.projectKeys || this.projectKeys.has(key.slice(0, key.lastIndexOf("-"))));
  }

  private requireKey(key: string): void {
    if (!KEY_RE.test(key)) throw new TicketError(`${JSON.stringify(key)} is not a ticket key`, 400);
    if (!this.allowed(key)) throw new TicketError(`${key} is outside the projects this integration covers`, 403);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res;
    try {
      res = await this.fetchFn(`${this.site}${path}`, {
        method,
        headers: { authorization: this.auth, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new TicketError(`could not reach Jira: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401) throw new TicketError("Jira refused the credentials (check the email and API token)", 502);
    if (res.status === 403) throw new TicketError("Jira says this account may not do that", 403);
    if (res.status === 404) throw new TicketError("Jira does not know that ticket or project", 404);
    if (!res.ok) throw new TicketError(`Jira answered HTTP ${res.status}`, 502);
    if (res.status === 204) return undefined;
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  async lookup(keys: readonly string[]): Promise<Record<string, Ticket>> {
    const wanted = [...new Set(keys)].filter((k) => this.allowed(k));
    const out: Record<string, Ticket> = {};
    for (let i = 0; i < wanted.length; i += KEYS_PER_SEARCH) {
      const chunk = wanted.slice(i, i + KEYS_PER_SEARCH);
      // Keys passed KEY_RE, so nothing here can break out of the JQL.
      const jql = `key in (${chunk.join(",")})`;
      const q = new URLSearchParams({ jql, fields: FIELDS, maxResults: String(KEYS_PER_SEARCH) });
      const data = (await this.call("GET", `/rest/api/3/search/jql?${q}`)) as { issues?: { key?: unknown; fields?: JiraIssueFields }[] } | undefined;
      for (const issue of data?.issues ?? []) {
        if (typeof issue.key !== "string" || !chunk.includes(issue.key)) continue;
        out[issue.key] = this.toTicket(issue.key, issue.fields ?? {});
      }
    }
    return out;
  }

  private toTicket(key: string, f: JiraIssueFields): Ticket {
    const parentKey = f.parent?.key;
    return {
      key,
      summary: typeof f.summary === "string" ? f.summary : "",
      status: typeof f.status?.name === "string" ? f.status.name : "",
      ...(typeof f.status?.statusCategory?.key === "string" ? { statusCategory: f.status.statusCategory.key } : {}),
      ...(typeof f.assignee?.displayName === "string" ? { assignee: f.assignee.displayName } : {}),
      ...(typeof parentKey === "string" && KEY_RE.test(parentKey) ? { parent: { key: parentKey, summary: typeof f.parent?.fields?.summary === "string" ? f.parent.fields.summary : "" } } : {}),
      url: `${this.site}/browse/${key}`,
    };
  }

  /** Open tickets assigned to the signed-in account. The JQL is fixed;
   *  the only variable part is the configured project keys, each checked
   *  against a strict pattern before it gets near the query. */
  async assignedToMe(): Promise<Ticket[]> {
    const projects = this.projectKeys ? [...this.projectKeys].filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k)) : [];
    const scope = projects.length > 0 ? ` AND project in (${projects.join(",")})` : "";
    const jql = `assignee = currentUser() AND statusCategory != Done${scope} ORDER BY updated DESC`;
    const q = new URLSearchParams({ jql, fields: FIELDS, maxResults: String(MINE_LIMIT) });
    const data = (await this.call("GET", `/rest/api/3/search/jql?${q}`)) as { issues?: { key?: unknown; fields?: JiraIssueFields }[] } | undefined;
    const out: Ticket[] = [];
    for (const issue of data?.issues ?? []) {
      if (typeof issue.key !== "string" || !KEY_RE.test(issue.key)) continue;
      out.push(this.toTicket(issue.key, issue.fields ?? {}));
    }
    return out;
  }

  private requireWrite(): void {
    if (!this.writeBack) throw new TicketError("write-back is off for this integration (set writeBack: true)", 403);
  }

  async transitions(key: string): Promise<TicketTransition[]> {
    this.requireKey(key);
    this.requireWrite();
    const data = (await this.call("GET", `/rest/api/3/issue/${key}/transitions`)) as { transitions?: { id?: unknown; name?: unknown; to?: { name?: unknown } }[] } | undefined;
    const out: TicketTransition[] = [];
    for (const t of data?.transitions ?? []) {
      if (typeof t.id === "string" && typeof t.name === "string") out.push({ id: t.id, name: t.name, to: typeof t.to?.name === "string" ? t.to.name : t.name });
    }
    return out;
  }

  async comment(key: string, text: string): Promise<void> {
    this.requireKey(key);
    this.requireWrite();
    const trimmed = text.trim();
    if (!trimmed) throw new TicketError("a comment can't be empty", 400);
    if (trimmed.length > 10_000) throw new TicketError("a comment is limited to 10,000 characters", 400);
    // Atlassian Document Format: one paragraph per line.
    const content = trimmed.split("\n").map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }));
    await this.call("POST", `/rest/api/3/issue/${key}/comment`, { body: { type: "doc", version: 1, content } });
  }

  async transition(key: string, transitionId: string): Promise<void> {
    this.requireKey(key);
    this.requireWrite();
    if (!/^\d{1,9}$/.test(transitionId)) throw new TicketError("a transition id is a number", 400);
    await this.call("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: transitionId } });
  }
}
