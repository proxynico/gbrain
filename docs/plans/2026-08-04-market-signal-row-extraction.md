# Market-Signal Row Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use nicopowers:subagent-driven-development to implement this plan task-by-task. Use nicopowers:executing-plans only when the user explicitly asks for inline execution. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Turn one manually selected forwarded rate-table email into one review-only derived record per concrete container-rate row without touching the raw email archive.

**Architecture:** Delete the email-wide first-price parser. A pure row module recognizes only the proven flattened table shape: POL, POD, ETD, RATE, SSL headings followed by five-value records. It emits one observation for each literal currency amount/equipment pair and rejects prose. The store accepts several observations from one raw page, fingerprints each row independently, and retains receipts plus the named-reviewer gate.

**Tech Stack:** TypeScript, Bun test runner, existing gbrain BrainEngine, manual market-signals CLI and operations contract.

## Global Constraints

- Use an isolated local worktree from nicobrain-v04263-live; do not push, open a PR, or edit unrelated untracked files.
- default remains a read-only raw-email source. No sync, scheduler, polling, source registration, model call, or automatic ingest.
- Retain exact-forwarder matching, forwarded-original isolation, a 25-page candidate cap, 20,000-character body cap, and raw-page-reference-only intake.
- A stored row must literally contain price, currency, origin, destination, and equipment in a recognized table row. Departure/date is optional and never invented.
- New records begin needs_review; reads default to ready; a named human reviewer alone chooses ready or excluded.
- Do not retain the obsolete email-wide parser as a fallback. Narrative averages, commentary, wrapper text, and quoted history must not become records.
- Test fixtures use only .example.test identities and fabricated ports/rates. Bun only. Commit each independently testable task locally.

---

## File map

| File | Change |
|---|---|
| src/core/market-signals/types.ts | Row observation and exact row-evidence types. |
| src/core/market-signals/rate-rows.ts | New pure flattened-table parser. |
| src/core/market-signals/evidence.ts | Original-body and row hashes. |
| src/core/market-signals/fingerprint.ts | Row-scoped identity. |
| src/core/market-signals/agent-pass.ts | One candidate per row, not per email. |
| src/core/market-signals/store.ts | Row-array persistence and reconciliation. |
| src/commands/market-signals.ts | Flatten results from each intake reference. |
| test/market-signals-rate-rows.test.ts | New pure parser coverage. |
| test/market-signals-discovery.test.ts | Multi-row read-only candidate coverage. |
| test/market-signals-store.test.ts | Multi-row persistence and reconciliation. |
| test/market-signals-command.test.ts | CLI reporting and intake coverage. |
| docs/guides/market-signal-intelligence.md, docs/architecture/KEY_FILES.md, docs/TESTING.md | Current operator and testing truth. |

## Task 1: Replace the email-wide parser with strict rate-table row extraction

**Files:**
- Create: src/core/market-signals/rate-rows.ts
- Create: test/market-signals-rate-rows.test.ts
- Modify: src/core/market-signals/types.ts, evidence.ts, fingerprint.ts
- Preserve temporarily: src/core/market-signals/parse.ts, test/market-signals-parse.test.ts

**Interfaces:**
- Consumes ForwardedOriginal with header and body.
- Produces extractMarketSignalRows(original): ExtractedMarketSignalRow[].
- Produces ExtractedMarketSignalRow with signalType market_update, amount, currency, amountUnit CONTAINER, route, equipment, optional departure, provider, and evidenceExcerpt.
- Produces MarketSignalEvidence with excerpt, originalSha256, and rowSha256.

- [ ] **Step 1: Write failing parser tests**

