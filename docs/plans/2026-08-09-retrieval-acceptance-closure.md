# Retrieval Acceptance Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development for the implementation and verification-before-completion before reporting success.

**Goal:** Make federated search surface the intended weekly market summary and raw meeting transcript without hard-filtering ordinary retrieval.

**Architecture:** Extend the deterministic query classifier with optional preferred page types for two narrow intents. When a preference is present, hybrid search runs one additional bounded typed recall arm with the same source scope, exclusion policy, query text, and already-computed query embedding as the ordinary arms, then fuses it through the existing reciprocal-rank-fusion pipeline. The ordinary arms remain unchanged and the preference fails open.

**Tech Stack:** TypeScript, Bun 1.3.14 through `mise`, PGLite, the existing gbrain hybrid-search and AI test seams.

## Global Constraints

- Use only generic fictional fixtures; no real people, companies, funds, meetings, or corpus text.
- Preserve `sourceId`/`sourceIds`, date bounds, language/symbol filters, hard exclusions, embedding column, and other existing search constraints on every added engine call.
- Treat preferred types as a candidate-recall hint, never as a filter on the ordinary arms.
- Add at most one bounded typed keyword/title/vector recall group per matching query.
- Reuse the existing text query embedding; do not add an embedding request.
- Keep image-only routing unchanged and do not run the typed text arm for image-only queries.
- Add no dependency, configuration switch, source-ID special case, compatibility shim, or migration.
- Use `source ~/.zshrc 2>/dev/null || true` before tests and invoke Bun through `mise exec -- bun`; never use npm or Yarn.
- Do not run live `sync`, `dream`, `embed`, `jobs work`, or `autopilot` commands.

### Task 1: Add preferred-type recall and close both retrieval acceptances

**Files:**

- Modify: `src/core/search/query-intent.ts`
- Modify: `src/core/search/hybrid.ts`
- Modify: `src/core/search/mode.ts`
- Modify: `test/query-intent.test.ts`
- Create: `test/search/preferred-type-recall.serial.test.ts`
- Modify: `test/search-mode.test.ts`
- Modify: `docs/architecture/RETRIEVAL.md`
- Modify: `docs/architecture/KEY_FILES.md`

**Behavioral contract:**

- `QuerySuggestions` gains `preferredTypes?: PageType[]`.
- A query containing `market` plus `last week` or `this week` suggests `['market-weekly']`.
- A query containing meeting/call language plus quote-recall language such as `actually said`, `exactly said`, `verbatim`, `exact words`, or `transcript` suggests `['meeting', 'transcript']`.
- Generic time language such as `what happened last week?` has no preferred types.
- All other existing classifier fields and classifications remain unchanged.
- `hybridSearch` runs a typed keyword and title lookup when the preference exists. When a text query embedding already exists, it also runs a typed vector lookup with that same embedding. The typed results are fused as one bounded recall arm with neutral existing RRF weighting.
- No typed arm runs when the preference is absent or effective modality is image-only.
- Keyword-only and embed-failure paths still benefit from the typed lexical candidates.
- The normal arms remain present, so a curated meeting note can stay rank 1 while a raw transcript becomes retrievable.
- Bump `KNOBS_HASH_VERSION` from 15 to 16 because candidate generation changes for matching queries, and update both existing version assertions/comments.

**Step 1: Write the failing classifier tests**

Add pure assertions for the two positive prompts and the generic negative prompt. Run:

```bash
source ~/.zshrc 2>/dev/null || true
mise exec -- bun test test/query-intent.test.ts
```

Expected before implementation: FAIL because `preferredTypes` is absent.

**Step 2: Write the failing federated PGLite regression**

Use the repository's canonical single-engine `beforeAll`/`afterAll`/`beforeEach` pattern and `resetPgliteState`. Stub `__setEmbedTransportForTests` and restore it after the file. Seed generic sources and fixtures:

- More than 100 bulk email-like distractor pages that consume the ordinary global candidate budget.
- One `market-weekly` page in a separate derived source.
- One curated `meeting` page and one raw `transcript` page in separate sources, plus sufficient bulk distractors.

Disable expansion, reranking, autocut, and unrelated post-fusion variation through existing per-call seams. Assert:

- `What happened in the market last week?` ranks the weekly page first.
- `What was actually said at the Acme kickoff meeting?` keeps the curated meeting page first and includes the raw transcript at rank 15 or better.
- Results remain within the caller's federated `sourceIds` grant; add an out-of-scope typed decoy if needed to prove this.

Run the new file alone and confirm the pre-implementation failure is the expected missing-target/rank failure, not fixture setup or infrastructure.

**Step 3: Implement the classifier hint**

Add narrow deterministic pattern banks and compute `preferredTypes` once inside `classifyQuery`. Return the optional field without changing the existing intent/detail/salience/recency/modality resolution.

Run the classifier tests and confirm they pass.

**Step 4: Implement one typed recall arm**

Build one typed `SearchOpts` value from the already-scoped ordinary `searchOpts`, overriding only `types` with `suggestions.preferredTypes` and retaining the same bounded `innerLimit`. Fetch typed keyword/title candidates alongside the ordinary lexical arms. Once the ordinary text embedding exists, fetch typed vector candidates using that same embedding. Fuse the typed candidates into one list before adding it to every applicable RRF path; do not add separate RRF votes for keyword/title/vector from the same preference.

Keep every failure fail-open with the repository's existing warn-once pattern where an engine arm can throw. Do not swallow unrelated errors silently.

Run the new PGLite regression and the existing search suites touched by the seam.

**Step 5: Invalidate stale cached rankings**

Bump `KNOBS_HASH_VERSION` to 16 and update the two pinned version assertions and version history comments in `test/search-mode.test.ts`. Run:

```bash
mise exec -- bun test test/search-mode.test.ts
```

**Step 6: Update current-state retrieval documentation**

Document the narrow preferred-type classifier and recall arm in `docs/architecture/RETRIEVAL.md`. Update the current-state `hybrid.ts` and `mode.ts` entries in `docs/architecture/KEY_FILES.md`. Do not edit the temporary handoff specification.

**Step 7: Verify the task**

Run, in order:

```bash
source ~/.zshrc 2>/dev/null || true
mise exec -- bun test test/query-intent.test.ts test/search-mode.test.ts
mise exec -- bun test test/search/preferred-type-recall.serial.test.ts
mise exec -- bun run verify
env -u DATABASE_URL mise exec -- bun run test
```

If a full-suite failure is unrelated and reproducible on the base commit, record it in `.context/test-failures.log`; do not weaken or skip the focused acceptance tests.

**Step 8: Self-review and commit**

Review the diff for source-scope preservation, one-embedding-call behavior, privacy-safe fixtures, cache invalidation, and absence of unrelated changes. Commit the complete task on `fix/retrieval-acceptance-closure` and report the commit, commands, outputs, and any residual risks.
