# SDD: Instance settings in the Settings tab

Move the board's behaviour switches from start-up environment variables
to Setup > Settings, where the owner changes them live. The start-up
variables that guard the front door, the protections and where things
live stay where they are.

Status: approved by the owner on 2026-11-28, to be built by Wissel's own
coordinator as a workstream on the Wissel project (the first real test
of the coordinator on its own repo).

## 1. Why, and the outcome

Today Setup > Settings holds only the theme. About 30 switches (the
orchestrator, caps, background jobs, coordinator timers, audio) are
`WISSEL_*` environment variables read once at start in
`src/api/server.ts` and a few helpers. Changing one means editing the
systemd unit and restarting the board, and nothing on the board says
which are set.

Outcome:
- The owner sees every switch in Setup > Settings, grouped, with its
  current value, its default and where the value comes from.
- Changing a movable one takes effect without a restart, needs
  `host.admin`, takes a confirm step, and is recorded in the audit as a
  policy revision.
- A variable set at start still wins: its setting shows "set by
  `WISSEL_X` at start" and is read-only. The systemd unit keeps working,
  and removing a line from it hands that switch to the page.
- Start-up-only variables are listed read-only in the same tab, so
  everything is visible in one place.

## 2. Scope

### 2.1 Moves to Settings (live)

| Group | Setting key | Today | Type | Default | Applies |
|---|---|---|---|---|---|
| Running work | `orchestrator` | `WISSEL_ORCHESTRATOR` | bool | off | next sweep |
| | `executeWriteTier` | `WISSEL_EXECUTE_WRITE_TIER` | bool | off | next sweep |
| | `maxConcurrentTasks` | `WISSEL_MAX_CONCURRENT_TASKS` | int ≥ 1 or empty | unlimited | next sweep |
| | `sweepSpendCeilingUsd` | `WISSEL_SWEEP_SPEND_CEILING_USD` | number ≥ 0 or empty | unlimited | next sweep |
| | `autoChain` | `WISSEL_AUTO_CHAIN` | bool | off | next sweep |
| | `autoMerge` | `WISSEL_AUTO_MERGE` | bool | on | next verdict |
| | `reviewGuard` | `WISSEL_REVIEW_GUARD` | bool | off | next result |
| | `parallelHint` | `WISSEL_PARALLEL_HINT` | bool | off | next run |
| | `remoteControl` | `WISSEL_REMOTE_CONTROL` | bool | on | next run |
| Background jobs | `memoryCuration`, `memoryIntervalHours` | `WISSEL_MEMORY_CURATION`, `WISSEL_MEMORY_INTERVAL_HOURS` | bool, hours | off, 24 | timer restarts |
| | `memoryInjection` | `WISSEL_MEMORY_INJECTION` | bool | off | next run |
| | `autoArchive`, `archiveCheckIntervalHours` | `WISSEL_AUTO_ARCHIVE`, `WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS` | bool, hours | off, 1 | timer restarts |
| | `modelRefresh`, `modelRefreshIntervalHours` | `WISSEL_MODEL_REFRESH`, `WISSEL_MODEL_REFRESH_INTERVAL_HOURS` | bool, hours | off, 24 | timer restarts |
| | `mergeHealth`, `mergeHealthIntervalHours` | `WISSEL_MERGE_HEALTH`, `WISSEL_MERGE_HEALTH_INTERVAL_HOURS` | bool, hours | off, 1 | timer restarts |
| | `prWatch` | `WISSEL_PR_WATCH` | bool | on | timer restarts |
| | `hostGuard` and its four thresholds | `WISSEL_HOST_GUARD`, `WISSEL_HOST_GUARD_*` | bool, numbers | off, 3, 20, 30, 2 | next reading |
| Coordinator | `channelIntervalMs` | `WISSEL_CHANNEL_INTERVAL_MS` | ms ≥ 60000 or 0 | 900000 | timer restarts |
| | `channelReadMs` | `WISSEL_CHANNEL_READ_MS` | ms ≥ 60000 or 0 | 0 | timer restarts |
| | `ownerComments` | `WISSEL_OWNER_COMMENTS` | bool | on | next hourly check |
| | `planHoldMinutes` | `WISSEL_PLAN_HOLD_MINUTES` | 0 to 1440 | 10 | next plan |
| Audio and voice | `ttsUrl`, `ttsVoice` | `WISSEL_TTS_URL`, `WISSEL_TTS_VOICE` | http(s) URL, text | Kokoro defaults | next request |
| | `sttUrl`, `sttModel`, `sttLanguage` | `WISSEL_STT_*` | URL, text, ISO 639-1 | speaches defaults | next request |

