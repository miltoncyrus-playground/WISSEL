import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTicketProvider, parseJiraEntry } from "../src/services/integrations.ts";
import type { FetchLike } from "../src/services/jira-provider.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wissel-integrations-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ENV = { JIRA_EMAIL: "me@example.com", JIRA_API_TOKEN: "tok" };
const yaml = (body: string) => { const p = join(dir, "integrations.yaml"); writeFileSync(p, body); return p; };
const GOOD = "integrations:\n  - id: jira\n    kind: jira\n    site: https://t.example.net\n    emailEnv: JIRA_EMAIL\n    tokenEnv: JIRA_API_TOKEN\n    projectKeys: [ABC]\n    writeBack: true\n";

test("a good file with its env vars set gives a provider that honours writeBack", async () => {
  const seen: string[] = [];
  const fetchFn: FetchLike = async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify({ issues: [] }) }; };
  const setup = await loadTicketProvider(yaml(GOOD), ENV, fetchFn);
  expect(setup.reason).toBeUndefined();
  expect(setup.provider?.writeBack).toBe(true);
  await setup.provider!.lookup(["ABC-1"]);
  expect(seen[0]).toStartWith("https://t.example.net/rest/api/3/search/jql");
});

test("writeBack defaults to off", async () => {
  const setup = await loadTicketProvider(yaml(GOOD.replace("    writeBack: true\n", "")), ENV);
  expect(setup.provider?.writeBack).toBe(false);
});

test("a missing file, an empty one, bad YAML and missing env vars each come back as a reason, not an error", async () => {
  expect((await loadTicketProvider(join(dir, "none.yaml"), ENV)).reason).toContain("integrations.example.yaml");
  expect((await loadTicketProvider(yaml("integrations: []\n"), ENV)).reason).toContain("lists no integrations");
  expect((await loadTicketProvider(yaml("a: [unclosed"), ENV)).reason).toContain("not valid YAML");
  const noToken = await loadTicketProvider(yaml(GOOD), { JIRA_EMAIL: "me@example.com" });
  expect(noToken.provider).toBeUndefined();
  expect(noToken.reason).toContain("JIRA_API_TOKEN is not set");
  expect(noToken.reason).not.toContain("me@example.com");
});

test("parseJiraEntry refuses what could leak or misdirect credentials", () => {
  const base = { kind: "jira", site: "https://t.example.net", emailEnv: "A", tokenEnv: "B" };
  expect(parseJiraEntry(base)).toMatchObject({ ok: true, config: { site: "https://t.example.net", writeBack: false } });
  expect(parseJiraEntry({ ...base, site: "https://t.example.net/path?x=1" })).toMatchObject({ ok: true, config: { site: "https://t.example.net" } });
  expect(parseJiraEntry({ ...base, site: "http://localhost:8080" })).toMatchObject({ ok: true });
  for (const bad of [
    { ...base, site: "http://t.example.net" },
    { ...base, site: "https://user:pw@t.example.net" },
    { ...base, site: "not a url" },
    { ...base, emailEnv: "me@example.com" },
    { ...base, tokenEnv: "ghp secret value" },
    { ...base, kind: "linear" },
    { ...base, projectKeys: ["abc"] },
    { ...base, writeBack: "yes" },
    "jira",
  ]) expect(parseJiraEntry(bad).ok).toBe(false);
});