Create test/market-signals-rate-rows.test.ts:

    import { describe, expect, test } from 'bun:test';
    import { extractMarketSignalRows } from '../src/core/market-signals/rate-rows.ts';

    const original = (body: string) => ({ header: 'From: provider@example.test', body });

    describe('market-signal rate-table rows', () => {
      test('splits flattened rows and multiple equipment prices', () => {
        const rows = extractMarketSignalRows(original([
          'POL', 'POD', 'ETD', 'RATE', 'SSL',
          'Port Alpha', 'Port Beta', '04-10-AUG', 'USD 1200/20GP USD 2100/40HQ', 'Carrier One',
          'Port Gamma', 'Port Delta', '11-17-AUG', 'EUR 900/20GP', 'Carrier Two',
        ].join('\n')));
        expect(rows).toEqual(expect.arrayContaining([
          expect.objectContaining({ amount: 1200, currency: 'USD', equipment: '20GP', lane: { origin: 'Port Alpha', destination: 'Port Beta' }, departure: '04-10-AUG' }),
          expect.objectContaining({ amount: 2100, currency: 'USD', equipment: '40HQ', lane: { origin: 'Port Alpha', destination: 'Port Beta' }, departure: '04-10-AUG' }),
          expect.objectContaining({ amount: 900, currency: 'EUR', equipment: '20GP', lane: { origin: 'Port Gamma', destination: 'Port Delta' }, departure: '11-17-AUG' }),
        ]));
      });

      test('allows a blank departure only for review later', () => {
        const rows = extractMarketSignalRows(original([
          'POL', 'POD', 'ETD', 'RATE', 'SSL',
          'Port Alpha', 'Port Beta', '', 'USD 1200/20GP', 'Carrier One',
        ].join('\n')));
        expect(rows).toEqual([expect.objectContaining({ departure: undefined, amount: 1200, equipment: '20GP' })]);
      });

      test('rejects prose and unheaded market-average values', () => {
        expect(extractMarketSignalRows(original('Market average: USD 9999 per container.'))).toEqual([]);
      });
    });

- [ ] **Step 2: Prove the test fails before implementation**

Run:

    bun test test/market-signals-rate-rows.test.ts

Expected: FAIL because rate-rows.ts does not exist.

- [ ] **Step 3: Define row and evidence types**

In types.ts, replace the old one-body evidence shape with:

    export interface MarketSignalEvidence {
      excerpt: string;
      originalSha256: string;
      rowSha256: string;
    }

    export interface ExtractedMarketSignalRow {
      signalType: 'market_update';
      amount: number;
      currency: string;
      amountUnit: 'CONTAINER';
      lane: { origin: string; destination: string };
      equipment: string;
      departure?: string;
      provider: string;
      evidenceExcerpt: string;
    }

Change buildEvidence(original, excerpt) to reject empty, oversized, and non-substring excerpts, then calculate both hashes with createHash('sha256'). It must never accept caller-provided hashes.

- [ ] **Step 4: Implement strict row parsing**

Create rate-rows.ts. Find an exact contiguous headings tuple. Form only five-cell row groups. Blank ETD is legal; blank/missing POL, POD, RATE, or SSL discards a group. evidenceExcerpt must be the literal source substring from the first non-empty row cell through the carrier cell.

    const HEADERS = ['POL', 'POD', 'ETD', 'RATE', 'SSL'] as const;
    const RATE_PAIR = /\b(USD|EUR|GBP|CNY|HKD|JPY|SGD|AUD|CAD|NZD|AED|THB|VND|INR|KRW)\s*([\d,]+(?:\.\d+)?)\s*\/\s*(20GP|20DV|40GP|40DV|40HC|40HQ|45HQ)\b/giu;

    function externalProvider(header: string): string {
      const provider = /^From:\s*(.+)$/iu.exec(header)?.[1]?.trim();
      if (!provider) throw new Error('recognized rate table lacks external provider');
      return provider;
    }

    export function extractMarketSignalRows(original: ForwardedOriginal): ExtractedMarketSignalRow[] {
      // Locate HEADERS exactly, consume five-cell groups, and emit one row per
      // RATE_PAIR in the RATE cell. Never scan unrelated prose.
    }

For each match set signalType market_update, amountUnit CONTAINER, lane from POL/POD, provider from the external From header, and departure only when ETD has a value. SSL stays in exact evidence only; do not infer provider from it.

- [ ] **Step 5: Make fingerprints row-scoped**

