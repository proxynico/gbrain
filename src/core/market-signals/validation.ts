import type { MarketSignalType } from './types.ts';

export const MARKET_SIGNAL_DECISIONS = [
  'market_signal',
  'no_rate',
  'needs_review',
  'needs_source_recovery',
] as const;
export type MarketSignalDecision = typeof MARKET_SIGNAL_DECISIONS[number];

export const MARKET_SIGNAL_REVIEW_FIELDS = [
  'signal_type',
  'amount_unit',
  'lane',
  'equipment',
  'validity',
  'provider',
  'capacity',
] as const;
export type MarketSignalReviewField = typeof MARKET_SIGNAL_REVIEW_FIELDS[number];

export interface ParsedMarketSignal {
  decision: MarketSignalDecision;
  signalType?: MarketSignalType;
  amount?: number;
  currency?: string;
  amountUnit?: string;
  lane?: { origin: string; destination: string };
  equipment?: string;
  validity?: string;
  provider?: string;
  capacity?: string;
  missing: MarketSignalReviewField[];
}

function requiredFields(signal: Omit<ParsedMarketSignal, 'decision' | 'missing'>): MarketSignalReviewField[] {
  const missing: MarketSignalReviewField[] = [];
  if (signal.signalType === undefined) missing.push('signal_type');
  if (signal.amountUnit === undefined) missing.push('amount_unit');
  if (signal.lane === undefined) missing.push('lane');
  if (signal.equipment === undefined) missing.push('equipment');
  if (signal.validity === undefined) missing.push('validity');
  if (signal.provider === undefined) missing.push('provider');
  if (signal.signalType === 'capacity_offer' && signal.capacity === undefined) {
    missing.push('capacity');
  }
  return missing;
}

/**
 * A concrete rate can be an attended candidate before it is a complete
 * derived signal. Missing facts remain visible for review instead of being
 * guessed; only a complete parse receives `market_signal`.
 */
export function validateParsedMarketSignal(
  signal: Omit<ParsedMarketSignal, 'decision' | 'missing'>,
): ParsedMarketSignal {
  if (signal.amount === undefined || signal.currency === undefined) {
    return { decision: 'no_rate', missing: [] };
  }
  const missing = requiredFields(signal);
  return {
    ...signal,
    decision: missing.length === 0 ? 'market_signal' : 'needs_review',
    missing,
  };
}

/** A derived record is allowed only after the deterministic decision is complete. */
export function asDerivedMarketSignal(signal: ParsedMarketSignal): ParsedMarketSignal | undefined {
  return signal.decision === 'market_signal' ? signal : undefined;
}
