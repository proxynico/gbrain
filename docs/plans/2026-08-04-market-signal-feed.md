# Market-Signal Feed Implementation Plan

> **For agentic implementation:** use the subagent-driven-development skill to execute this plan task by task, with the required review stages.

**Goal:** Replace the unused customer-quotation pipeline with a manual, evidence-backed gbrain feed for market-rate emails forwarded by an explicitly selected person.

**Architecture:** The existing `default` source remains the read-only raw email corpus. The new `market-signals` command reads that corpus, isolates the newest forwarded original message, and writes reviewed signal records only to the existing `lp-rate-intel` derived source. A future consumer such as Drift reads `ready` records; it is not part of this change.

**Tech stack:** TypeScript, Bun, existing gbrain `BrainEngine`, Postgres/PGLite storage, existing command and operations layers.

## Constraints

- Work only in `/Users/nicomini/gbrain-worktrees/customer-rate-intel-core`.
- Use Bun and existing project dependencies.
- Keep raw source `default` read-only. Do not create, remove, register, migrate, sync, dream, embed, or run a live ingest.
- The forwarder is an explicit `--forwarder` argument. Do not encode a real email address in source, docs, fixtures, or tests; use only `.example.test` addresses.
- Extract only the newest forwarded original. Do not use wrapper text, older quoted history, attachments, or semantic search as evidence.
- Store exact evidence text and a SHA-256 hash derived from that exact original text.
- Delete the obsolete `rates` customer-quotation command and its compatibility paths. Do not leave aliases or shims.
- Keep the existing rate-intel implementation intact only until the replacement is complete and compiling; delete it in the single Task 4 cutover rather than leaving an intermediate uncompilable branch.
- Do not add a scheduler, automatic polling, Drift code, chart code, deployment, push, or source writes.

## Task 1: Forwarded-original boundary and evidence

**Files**

- Create: `src/core/market-signals/types.ts`
- Create: `src/core/market-signals/forwarded-original.ts`
- Create: `src/core/market-signals/evidence.ts`
- Create: `test/market-signals-forwarded-original.test.ts`

**Implementation**

Define market-facing types, not customer-quotation types:

```ts
export const MARKET_SIGNAL_TYPES = [
  "spot_offer",
  "rate_circular",
  "market_update",
  "capacity_offer",
] as const;

export const MARKET_SIGNAL_STATES = [
  "needs_review",
  "ready",
  "excluded",
  "needs_source_recovery",
  "superseded",
] as const;
```

Implement `extractForwardedOriginal(text)`. It finds the first forwarded-message `From:` header, returns that header and its body, and stops before the next `From:` header that starts older quoted history. It returns no value when the page is not a forwarded message. `buildEvidence` must hash only the extracted body and retain the bounded exact excerpt used for a record.

Keep the legacy rate-intel modules unchanged during this task; Task 4 removes them together after their consumers have moved.

**Tests**

- A wrapper such as “FYI” is excluded from the original body.
- Nested older messages are excluded.
- A non-forwarded email returns no original.
- Changing wrapper text does not change the evidence hash; changing extracted original text does.

## Task 2: Candidate scan and cautious parsing

**Files**

- Create: `src/core/market-signals/discovery.ts`
- Create: `src/core/market-signals/agent-pass.ts`
- Create: `src/core/market-signals/fingerprint.ts`
- Create: `src/core/market-signals/parse.ts`
- Create: `src/core/market-signals/validation.ts`
- Create: `src/core/market-signals/enumerate.ts`
- Create: `test/market-signals-discovery.test.ts`
- Create: `test/market-signals-parse.test.ts`

**Implementation**

Candidates require all of:

1. Raw page sender exactly matches the supplied forwarder.
2. A newest forwarded original can be extracted.
3. The original contains a monetary rate pattern.

Do not require quotation wording, equipment, a complete lane, or a non-carrier sender. Those would discard genuine market intelligence. Classify a candidate as `spot_offer`, `rate_circular`, `market_update`, or `capacity_offer` only when the text supports it. Extract price, currency, amount unit, lane, equipment, validity, provider, and capacity only when explicit. A missing non-price detail leads to `needs_review`, not an invented value.

Enumeration must validate the date window, cap a scan at 25 pages, bound body reads, and order pages by newest effective date then slug:

```sql
ORDER BY effective_date DESC, slug
```

Use decisions `market_signal`, `no_rate`, `needs_review`, and `needs_source_recovery`. Only `market_signal` can produce a derived signal.

**Tests**

- A forwarded spot offer, a rate circular, market update with figures, and a price-bearing capacity offer qualify.
- A forwarded request, status update, generic promotion, and SCFI/news commentary without a rate do not.
- Old quoted text cannot qualify a new wrapper.
- Missing lane/equipment is retained for review, not fabricated or rejected.
- Date validation, candidate cap, deterministic newest-first ordering, and exact forwarder matching hold.

## Task 3: Derived records, reconciliation, and operations

**Files**

- Create: `src/core/market-signals/store.ts`
- Create: `src/core/market-signals/index.ts`
- Create: `test/market-signals-store.test.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/operations.ts`

**Implementation**

