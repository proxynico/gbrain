# Gbrain Reliability Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use nicopowers:subagent-driven-development to implement this plan task-by-task. Use nicopowers:executing-plans only when the user explicitly asks for inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live gbrain Postgres brain recoverable, clear its only stale sync-failure warning, and re-audit reliability without changing recall semantics.

**Architecture:** A dedicated shell command creates a PostgreSQL custom-format dump on the mounted, encrypted NicoDev volume, validates its archive, calculates a checksum, rotates only prior dumps in its exact directory, and writes a small local health record. A separate restore-check command restores the newest dump into a uniquely named temporary database and verifies the schema/version/page count before dropping only that temporary database. OpenClaw schedules the backup after existing gbrain maintenance. The stale failure ledger is acknowledged through gbrain's own exported helper only after proving its source is absent.

**Tech Stack:** POSIX shell, PostgreSQL 17 (`pg_dump`, `pg_restore`, `createdb`, `dropdb`, `psql`), OpenClaw cron, Bun test runner, gbrain local Postgres engine.

## Global Constraints

- Canonical live database: `gbrain` on `127.0.0.1`, owned by local user `nicomini`; never print its connection URL or credentials.
- Backup destination: `/Volumes/NicoDev/mini-runtime/backups/gbrain-postgres`; NicoDev is mounted, encrypted, and has 906 GiB free.
- Keep seven daily custom-format dumps, each owner-readable only; never remove anything outside the exact backup directory.
- Do not hand-run lane-managed `sync`, `dream`, `embed`, `jobs work`, or `autopilot`.
- Do not alter sources, schema packs, search mode, global link policy, extraction policy, or model routing in this scope.
- Capture baseline before each mutation and stop if an autonomous gbrain sync/import/dream/embed job is active.
- Run all operational commands from `/Users/nicomini`; never store secrets in scripts, logs, health JSON, or the plan.

---

### Task 1: Establish a verified Postgres backup and restore check

**Files:**
- Create: `/Users/nicomini/bin/gbrain-postgres-backup`
- Create: `/Users/nicomini/bin/gbrain-postgres-restore-check`
- Create: `/Users/nicomini/Library/Logs/gbrain-postgres-backup.log` (created by scheduler on first run)
- Create: `/Users/nicomini/runtime/health/gbrain-postgres-backup.json` (created by backup command)

**Interfaces:**
- Consumes: local PostgreSQL service, database `gbrain`, mounted `/Volumes/NicoDev`, `pg_dump`/`pg_restore`/`psql`/`createdb`/`dropdb` PostgreSQL 17 tools.
- Produces: `<backup-root>/gbrain-postgres-<UTC timestamp>.dump`, matching `.sha256`, and health JSON containing timestamp, dump path, byte count, SHA-256, page count, schema version, and retention count.
- The restore command consumes the newest `.dump`, restores only to `gbrain_restore_check_<timestamp>`, and emits a concise pass/fail record without querying or modifying `gbrain`.

- [ ] **Step 1: Write a failing shell-contract test**

Create a temporary fixture directory, place executable stub commands named `pg_dump`, `pg_restore`, `psql`, `createdb`, and `dropdb` first in `PATH`, and invoke each new script with `GBRAIN_BACKUP_ROOT=<fixture>/backups`, `GBRAIN_PG_BIN=<fixture>/bin`, and `GBRAIN_HEALTH_DIR=<fixture>/health`. Assert that the backup script rejects an unmounted or unwritable target before calling `pg_dump`; assert that a successful stub dump produces one `.dump`, one `.sha256`, and health JSON; assert the restore script calls `createdb`, `pg_restore`, verifies both `schema_version` and `pages`, and invokes `dropdb` in its cleanup trap.

