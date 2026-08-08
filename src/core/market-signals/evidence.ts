import { createHash } from 'node:crypto';
import type { ForwardedOriginal, MarketSignalEvidence } from './types.ts';

export const MAX_MARKET_SIGNAL_EVIDENCE_EXCERPT_CHARS = 1_000;

/**
 * Builds evidence only from the isolated forwarded original. The excerpt is
 * retained byte-for-byte and must be a bounded substring of that body.
 */
export function buildEvidence(
  original: ForwardedOriginal,
  excerpt: string,
): MarketSignalEvidence {
  if (excerpt.length === 0) {
    throw new Error('market signal evidence excerpt must not be empty');
  }
  if (excerpt.length > MAX_MARKET_SIGNAL_EVIDENCE_EXCERPT_CHARS) {
    throw new Error('market signal evidence excerpt exceeds the maximum length');
  }
  if (!original.body.includes(excerpt)) {
    throw new Error('market signal evidence excerpt is not present in the forwarded original');
  }

  return {
    excerpt,
    sha256: createHash('sha256').update(original.body).digest('hex'),
  };
}