### 2.2 Stays at start-up (read-only in the tab)

- **The front door:** `WISSEL_BIND`, `WISSEL_ALLOW_OPEN_BIND`,
  `WISSEL_PORT`, `WISSEL_AUTH`, `WISSEL_PUBLIC_URL`.
  `docs/SDD-identity-and-permissions.md` §4.2 says authentication is
  configured at start, never from the database. Otherwise anyone who can
  change a setting could open the board or turn sign-in off.
- **Protections:** `WISSEL_WRITE_SANDBOX` and `WISSEL_HARD_LIMITS_PATH`.
  §6 of the same SDD: no board write may lift a hard limit or the
  sandbox.
- **Where things live:** `WISSEL_DB_PATH` (the settings are stored there),
  `WISSEL_TELEMETRY_PATH`, `WISSEL_HARNESSES_PATH`,
  `WISSEL_MCP_SERVERS_PATH`, `WISSEL_MEMORY_PATH`,
  `WISSEL_MODELS_CACHE_PATH`, `WISSEL_INTEGRATIONS_PATH`,
  `WISSEL_AUDIO_DIR`.
- **Set once, or by tools:** `WISSEL_OWNER_HANDLE`, `WISSEL_SUPERVISOR`,
  `WISSEL_COMMIT`, `WISSEL_CONCIERGE_SCRIPT` (e2e), and the CLI's
  `WISSEL_API_URL` and `WISSEL_TOKEN`.

The tab shows each with its value at start. Paths and URLs are shown;
nothing secret is read into the page (none of these holds a secret).

### 2.3 Not in scope

- Per-project settings: they already live in `POST /projects/:id/settings`.
- Harnesses, MCP servers and agents: they have their own Setup pages.
- Changing a start-up-only variable from the page.

## 3. Data model

One table in the board database, healed like every later table:

```ts
interface InstanceSettingRow {
  key: string;         // a key from the registry, §4.1
  value: string;       // JSON of the typed value
  updatedAt: string;   // ISO UTC
  updatedBy: string;   // principal id
}
```

A value is stored only after it passes the registry's validator. An
unknown key is never stored.

## 4. Design

### 4.1 The registry

`src/core/instance-settings.ts` holds one entry per setting:

```ts
interface SettingDef<T> {
  key: string;
  group: "running" | "jobs" | "coordinator" | "audio";
  label: string;              // plain words, shown in the tab
  help: string;               // one sentence, shown under it
  env: string;                // the WISSEL_* name it replaces
  default: T;
  parse(raw: string): T | undefined;   // from the env var's text, as today
  validate(v: unknown): { ok: true; value: T } | { ok: false; error: string };
  applies: "next-sweep" | "next-run" | "timer" | "next-request";
}
```

Also a list of the start-up-only names (§2.2) with their labels, for the
read-only section.

### 4.2 Precedence

`effective(key)` is, in order:
1. the env var, if set at start: source `env`, read-only;
2. the stored value: source `settings`;
3. the default: source `default`.

The env var is read once at start, as today, so a running board never
changes because its environment changed.

### 4.3 The store and reading values

`InstanceSettings` (`src/services/instance-settings.ts`) wraps the table
and the registry:
- `get(key)` gives the effective value;
- `describe()` gives every setting with value, source, default and
  group;
- `set(key, value, by)` validates and stores, and refuses an env-locked
  key with "set by WISSEL_X at start";
- it emits `changed(key)`.

Every place that reads one of the §2.1 variables today reads `get(key)`
at the moment it needs the value, not once at start:
- **The orchestrator** (`src/core/orchestrator.ts`): its sweep reads
  `orchestrator`, `executeWriteTier`, `maxConcurrentTasks`,
  `sweepSpendCeilingUsd` and `autoChain` on each pass (through a getter
  passed in its options, so tests pass fixed values).
- **The flag helpers**: `reviewGuardOn`, `autoMergeAllowed`'s env read,
  `parallelHint`, `planHoldMinutes` and the host guard's
  `thresholdsFromEnv` take the getter instead of `process.env`. Their
  env-shaped signatures stay for tests.
- **Timers** (memory curation, auto-archive, model refresh, merge
  health, PR watcher, channel post and read, owner comments): each is
  started by a small `restartable(timer, intervalKey, enabledKey)` helper,
  which clears and re-arms on `changed`. Turning one off stops it;
  turning it on starts it without a restart.

### 4.4 API

- `GET /settings`: every setting (`describe()`) and the start-up-only
  list. Needs `board.read`.