Change fingerprintMarketSignal to consume a row, its evidence, and its source slug:

    export function fingerprintMarketSignal(
      row: ExtractedMarketSignalRow,
      evidence: MarketSignalEvidence,
      sourceSlug: string,
    ): string {
      return createHash('sha256').update(JSON.stringify({
        sourceSlug,
        originalSha256: evidence.originalSha256,
        rowSha256: evidence.rowSha256,
        signalType: row.signalType,
        amount: row.amount,
        currency: row.currency,
        amountUnit: row.amountUnit,
        origin: row.lane.origin,
        destination: row.lane.destination,
        equipment: row.equipment,
        departure: row.departure ?? null,
        provider: row.provider,
      })).digest('hex');
    }

- [ ] **Step 6: Pass focused parser tests**

Run:

    bun test test/market-signals-rate-rows.test.ts test/market-signals-forwarded-original.test.ts

Expected: tests PASS. Keep the legacy parser temporarily so Task 2 can switch its only consumer without leaving the branch unbuildable.

- [ ] **Step 7: Commit Task 1**

    git add src/core/market-signals/types.ts src/core/market-signals/rate-rows.ts src/core/market-signals/evidence.ts src/core/market-signals/fingerprint.ts test/market-signals-rate-rows.test.ts
    git commit -m "market-signals: extract rate-table rows"

## Task 2: Produce and store several review records from one raw email

**Files:**
- Modify: src/core/market-signals/agent-pass.ts, src/core/market-signals/store.ts
- Modify: test/market-signals-discovery.test.ts, test/market-signals-store.test.ts
- Delete: src/core/market-signals/parse.ts, test/market-signals-parse.test.ts

**Interfaces:**
- MarketSignalCandidate has slug, sender, effectiveDate, original, and exactly one row.
- MarketSignalStore.persistDecision(input) returns Promise<MarketSignal[]>.
- MarketSignal replaces required validity with optional departure and uses row evidence.

- [ ] **Step 1: Write failing discovery and storage tests**

Add to discovery tests:

    test('returns one candidate for each rate pair in one matching email', async () => {
      const candidates = await collectMarketSignalCandidates(engineReturning([
        page(forwardedMessage([
          'POL', 'POD', 'ETD', 'RATE', 'SSL',
          'Port Alpha', 'Port Beta', '04-10-AUG', 'USD 1200/20GP USD 2100/40HQ', 'Carrier One',
        ].join('\n'))),
      ]) as never, { sourceId: 'default', forwarder: FORWARDER, since: '2026-08-01', until: '2026-08-05' });
      expect(candidates.map(candidate => candidate.row.equipment)).toEqual(['20GP', '40HQ']);
    });

Add to storage tests:

    test('stores a core-complete no-departure row as needs_review only', async () => {
      await putRawPage(DEFAULT_SOURCE_SLUG, { body: flattenedTableWithBlankDeparture() });
      const signals = await persist();
      expect(signals).toEqual([expect.objectContaining({ state: 'needs_review', departure: undefined })]);
      expect((await store.readMarketSignals({ sourceId: 'lp-rate-intel' })).signals).toEqual([]);
    });

    test('supersedes only a changed row while retaining an unchanged sibling', async () => {
      await putRawPage(DEFAULT_SOURCE_SLUG, { body: twoRateTable('1200', '2100') });
      const before = await persist();
      await putRawPage(DEFAULT_SOURCE_SLUG, { body: twoRateTable('1300', '2100') });
      const after = await persist();
      const all = await store.readMarketSignals({ sourceId: 'lp-rate-intel', states: ['needs_review', 'superseded'] });
      expect(all.signals).toEqual(expect.arrayContaining([
        expect.objectContaining({ signalId: before[0]?.signalId, state: 'superseded' }),
        expect.objectContaining({ signalId: after[1]?.signalId, state: 'needs_review' }),
      ]));
    });

- [ ] **Step 2: Prove the current one-email shape fails**

Run:

    bun test test/market-signals-discovery.test.ts test/market-signals-store.test.ts

Expected: FAIL because discovery carries one assessment and persistDecision returns a single value or undefined.

- [ ] **Step 3: Emit one candidate per extracted row**