```sh
test "$(find "$fixture/backups" -name '*.dump' | wc -l | tr -d ' ')" = 1
test "$(jq -r '.ok' "$fixture/health/gbrain-postgres-backup.json")" = true
grep -q 'createdb' "$fixture/calls.log"
grep -q 'dropdb' "$fixture/calls.log"
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `sh /Users/nicomini/bin/test-gbrain-postgres-backup-contract`

Expected: FAIL because the backup and restore commands do not yet exist.

- [ ] **Step 3: Implement `gbrain-postgres-backup`**

Implement an executable shell command with these non-negotiable behaviors:

```sh
BACKUP_ROOT="${GBRAIN_BACKUP_ROOT:-/Volumes/NicoDev/mini-runtime/backups/gbrain-postgres}"
HEALTH_DIR="${GBRAIN_HEALTH_DIR:-/Users/nicomini/runtime/health}"
PG_BIN="${GBRAIN_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PGHOST="${PGHOST:-127.0.0.1}"
PGDATABASE="${PGDATABASE:-gbrain}"
KEEP="${GBRAIN_BACKUP_KEEP:-7}"
```

Require that `/Volumes/NicoDev` is mounted when the default destination is used, create only `BACKUP_ROOT` and `HEALTH_DIR` with owner-only permissions, run `pg_dump --format=custom --compress=zstd:3 --file <temporary dump>`, verify with `pg_restore --list`, calculate `shasum -a 256`, atomically rename the dump and checksum, query only `schema_migrations` and `pages` from the live database, write JSON atomically, and retain the seven newest matching `gbrain-postgres-*.dump` plus their checksums. Delete only exact, enumerated expired files after verifying their parent is exactly `BACKUP_ROOT`.

- [ ] **Step 4: Implement `gbrain-postgres-restore-check`**

Implement an executable shell command that resolves the newest verified dump from `BACKUP_ROOT`, creates `gbrain_restore_check_<UTC timestamp>`, restores with `pg_restore --dbname`, checks the restored `schema_migrations` version and `pages` count against the backup health record, then drops only that exact generated database in an `EXIT` trap. It must reject a database name not matching `^gbrain_restore_check_[0-9]{8}T[0-9]{6}Z$` before invoking `dropdb`.

- [ ] **Step 5: Run the contract test and verify it passes**

Run: `sh /Users/nicomini/bin/test-gbrain-postgres-backup-contract`

Expected: PASS; fixture contains the expected backup artifacts and the restore cleanup is recorded.

- [ ] **Step 6: Run the production backup and isolated restore check once**

Run:

```sh
/Users/nicomini/bin/gbrain-postgres-backup
/Users/nicomini/bin/gbrain-postgres-restore-check
```

Expected: a validated custom-format dump and checksum under `/Volumes/NicoDev/mini-runtime/backups/gbrain-postgres`; restore report matches the live schema/version and page count; no `gbrain_restore_check_*` database remains.

### Task 2: Schedule the verified backup in the existing operational scheduler

**Files:**
- Modify: OpenClaw cron store through `openclaw cron add` (no direct store edits)
- Modify: `/Users/nicomini/Library/Logs/gbrain-postgres-backup.log` (scheduler output after first run)

**Interfaces:**
- Consumes: `/Users/nicomini/bin/gbrain-postgres-backup` from Task 1.
- Produces: one enabled isolated OpenClaw command job named `gbrain-postgres-backup`, scheduled daily at 03:40 Asia/Hong_Kong, with no channel delivery.

- [ ] **Step 1: Write the failing scheduler assertion**

Run a read-only list command that selects `name == "gbrain-postgres-backup"` and fails unless exactly one enabled job has cron expression `40 3 * * *`, timezone `Asia/Hong_Kong`, and command `/Users/nicomini/bin/gbrain-postgres-backup`.

```sh
openclaw cron list --json | jq -e '
  [.jobs[] | select(.name == "gbrain-postgres-backup" and .enabled == true)]
  | length == 1
