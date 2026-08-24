import { createHash } from 'node:crypto';
import type { ExtractedMarketRateRow, MarketSignalEvidence } from './types.ts';

/** Produces the stable content identity used for a selectable rate row. */
export function fingerprintMarketRate(
  row: ExtractedMarketRateRow,
  evidence: MarketSignalEvidence,
  rawSourceId: string,
  sourceSlug: string,
): string {
  const canonical = {
    rawSourceId,
    sourceSlug,
    originalSha256: evidence.sha256,
    excerpt: evidence.excerpt,
    amount: row.amount,
    currency: row.currency.toUpperCase(),
    equipment: row.equipment.toUpperCase(),
    origin: row.origin.normalize('NFKC').trim(),
    destination: row.destination.normalize('NFKC').trim(),
    validity: row.validity?.normalize('NFKC').trim() ?? null,
    carrier: row.carrier.normalize('NFKC').trim(),
    provider: row.provider.normalize('NFKC').trim(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
