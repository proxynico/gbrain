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

export type MarketRateId = `market-rate-${string}`;

const MARKET_RATE_ID_PATTERN = /^market-rate-[a-f0-9]{64}$/;

/** Narrows a value to the deterministic market-rate identifier contract. */
export function isMarketRateId(value: unknown): value is MarketRateId {
  return typeof value === 'string' && MARKET_RATE_ID_PATTERN.test(value);
}

/** A single equipment-price pair suggested from a headed rate table. */
export interface ExtractedMarketRateRow {
  amount: number;
  currency: string;
  equipment: string;
  origin: string;
  destination: string;
  validity?: string;
  carrier: string;
  provider: string;
  evidenceExcerpt: string;
}

export interface MarketRateCandidate extends ExtractedMarketRateRow {
  signalId: MarketRateId;
  sourceSlug: string;
  rawSourceId: string;
  observedAt?: string;
  evidence: MarketSignalEvidence;
  fingerprint: string;
}

export interface InspectMarketRatesInput {
  sourceId: string;
  sourceSlug: string;
  forwarder: string;
}
