// The three Postgres features finn-platform's integration tests rely on
// (row-level security, FORCE ROW LEVEL SECURITY, transaction-local
// set_config), exercised over TCP from a driver the way psycopg would.
// Plain JS, not TS: it imports `pg`, which is installed next to this file
// by the live check and is not a wissel dependency, so tsc never sees it.
//
//   bun run rls-check.mjs <port>
//
// Prints `check:<name>=<value>` per observation and RLS_CHECK_PASS or
// RLS_CHECK_FAIL; eval/sandbox-postgres-checks.ts compares the values
// against EXPECTED_RLS_CHECKS (keep the two in step).
import pg from "pg";

const port = Number(process.argv[2] ?? 54329);
const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
await client.connect();
const one = async (sql) => String(Object.values((await client.query(sql)).rows[0] ?? {})[0]);
const checks = {};

await client.query(`
  CREATE ROLE desk_owner NOLOGIN;
  CREATE ROLE desk_app NOLOGIN NOINHERIT;
  CREATE TABLE tickets (id int PRIMARY KEY, desk text NOT NULL, title text NOT NULL);
  ALTER TABLE tickets OWNER TO desk_owner;
  GRANT SELECT, INSERT ON tickets TO desk_app;
  INSERT INTO tickets VALUES (1, 'it', 'laptop'), (2, 'it', 'vpn'), (3, 'hr', 'payslip');
  ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
  CREATE POLICY by_desk ON tickets USING (desk = current_setting('desk.principal_desk', true));
`);
checks.version = await one("SELECT current_setting('server_version_num')");
checks.force_rls = await one("SELECT relforcerowsecurity::text FROM pg_class WHERE relname = 'tickets'");

// the application role with a transaction-local principal: its desk only
await client.query("BEGIN");
await client.query("SET LOCAL ROLE desk_app");
await client.query("SELECT set_config('desk.principal_desk', 'it', true)");
checks.app_it_rows = await one("SELECT count(*)::text FROM tickets");
checks.app_it_titles = await one("SELECT string_agg(title, ',' ORDER BY id) FROM tickets");
await client.query("COMMIT");

// the local setting died with the transaction: no desk, no rows
await client.query("BEGIN");
await client.query("SET LOCAL ROLE desk_app");
checks.app_no_setting_rows = await one("SELECT count(*)::text FROM tickets");
await client.query("COMMIT");

// FORCE: the table owner is filtered too
await client.query("BEGIN");
await client.query("SET LOCAL ROLE desk_owner");
await client.query("SELECT set_config('desk.principal_desk', 'hr', true)");
checks.owner_hr_rows = await one("SELECT count(*)::text FROM tickets");
await client.query("COMMIT");

// an insert for another desk is refused by the policy (42501)
await client.query("BEGIN");
await client.query("SET LOCAL ROLE desk_app");
await client.query("SELECT set_config('desk.principal_desk', 'it', true)");
try {
  await client.query("INSERT INTO tickets VALUES (4, 'hr', 'smuggled')");
  checks.smuggle_error = "none";
} catch (e) {
  checks.smuggle_error = e.code ?? "unknown";
}
await client.query("ROLLBACK");
checks.smuggled_rows = await one("SELECT count(*)::text FROM tickets WHERE id = 4");
checks.superuser_rows = await one("SELECT count(*)::text FROM tickets");
await client.end();

const expected = {
  force_rls: "true",
  app_it_rows: "2",
  app_it_titles: "laptop,vpn",
  app_no_setting_rows: "0",
  owner_hr_rows: "1",
  smuggle_error: "42501",
  smuggled_rows: "0",
  superuser_rows: "3",
};
let failed = 0;
for (const [k, v] of Object.entries(checks)) {
  const want = expected[k];
  const ok = want === undefined || want === v;
  if (!ok) failed++;
  console.log(`check:${k}=${v}${want === undefined ? "" : ok ? " ok" : ` FAIL (want ${want})`}`);
}
console.log(failed === 0 ? "RLS_CHECK_PASS" : `RLS_CHECK_FAIL ${failed}`);
process.exit(failed === 0 ? 0 : 1);
