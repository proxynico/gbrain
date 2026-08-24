import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';
import { buildEvidence } from './evidence.ts';
import { fingerprintMarketRate } from './fingerprint.ts';
import { extractForwardedOriginal } from './forwarded-original.ts';
import { extractMarketRateRows } from './rate-rows.ts';
import type { InspectMarketRatesInput, MarketRateCandidate } from './types.ts';

/**
 * Reads one raw email and returns its headed-table rows as disposable
 * suggestions. It never creates a source or writes a page.
 */
export async function inspectMarketRates(
  engine: BrainEngine,
  input: InspectMarketRatesInput,
): Promise<MarketRateCandidate[]> {
  assertValidSourceId(input.sourceId);
  const rawPage = await engine.getPage(input.sourceSlug, { sourceId: input.sourceId });
  if (rawPage === null) {
    throw new Error(
      `market signal raw page not found in source '${input.sourceId}': ${input.sourceSlug}`,
    );
  }
  if (rawPage.frontmatter.from_address !== input.forwarder) {
    throw new Error(
      `market signal raw page sender does not match the exact forwarder for ${input.sourceSlug}`,
    );
  }

  const original = extractForwardedOriginal(rawPage.compiled_truth);
  if (original === undefined) {
    throw new Error(`market signal forwarded original could not be recovered for ${input.sourceSlug}`);
  }

  const effectiveDate = rawPage.effective_date === undefined
    ? (await engine.executeRaw<{ effective_date: Date | string | null }>(
      'SELECT effective_date FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1',
      [input.sourceId, input.sourceSlug],
    ))[0]?.effective_date ?? null
    : rawPage.effective_date;
  const observedAt = effectiveDate === null
    ? undefined
    : new Date(effectiveDate).toISOString();
  const candidates = new Map<string, MarketRateCandidate>();
  for (const row of extractMarketRateRows(original)) {
    const evidence = buildEvidence(original, row.evidenceExcerpt);
    const fingerprint = fingerprintMarketRate(row, evidence, rawPage.source_id, input.sourceSlug);
    const signalId = `market-rate-${fingerprint}` as const;
    if (candidates.has(signalId)) continue;
    candidates.set(signalId, {
      ...row,
      signalId,
      sourceSlug: input.sourceSlug,
      rawSourceId: rawPage.source_id,
      ...(observedAt === undefined ? {} : { observedAt }),
      evidence,
      fingerprint,
    });
  }
  return [...candidates.values()];
}