- `POST /settings/:key {value}`: the first call answers 409 with
  `{confirmRequired: true, message}` saying what changes (from → to,
  and when it applies). The same call with `"confirm": true` applies it.
  Needs `host.admin` (declared in `WRITE_ROUTES`). Each applied change is
  a policy revision (`POLICY_ACTION_KINDS`) and an authorization record,
  like a role change.
- `DELETE /settings/:key` (with the same confirm): back to the default.

### 4.5 The Settings tab

Setup > Settings in `src/api/public/board.html`, drawn by a new
`src/api/public/board-settings.js` (pure renderers, escaped, plus glue,
the same shape as `board-members.js`):
- Theme stays first.
- One panel per group with each setting's label, help, control (switch,
  number or text), its default, and its source as a chip ("default",
  "changed by milton on 28 Nov", or "set by WISSEL_X at start",
  read-only).
- Changing a control shows the server's confirm message inline, with
  **Confirm** and **Cancel**. Only Confirm sends `confirm: true`.
- A last panel, "Set at start-up", lists §2.2 read-only, each with its
  value at start and why it can't move.

### 4.6 Hard limits and security

- No §2.2 variable is readable through `POST /settings` or writable at
  all. A test asserts the registry has none of them.
- `host.admin` is never delegated to the coordinator's duties (identity
  SDD §6), so the coordinator can never change a setting.
- Values from a channel, PR, ticket or card body never reach `set`.

## 5. Tests

Gate lane:
- **Registry:**
  - every §2.1 variable has exactly one entry;
  - no §2.2 variable has one;
  - each entry's `parse` matches today's reading of that variable, the
    same text giving the same value (a table test per variable);
  - each validator refuses bad values.
- **Precedence:** env beats stored beats default. An env-locked key
  refuses `set`.
- **API:**
  - confirm step;
  - 403 without `host.admin`;
  - a policy revision and an authorization record per change;
  - `DELETE` back to the default.
- **Live effect:**
  - turning `orchestrator` on makes the next sweep route, and off stops
    it;
  - changing a timer interval re-arms it, and disabling stops it (fake
    timers);
  - `planHoldMinutes` applies to the next plan.
- **UI renderers:** escaping, the env-locked chip, the confirm flow.

End-to-end (`e2e/settings.spec.ts`, new):
- the tab lists the groups;
- a change asks to confirm, and Cancel changes nothing;
- Confirm changes the value, and a reload shows it with its source;
- an env-locked setting is read-only (the e2e server sets
  `WISSEL_PR_WATCH=0`).

## 6. Build plan (cards)

Each card is one PR, with typecheck, `bun test test/`, the app tests and
`bun run test:e2e:affected` green.

1. **Registry and store.** `src/core/instance-settings.ts` (registry,
   parse and validate per §2.1, the start-up-only list) and
   `src/services/instance-settings.ts` (table, precedence, `changed`
   events). Tests: registry coverage and parse parity, precedence. No
   behaviour change yet.
2. **API.** `GET /settings`, `POST` and `DELETE /settings/:key` with the
   confirm step, `host.admin` in `WRITE_ROUTES`
   (`src/services/permissions.ts`), and the policy revision
   (`src/services/policy-revision.ts`). Files: `src/api/server.ts`, tests.
3. **Running work, live.** The orchestrator's sweep and the flag
   helpers read the getter (`src/core/orchestrator.ts`,
   `src/core/prompt.ts`, `src/api/server.ts`). Tests: a sweep routes
   after `orchestrator` is turned on with no restart.
4. **Background jobs and coordinator timers, live.** `restartable`, and
   every timer moved onto it (`src/api/server.ts`,
   `src/services/plan-hold.ts`, the host guard). Tests: re-arm and stop
   with fake timers.
5. **Audio and voice, live.** TTS and STT read the getter per request
   (`src/services/stt.ts`, the TTS executor). Tests.
6. **The Settings tab.** `src/api/public/board-settings.js` and `.d.ts`,
   `board.html` panels and styles, `e2e/settings.spec.ts`, and the e2e
   map. Tests: renderers, e2e.
7. **Docs.** `docs/guide/configuration.md` splits the variables into
   "moved to Settings" and "start-up only", and says the env var still
   wins when set.

Cards 3, 4 and 5 depend on 1. Card 6 depends on 2. Card 7 goes last.

## 7. Where it breaks

- **A variable left in the systemd unit** keeps that switch read-only.
  That is deliberate and shown on the chip. The fix is to remove the
  line.
- **A timer that doesn't re-arm** would silently keep its old interval.
  Card 4's tests cover every timer, and the tab shows the effective
  value, not the stored one.
- **Turning the orchestrator off mid-sweep** lets running cards finish.
  It only stops new routing, as a restart does today.