'
```

- [ ] **Step 2: Run the assertion and verify it fails**

Run the assertion from Step 1.

Expected: FAIL because no gbrain Postgres backup cron exists.

- [ ] **Step 3: Create the cron through OpenClaw**

Run:

```sh
openclaw cron add \
  --name gbrain-postgres-backup \
  --description 'Verified daily custom-format backup of the local gbrain Postgres database' \
  --cron '40 3 * * *' \
  --tz Asia/Hong_Kong \
  --command /Users/nicomini/bin/gbrain-postgres-backup \
  --command-cwd /Users/nicomini \
  --session isolated \
  --no-deliver \
  --timeout-seconds 5400 \
  --json
```

- [ ] **Step 4: Re-run the scheduler assertion and verify it passes**

Run the Step 1 assertion, then `openclaw cron get <created-id> --json`.

Expected: exactly one enabled matching job; no delivery target; command and timezone match the contract.

### Task 3: Acknowledge the proven-retired sync failure without touching sources

**Files:**
- Modify: `/Users/nicomini/.gbrain/sync-failures.jsonl` through gbrain’s `acknowledgeSyncFailures()` helper
- Create: `/Volumes/NicoDev/mini-runtime/backups/gbrain-postgres/sync-failures-before-<UTC timestamp>.jsonl`

**Interfaces:**
- Consumes: one unacknowledged record `{source_id:"srcE", path:"notes/bad.md", code:"SLUG_MISMATCH"}` and the current source registry.
- Produces: the same ledger record marked `acknowledged: true` with an acknowledgement timestamp; no source import, sync, or deletion.

- [ ] **Step 1: Write the failing precondition assertion**

Run a read-only assertion that proves exactly one unacknowledged failure exists, it is `srcE:notes/bad.md`, and `srcE` is absent from both active and archived source lists.

```sh
test "$(jq -s '[.[] | select(.acknowledged != true)] | length' /Users/nicomini/.gbrain/sync-failures.jsonl)" = 1
! /opt/homebrew/bin/gbrain sources list --json | jq -e '.sources[] | select(.id == "srcE")' >/dev/null
```

- [ ] **Step 2: Run the precondition assertion and verify it passes**

Expected: PASS. If it fails, stop; the source may have been restored or a second failure appeared and a blanket acknowledgement is unsafe.

- [ ] **Step 3: Preserve the exact ledger and acknowledge it through gbrain code**

Copy the ledger with `cp -p` to the Task 3 backup path, then run from `/Users/nicomini/gbrain`:

```sh
bun -e 'import { acknowledgeSyncFailures } from "./src/core/sync.ts"; console.log(JSON.stringify(acknowledgeSyncFailures()));'
```

Expected: structured result with `count: 1` and a `SLUG_MISMATCH` summary. Do not use `gbrain sync --skip-failed`: it would also enter a source sync path.

- [ ] **Step 4: Verify the result and regression test**

Run:

```sh
bun test test/sync-failures.test.ts
/opt/homebrew/bin/gbrain doctor --json | jq '.checks[] | select(.name == "sync_failures")'
```

Expected: all sync-failure tests pass; doctor reports the record as historical/acknowledged rather than unresolved.

### Task 4: Make the sync-failure test harness safe for the live host

**Files:**
- Modify: `test/sync-failures.test.ts`

**Interfaces:**
- Consumes: `GBRAIN_HOME`, which `configDir()` defines as a parent directory and expands to `<GBRAIN_HOME>/.gbrain`.
- Produces: a focused test suite whose ledger path is always inside one dedicated temporary parent directory; it never changes process-wide `HOME` or points at `/Users/nicomini/.gbrain`.

- [ ] **Step 1: Add a failing isolation regression assertion**

Add a test that asserts the resolved `syncFailuresPath()` is under the suite's dedicated temporary parent as `<suite-root>/.gbrain/sync-failures.jsonl`, and that the test setup leaves the inherited `HOME` unchanged. Do not run the current suite with the real home directory: use a fresh outer `HOME` and unset `GBRAIN_HOME` for the red run.

- [ ] **Step 2: Run the focused test safely and verify the isolation assertion fails**

Run with an empty temporary outer home, for example:

```sh
test_home="$(mktemp -d)" && env -u GBRAIN_HOME HOME="$test_home" bun test test/sync-failures.test.ts; status=$?; rm -rf "$test_home"; exit "$status"
```

Expected: FAIL only on the new isolation assertion. The outer temporary home ensures the existing unsafe setup cannot touch the live ledger during this red run.

- [ ] **Step 3: Replace the `HOME` mutation with one stable `GBRAIN_HOME` test root**

Set `GBRAIN_HOME` once in `beforeAll` to an absolute `mkdtempSync` parent directory (not a `.gbrain` child), retain its original value, and restore it in `afterAll`. Keep `HOME` unchanged. In each `beforeEach`, delete only `syncFailuresPath()` within that stable root. In `afterAll`, remove only that exact root. Use `beforeAll`/`afterAll` rather than per-test process-environment switches so concurrent tests cannot resolve the production ledger between hooks.

- [ ] **Step 4: Re-run the focused suite in the safe outer environment**

Re-run the command from Step 2. Expected: all tests pass; the isolated test root is removed; the live ledger checksum and modification time are unchanged.

- [ ] **Step 5: Commit only the test-isolation repair**

Create one narrow commit containing only `test/sync-failures.test.ts`. Do not include the untracked plan or `.context` evidence.

### Task 5: Verify the reranker and maintenance conclusions without speculative configuration changes

**Files:**
- Create: `/Users/nicomini/runtime/health/gbrain-reliability-audit-<UTC timestamp>.json`

**Interfaces:**
- Consumes: active model config, `rerank-failures` audit rotation, current maintenance job results, source status, backup health output.
- Produces: a read-only reliability audit that separates current defects from historical quality warnings.

- [ ] **Step 1: Establish reranker baseline**

Run `gbrain models --json` and `gbrain models doctor --json`, separating stderr progress from JSON before parsing. Record only model names, config presence, probe status, and audit-file newest timestamp; never print provider keys.

- [ ] **Step 2: Verify no active default reranker fault**

Confirm `search.mode` has no explicit override (balanced fallback), explicit reranker config is absent, and no reranker failure has been appended after the audit baseline during source-bounded retrieval smoke tests. Do not set a credential or disable a setting that is not active.

- [ ] **Step 3: Verify maintenance safety without modifying it**

Check the last scheduled maintenance job completed under its 5,400-second timeout, current queues are empty, and there is no active sync/import/dream/embed process. Preserve the current runner because the observed eight-minute duration is within its timeout and no queue stall exists.

- [ ] **Step 4: Write and inspect the final audit record**

Write JSON atomically with: backup age/checksum/restore result, cron identity, full doctor status and reliability-only warnings, source/job/service summaries, reranker historical-versus-current verdict, and explicitly deferred quality work. Run `jq empty` on the file, `gbrain doctor --json`, `gbrain sources status --json`, `gbrain jobs stats`, and three source-bounded query smoke tests with output discarded.

Expected: backup/recovery is proven, no unresolved sync failures remain, service/DB/queue/retrieval are healthy, and any remaining doctor warnings are quality or historical-observability items rather than reliability defects.

## Self-Review

- Coverage: Tasks 1–2 establish and schedule recovery; Task 3 resolves the only open sync ledger issue; Task 4 makes its regression test safe on the live host; Task 5 verifies reranker/maintenance evidence and produces the requested post-fix audit.
- Placeholder scan: no unscoped file paths, commands, or acceptance checks remain.
- Interface consistency: Task 1 produces the command and health record consumed by Tasks 2 and 4; Task 3 mutates only the ledger after an exact precondition; Task 4 is read-only except for its timestamped audit record.
