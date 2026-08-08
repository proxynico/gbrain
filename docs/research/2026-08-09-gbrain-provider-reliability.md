# Provider setup for a reliability-first gbrain installation

## Question

What provider assignment gives this installation the best reliability without adding another service or forcing a risky corpus migration?

## Decision this feeds

Whether the reliability-foundation sprint should keep the current OpenAI embedding model, consolidate language-model work on Anthropic, or migrate retrieval to ZeroEntropy.

## Findings

1. The live configuration uses `openai:text-embedding-3-large` at 1,536 dimensions for embeddings; `openai:gpt-4o-mini` for chat and query expansion; Anthropic Haiku 4.5 for the utility and subagent tiers; and Anthropic Sonnet 5 for the reasoning and deep tiers. Evidence: read-only `gbrain config get` calls on 2026-08-09.

2. The configured search mode is unset, so this gbrain version uses its `balanced` fallback. In that mode, LLM query expansion and the ZeroEntropy reranker are off by default. Evidence: `src/core/search/mode.ts` and read-only `gbrain config get search.mode` / `search.reranker.enabled` calls.

3. OpenAI describes `text-embedding-3-large` as its most capable embedding model and currently lists it at $0.13 per million input tokens. It supports shortened dimensions, which is how this installation uses 1,536 dimensions. Sources: [OpenAI model card](https://developers.openai.com/api/docs/models/text-embedding-3-large) and [OpenAI embedding announcement](https://openai.com/index/new-embedding-models-and-api-updates/).

4. OpenAI offers account-native prepaid auto-recharge and project budget alerts. Those controls address credit exhaustion without adding a local cron or health service. Sources: [OpenAI prepaid billing](https://help.openai.com/en/articles/8264644) and [OpenAI project budgets](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform).

5. ZeroEntropy lists `zembed-1` at $0.05 per million tokens and supports 2,560, 1,280, 640, 320, 160, 80, or 40 dimensions. Its 1,280-dimension shape fits gbrain's indexed Postgres path; the 2,560-dimension default exceeds pgvector's HNSW limit documented by gbrain. Sources: [ZeroEntropy model documentation](https://docs.zeroentropy.dev/models), `docs/ai-providers/zeroentropy.md`, and `docs/embedding-migrations.md`.

6. Moving from the current 1,536-dimension OpenAI vectors to ZeroEntropy requires clearing the existing vectors, changing the Postgres vector width, rebuilding the index, and re-embedding the whole corpus. Gbrain deliberately does not auto-fallback between embedding providers because mixing vector spaces corrupts retrieval semantics. Source: `docs/embedding-migrations.md`.

7. The repository contains no completed live-corpus A/B result proving that `zembed-1` preserves or improves this installation's retrieval acceptance set. The existing ZeroEntropy material documents capability and a proposed evaluation, not a production-quality receipt. Evidence: search across `docs/eval`, `docs/designs`, and tests on 2026-08-09.

## Implications

- Changing the embedding provider during the reliability sprint would add a destructive, hours-long migration and retrieval-quality uncertainty to a project whose purpose is to reduce operational uncertainty.
- Moving chat and expansion from OpenAI to Anthropic would not remove the OpenAI dependency: semantic queries still need a query embedding in the same vector space as the corpus.
- The smallest reliability improvement is operational: keep the known embedding space and make the existing OpenAI billing path resistant to credit exhaustion using provider-native controls.
- ZeroEntropy is a credible later candidate, but it should earn migration through a representative retrieval A/B test before any production vectors are cleared.

## Recommendation

Keep the current provider assignments for the three-day reliability proof. Verify OpenAI auto-recharge and budget alerts, measure actual provider failures, and make no model changes during the soak. Keep ZeroEntropy as an inactive candidate. Only design a migration if OpenAI still prevents the reliability target or a live-corpus A/B shows a material quality or reliability advantage.

## Open gaps and uncertainty

- The OpenAI billing portal state was not inspected, so auto-recharge and alert configuration remain unverified.
- No production-corpus OpenAI-versus-ZeroEntropy retrieval evaluation exists in the repository.
- Provider uptime or contractual SLA comparisons were not used; neither vendor's public model page alone proves this installation's observed reliability.