In agent-pass.ts, remove imports of the deleted parser/validation types. Preserve exact sender and forwarded-original logic. After isolation call extractMarketSignalRows; an empty row array returns no_rate and writes nothing.

    const rows = extractMarketSignalRows(original);
    if (rows.length === 0) return { decision: 'no_rate' };
    return {
      decision: 'market_signal',
      candidates: rows.map(row => ({
        slug: page.slug,
        sender: sender!,
        effectiveDate: page.effective_date,
        original,
        row,
      })),
    };

collectMarketSignalCandidates appends every candidate in newest-page then source-row order. It remains read-only and bounded to 25 pages.

After replacing the consumer, delete parse.ts and market-signals-parse.test.ts. Verify no code still imports the removed email-wide parser:

    rg -n 'parseMarketSignal|ParsedMarketSignal|asDerivedMarketSignal' src test

Expected: no result.

- [ ] **Step 4: Refactor storage to materialize row arrays**

Remove ParsedMarketSignal, completeParsedField, and signalFromAssessment. Implement:

    function signalFromRow(
      sourceSlug: string,
      rawSourceId: string,
      row: ExtractedMarketSignalRow,
      evidence: MarketSignalEvidence,
    ): MarketSignal {
      const fingerprint = fingerprintMarketSignal(row, evidence, sourceSlug);
      return {
        signalId: 'market-signal-' + fingerprint,
        rawSourceId,
        sourceSlug,
        signalType: row.signalType,
        amount: row.amount,
        currency: row.currency,
        amountUnit: row.amountUnit,
        origin: row.lane.origin,
        destination: row.lane.destination,
        equipment: row.equipment,
        ...(row.departure === undefined ? {} : { departure: row.departure }),
        provider: row.provider,
        evidence,
        fingerprint,
        state: 'needs_review',
      };
    }

Carry optional departure through MarketSignal, metadata, stored-page validation, and rendering. Render a missing departure as not provided; never call it validity. Keep pure-database source checks and transaction semantics.

- [ ] **Step 5: Reconcile all current rows atomically**