Add `market_signals` config alongside the still-live `rate_intel` config, retaining the same defaults:

```ts
raw_source_id: "default"
derived_source_id: "lp-rate-intel"
```

Persist derived `market-signal` pages only in a pure database derived source. Preserve the existing bounded read, receipt, idempotency, fingerprint, reconciliation, and supersession protections. A new signal starts `needs_review`. A reviewer may explicitly set it `ready` or `excluded`, with a named reviewer and optional note. The read operation defaults to `ready` signals and exposes filters appropriate for downstream readers: state, origin, destination, equipment, currency, and signal type.

When a previously derived raw page is manually re-checked and its current forwarded original has no valid or complete rate, reconcile an empty result for that raw page: keep the historical record but mark it `superseded`, so it no longer appears in the default ready feed. Do not do this for source-recovery failures.

Add the new operations alongside the old rate-intel operations; Task 4 removes the old operations when their command and modules are removed:

```ts
read_market_signals: { type: "read", ... }
review_market_signal: { type: "write", ... }
```

**Tests**

- Derived writes reject the raw/federated source.
- A duplicate is idempotent; a changed current signal supersedes its predecessor.
- Review requires exactly one of ready or excluded plus a reviewer.
- Reader defaults to ready and filters deterministically.
- No page is written for `no_rate` or source-recovery decisions.

## Task 4: Command, guide, fixtures, and retirement

**Files**

- Create: `src/commands/market-signals.ts`
- Create: `docs/guides/market-signal-intelligence.md`
- Create: `test/fixtures/market-signals/messages.jsonl`
- Create: `test/market-signals-command.test.ts`
- Modify: `src/cli.ts`
- Modify: `docs/TESTING.md`
- Modify: `CHANGELOG.md`
- Modify: `src/core/market-signals/enumerate.ts`
- Modify: `test/market-signals-discovery.test.ts`
- Modify: `test/market-signals-store.test.ts`
- Delete: `src/commands/rates.ts`
- Delete: `docs/guides/customer-rate-intelligence.md`
- Delete: `test/fixtures/rate-intel/messages.jsonl`
- Delete: `test/rate-intel-command.test.ts`
- Delete: all remaining `src/core/rate-intel/` modules.
- Delete: all remaining `test/rate-intel-*.test.ts` tests and the legacy evidence/discovery/parse tests.

**Implementation**

Expose the smallest manual CLI:

```text
gbrain market-signals read --source DERIVED_SOURCE [--state STATE] [--origin TEXT] [--destination TEXT] [--equipment TEXT] [--currency TEXT] [--signal-type TYPE] [--limit N]
gbrain market-signals review SIGNAL_ID --ready|--exclude --reviewer TEXT [--note TEXT] --source DERIVED_SOURCE
gbrain market-signals census --source RAW_SOURCE --forwarder EMAIL [--since YYYY-MM-DD --until YYYY-MM-DD --sample N --json]
gbrain market-signals candidates --source RAW_SOURCE --forwarder EMAIL --since YYYY-MM-DD --until YYYY-MM-DD [--limit N --max-body N]
gbrain market-signals ingest --from FILE --source RAW_SOURCE --derived DERIVED_SOURCE
```

`census` and `candidates` are read-only and require `--forwarder`; `ingest` only accepts an already-built local intake file and remains unrun in this work. Command help must make source roles and non-automatic operation clear. Fixtures contain generic forwarded messages covering every task-2 case and no real identities or email addresses. The guide explains the boundary, evidence, review state, CLI, and explicit non-goals. Append a concise `CHANGELOG.md` Unreleased entry.

Retire `rates` in `src/cli.ts` and its help/engine-free routing. Remove the legacy `rate_intel` config and operations, the entire `src/core/rate-intel/` directory, and every `test/rate-intel-*.test.ts` test in this same cutover. There must be no `rates` alias, deprecated parser, customer-quotation guide, legacy config, operation, or active legacy rate-intel module left.

As part of this cutover, remove the unrequested 31-day maximum interval while retaining valid dates, bounded body reads, and the 25-page cap. Add the explicit regression that a `needs_review` decision writes no derived page.

**Tests**

- Help lists `market-signals` and does not list `rates`.
- Census/candidates reject omitted forwarder and malformed dates.
- Review rejects conflicting/no decision flags and missing reviewer.
- Fixtures and docs use only generic `.example.test` identities.

## Task 5: Verification and handoff

**Files**

- Modify only if verification reveals an implementation defect.

**Verification**

Run from the candidate worktree:

```bash
bun test test/market-signals-forwarded-original.test.ts test/market-signals-discovery.test.ts test/market-signals-parse.test.ts test/market-signals-store.test.ts test/market-signals-command.test.ts
bun run typecheck
bun run verify
rg -n -i 'customer quotation|third.party quote|rate_intel|gbrain rates|rates command' src docs test
git diff --check
git status --short
```

The retirement search may show dated changelog history only; it must not show active source, command, guide, test, or config paths. Do not run `market-signals ingest` against live data. Report exact command results, the worktree/branch, and that live execution, scheduling, source registration, Drift consumption, deployment, and push remain intentionally untouched.
