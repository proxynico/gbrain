import { createHash } from 'node:crypto';
import type { ParsedMarketSignal } from './validation.ts';

function normalize(value: string | undefined): string | null {
  return value === undefined ? null : value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/** Stable identity for a complete derived signal, independent of field ordering. */
export function fingerprintMarketSignal(
  signal: ParsedMarketSignal,
  originalSha256: string,
  sourceSlug: string,
): string {
  if (signal.decision !== 'market_signal') {
    throw new Error('only market_signal decisions can be fingerprinted');
  }
  if (sourceSlug.trim() === '') {
    throw new Error('market signal source slug must be non-empty');
  }
  const canonical = {
    sourceSlug,
    originalSha256: originalSha256.toLowerCase(),
    signalType: signal.signalType ?? null,
    amount: signal.amount ?? null,
    currency: normalize(signal.currency)?.toUpperCase() ?? null,
    amountUnit: normalize(signal.amountUnit)?.toUpperCase() ?? null,
    origin: normalize(signal.lane?.origin)?.toUpperCase() ?? null,
    destination: normalize(signal.lane?.destination)?.toUpperCase() ?? null,
    equipment: normalize(signal.equipment)?.toUpperCase() ?? null,
    validity: normalize(signal.validity),
    provider: normalize(signal.provider),
    capacity: normalize(signal.capacity),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