persistDecision reloads and sender-checks the raw page exactly as today. Build all signals, stage a receipt containing every id, and reconcile that complete array. An email with no extracted rows writes an empty receipt and reconciles zero rows. Missing raw page, wrong forwarder, or unrecoverable-original failures preserve prior history.

    const signals = assessed.candidates.map(candidate => signalFromRow(
      reference.sourceSlug,
      this.options.rawSourceId,
      candidate.row,
      buildEvidence(candidate.original, candidate.row.evidenceExcerpt),
    ));
    await this.#putReceipt({
      sourceSlug: reference.sourceSlug,
      signalIds: signals.map(signal => signal.signalId),
      processedAt: new Date().toISOString(),
    });
    await this.#reconcileMarketSignals(reference.sourceSlug, signals);
    return Promise.all(signals.map(signal => this.#readPersisted(signal.signalId)));

A named reviewer may mark a no-departure row ready. Do not add field editing or automatic ready decisions.

- [ ] **Step 6: Pass Task 2 tests**

Run:

    bun test test/market-signals-rate-rows.test.ts test/market-signals-forwarded-original.test.ts test/market-signals-discovery.test.ts test/market-signals-store.test.ts

Expected: PASS, including default-ready reads, no-departure review records, and single-sibling supersession.

- [ ] **Step 7: Commit Task 2**

    git add src/core/market-signals/agent-pass.ts src/core/market-signals/store.ts src/core/market-signals/parse.ts test/market-signals-discovery.test.ts test/market-signals-store.test.ts test/market-signals-parse.test.ts
    git commit -m "market-signals: store rows for manual review"

## Task 3: Preserve the manual CLI contract and update docs

**Files:**
- Modify: src/commands/market-signals.ts, test/market-signals-command.test.ts
- Modify: docs/guides/market-signal-intelligence.md, docs/architecture/KEY_FILES.md, docs/TESTING.md

**Interfaces:**
- candidates returns one read-only candidate per extracted rate row.
- ingest remains raw-reference-only but reports several MarketSignal records for a source slug.
- read_market_signals and review_market_signal names and source authorization stay unchanged.

- [ ] **Step 1: Write a failing CLI result test**

    test('ingest reports every persisted row for one source reference', async () => {
      const result = await runMarketSignals(engine, [
        'ingest', '--from', intakePath, '--source', 'default', '--derived', 'lp-rate-intel',
      ], { config, write: () => {} });
      expect(result).toMatchObject({ processed: 1, signals: [
        expect.objectContaining({ equipment: '20GP', state: 'needs_review' }),
        expect.objectContaining({ equipment: '40HQ', state: 'needs_review' }),
      ] });
    });

Keep the intake fixture restricted to sourceSlug and forwarder. Add an assertion that help calls candidates recognized rate-table rows.

- [ ] **Step 2: Prove the CLI result test fails**

Run:

    bun test test/market-signals-command.test.ts

Expected: FAIL because ingest pushes one result per source reference.

- [ ] **Step 3: Flatten only ingest output**

Replace the single-result loop in runMarketSignals:

    const signals: MarketSignal[] = [];
    for (const record of records) {
      signals.push(...await store.persistDecision(record));
    }
    const result = { processed: records.length, signals };

Do not expand intake fields, change source checks, register a new operation, or mark anything ready during ingest. Update help: a selected email may produce several needs_review rows.

- [ ] **Step 4: Rewrite current-state docs**

Add this behavior to the guide and reflect it in Key Files and Testing:

    Only a recognized flattened rate table is eligible. One table row creates one
    derived review record per explicit container-rate pair. Narrative values,
    forwarder wrappers, quoted history, requests, and malformed/unrecognized tables
    write nothing. A row with price, route, and equipment but no departure/date is
    stored as needs_review; downstream reads still default to ready only.

Do not add live data, real senders, or authorization for a real ingest.

- [ ] **Step 5: Pass Task 3 checks**

Run:

    bun test test/market-signals-command.test.ts test/market-signals-discovery.test.ts test/market-signals-store.test.ts
    git diff --check

Expected: tests PASS and no whitespace errors.

- [ ] **Step 6: Commit Task 3**

    git add src/commands/market-signals.ts test/market-signals-command.test.ts docs/guides/market-signal-intelligence.md docs/architecture/KEY_FILES.md docs/TESTING.md
    git commit -m "market-signals: document table-row review flow"

## Task 4: Verify locally without real corpus writes

**Files:**
- Modify only if a check exposes a concrete defect from Tasks 1-3.

**Interfaces:**
- Exercises manual CLI and existing read/review operations through hermetic tests only.

- [ ] **Step 1: Run the full market-signal slice**

    bun test test/market-signals-forwarded-original.test.ts test/market-signals-rate-rows.test.ts test/market-signals-discovery.test.ts test/market-signals-store.test.ts test/market-signals-command.test.ts

Expected: PASS without real corpus or derived-source writes.

- [ ] **Step 2: Run type and repository verification**

    bun run typecheck
    bash scripts/run-verify-parallel.sh
    git diff --check

Expected: all exit 0.

- [ ] **Step 3: Prove scope and automation remain absent**

    git diff --name-only nicobrain-v04263-live...HEAD
    rg -n 'autopilot|sync --watch|jobs work|cron|schedule|sources add' src/core/market-signals src/commands/market-signals.ts

Expected: changed files match this plan and the scan finds no new execution path.

- [ ] **Step 4: Commit only a concrete verification repair**

If a check finds a specific defect and it is repaired:

    git add <exact repaired files>
    git commit -m "market-signals: verify row extraction"

Otherwise make no empty commit.

## Self-review

- **Spec coverage:** Task 1 blocks prose and extracts separate equipment prices. Task 2 stores one review record per pair, permits no-date review rows, and reconciles siblings. Task 3 keeps the manual source-scoped interface. Task 4 proves local-only behavior.
- **Placeholder scan:** No TODO/TBD or unspecified error handling remains.
- **Type consistency:** ExtractedMarketSignalRow is produced by rate-rows.ts, becomes a discovery candidate, then a MarketSignal. persistDecision returns MarketSignal[] to the CLI; default readers still receive ready rows only.
