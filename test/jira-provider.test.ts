import { expect, test } from "bun:test";
import { JiraProvider, type FetchLike } from "../src/services/jira-provider.ts";
import { TicketError, withLookupCache, type TicketProvider } from "../src/services/ticket-provider.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fake(replies: { status?: number; body?: unknown }[]): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    const status = r.status ?? 200;
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
  };
  return { fetchFn, calls };
}

const make = (replies: { status?: number; body?: unknown }[], over: Partial<ConstructorParameters<typeof JiraProvider>[0]> = {}) => {
  const f = fake(replies);
  return { ...f, jira: new JiraProvider({ site: "https://t.example.net/", email: "me@example.com", token: "SECRET-TOKEN", writeBack: true, fetchFn: f.fetchFn, ...over }) };
};

const issue = (key: string, summary: string) => ({ key, fields: { summary, status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, assignee: { displayName: "Sam" } } });

test("lookup asks one JQL search for the keys, with basic auth, and maps the issues", async () => {
  const { jira, calls } = make([{ body: { issues: [issue("ABC-1", "First"), issue("ABC-2", "Second")] } }]);
  const out = await jira.lookup(["ABC-1", "ABC-2", "ABC-1"]);
  expect(out["ABC-1"]).toEqual({ key: "ABC-1", summary: "First", status: "In Progress", statusCategory: "indeterminate", assignee: "Sam", url: "https://t.example.net/browse/ABC-1" });
  expect(Object.keys(out)).toEqual(["ABC-1", "ABC-2"]);
  expect(calls).toHaveLength(1);
  const u = new URL(calls[0]!.url);
  expect(u.origin + u.pathname).toBe("https://t.example.net/rest/api/3/search/jql");
  expect(u.searchParams.get("jql")).toBe("key in (ABC-1,ABC-2)");
  expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from("me@example.com:SECRET-TOKEN").toString("base64")}`);
});

test("lookup leaves out keys that are malformed or outside projectKeys, and never sends them", async () => {
  const { jira, calls } = make([{ body: { issues: [issue("ABC-1", "x")] } }], { projectKeys: ["ABC"] });
  const out = await jira.lookup(["ABC-1", "XYZ-9", "abc-1", "ABC-1) OR project is not EMPTY OR (key = ABC-1", "ABC-"]);
  expect(Object.keys(out)).toEqual(["ABC-1"]);
  expect(new URL(calls[0]!.url).searchParams.get("jql")).toBe("key in (ABC-1)");
  const none = make([{ body: {} }], { projectKeys: ["ABC"] });
  expect(await none.jira.lookup(["XYZ-9"])).toEqual({});
  expect(none.calls).toHaveLength(0);
});

test("lookup splits more than 50 keys into several searches", async () => {
  const keys = Array.from({ length: 120 }, (_, i) => `ABC-${i + 1}`);
  const { jira, calls } = make([{ body: { issues: [] } }]);
  await jira.lookup(keys);
  expect(calls).toHaveLength(3);
});

test("a failed call is a TicketError that names the cause and never carries the token", async () => {
  for (const [status, text] of [[401, "refused the credentials"], [403, "may not do that"], [404, "does not know"], [500, "HTTP 500"]] as const) {
    const { jira } = make([{ status }]);
    const err = await jira.lookup(["ABC-1"]).catch((e) => e);
    expect(err).toBeInstanceOf(TicketError);
    expect(err.message).toContain(text);
    expect(err.message).not.toContain("SECRET-TOKEN");
  }
  const down = new JiraProvider({ site: "https://t.example.net", email: "a@b.c", token: "SECRET-TOKEN", writeBack: false, fetchFn: async () => { throw new Error("connect ECONNREFUSED"); } });
  const err = await down.lookup(["ABC-1"]).catch((e) => e);
  expect(err.message).toContain("could not reach Jira");
  expect(err.message).not.toContain("SECRET-TOKEN");
});

test("comment posts one paragraph per line as Atlassian Document Format", async () => {
  const { jira, calls } = make([{ status: 201, body: { id: "1" } }]);
  await jira.comment("ABC-1", "Landed on feat/ABC-1-x\n\nsee PR 5");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://t.example.net/rest/api/3/issue/ABC-1/comment");
  const body = JSON.parse(calls[0]!.body!);
  expect(body.body.type).toBe("doc");
  expect(body.body.content.map((p: { content?: { text: string }[] }) => p.content?.[0]?.text)).toEqual(["Landed on feat/ABC-1-x", undefined, "see PR 5"]);
});

test("transitions lists them and transition posts the chosen id", async () => {
  const { jira, calls } = make([{ body: { transitions: [{ id: "31", name: "Start", to: { name: "In Progress" } }, { id: "x", name: 7 }] } }, { status: 204 }]);
  expect(await jira.transitions("ABC-1")).toEqual([{ id: "31", name: "Start", to: "In Progress" }]);
  await jira.transition("ABC-1", "31");
  expect(calls[1]!.url).toBe("https://t.example.net/rest/api/3/issue/ABC-1/transitions");
  expect(JSON.parse(calls[1]!.body!)).toEqual({ transition: { id: "31" } });
});

test("writes are refused when write-back is off, for a bad key, an empty comment or a bad transition id; nothing is sent", async () => {
  const off = make([{}], { writeBack: false });
  for (const p of [off.jira.comment("ABC-1", "hi"), off.jira.transition("ABC-1", "31"), off.jira.transitions("ABC-1")]) {
    expect((await p.catch((e) => e)).message).toContain("write-back is off");
  }
  const on = make([{}]);
  expect((await on.jira.comment("../x", "hi").catch((e) => e)).message).toContain("not a ticket key");
  expect((await on.jira.comment("ABC-1", "   ").catch((e) => e)).message).toContain("empty");
  expect((await on.jira.comment("ABC-1", "x".repeat(10_001)).catch((e) => e)).message).toContain("10,000");
  expect((await on.jira.transition("ABC-1", "31/../x").catch((e) => e)).message).toContain("number");
  expect((await make([{}], { projectKeys: ["ABC"] }).jira.comment("XYZ-1", "hi").catch((e) => e)).message).toContain("outside the projects");
  expect(off.calls.length + on.calls.length).toBe(0);
});

test("withLookupCache serves repeats from memory until the ttl, and a write drops the entry", async () => {
  let looked = 0;
  const inner: TicketProvider = {
    id: "t", writeBack: true,
    lookup: async (keys) => { looked++; return Object.fromEntries(keys.filter((k) => k !== "ABC-9").map((k) => [k, { key: k, summary: "s", status: "x", url: "u" }])); },
    transitions: async () => [], comment: async () => {}, transition: async () => {},
  };
  let t = 0;
  const cached = withLookupCache(inner, 1000, () => t);
  await cached.lookup(["ABC-1", "ABC-9"]);
  await cached.lookup(["ABC-1", "ABC-9"]);
  expect(looked).toBe(1); // an unknown key is remembered as unknown too
  await cached.comment("ABC-1", "hi");
  await cached.lookup(["ABC-1"]);
  expect(looked).toBe(2);
  t = 5000;
  await cached.lookup(["ABC-1"]);
  expect(looked).toBe(3);
});
