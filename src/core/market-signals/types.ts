export const MARKET_SIGNAL_TYPES = [
  'spot_offer',
  'rate_circular',
  'market_update',
  'capacity_offer',
] as const;
export type MarketSignalType = typeof MARKET_SIGNAL_TYPES[number];

export const MARKET_SIGNAL_STATES = [
  'needs_review',
  'ready',
  'excluded',
  'needs_source_recovery',
  'superseded',
] as const;
export type MarketSignalState = typeof MARKET_SIGNAL_STATES[number];

export interface ForwardedOriginal {
  /** The first `From:` header after a forwarded-message boundary. */
  header: string;
  /** The newest original's text, excluding wrapper and quoted history. */
  body: string;
}

export interface MarketSignalEvidence {
  /** Exact excerpt retained for the derived record. */
  excerpt: string;
  /** SHA-256 of the complete extracted original body. */
  sha256: string;
}
