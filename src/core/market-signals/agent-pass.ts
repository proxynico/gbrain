import type { BrainEngine } from '../engine.ts';
import { hasMonetaryRate, matchesForwarder } from './discovery.ts';
import {
  enumerateMarketSignalPages,
  MAX_MARKET_SIGNAL_BODY_CHARS,
  MAX_MARKET_SIGNAL_SCAN_PAGES,
  validateMarketSignalDateWindow,
} from './enumerate.ts';
import { extractForwardedOriginal } from './forwarded-original.ts';
import { parseMarketSignal } from './parse.ts';
import type { ForwardedOriginal } from './types.ts';
import type { MarketSignalDecision, ParsedMarketSignal } from './validation.ts';
import type { MarketSignalSourcePage } from './enumerate.ts';

export { MAX_MARKET_SIGNAL_BODY_CHARS, MAX_MARKET_SIGNAL_SCAN_PAGES, validateMarketSignalDateWindow };

export interface MarketSignalCandidate {
  slug: string;
  sender: string;
  effectiveDate: Date | string | null;
  original: ForwardedOriginal;
  assessment: ParsedMarketSignal;
}

function pageSender(frontmatter: Record<string, unknown>): string | undefined {
  const sender = frontmatter.from_address;
  return typeof sender === 'string' ? sender : undefined;
}

export interface MarketSignalPageAssessment {
  decision: MarketSignalDecision;
  candidate?: MarketSignalCandidate;
}

/**
 * Keeps the decision trail for matching raw pages. A broken forwarded-message
 * boundary is a source-recovery concern; a complete parsed signal is the only
 * result that can later be derived.
 */
export function assessMarketSignalPage(
  page: MarketSignalSourcePage,
  forwarder: string,
  maxBodyChars: number,
): MarketSignalPageAssessment {
  const sender = pageSender(page.frontmatter);
  if (!matchesForwarder(sender, forwarder)) return { decision: 'no_rate' };

  const original = extractForwardedOriginal(page.compiled_truth.slice(0, maxBodyChars));
  if (original === undefined) return { decision: 'needs_source_recovery' };
  if (!hasMonetaryRate(original.body)) return { decision: 'no_rate' };

  const assessment = parseMarketSignal(original);
  if (assessment.decision === 'no_rate') return assessment;
  return {
    decision: assessment.decision,
    candidate: {
      slug: page.slug,
      sender: sender!,
      effectiveDate: page.effective_date,
      original,
      assessment,
    },
  };
}

/**
 * Discovers only manual-review candidates. Wrapper text and quoted history
 * are excluded before rate detection, and no source is written.
 */
export async function collectMarketSignalCandidates(
  engine: BrainEngine,
  options: {
    sourceId: string;
    forwarder: string;
    since: string;
    until: string;
    limit?: number;
    maxBodyChars?: number;
  },
): Promise<MarketSignalCandidate[]> {
  validateMarketSignalDateWindow(options.since, options.until);
  if (options.forwarder.trim() === '') {
    throw new Error('--forwarder is required for market-signals candidates');
  }
  const maxBodyChars = options.maxBodyChars ?? MAX_MARKET_SIGNAL_BODY_CHARS;
  const pages = await enumerateMarketSignalPages(engine, options);
  const candidates: MarketSignalCandidate[] = [];

  for (const page of pages) {
    const assessed = assessMarketSignalPage(page, options.forwarder, maxBodyChars);
    if (assessed.candidate !== undefined) candidates.push(assessed.candidate);
  }

  return candidates;
}
