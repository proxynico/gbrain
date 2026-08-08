import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessMarketSignalPage,
  collectMarketSignalCandidates,
} from '../src/core/market-signals/agent-pass.ts';
import {
  MAX_MARKET_SIGNAL_SCAN_PAGES,
  enumerateMarketSignalPages,
} from '../src/core/market-signals/enumerate.ts';
import type { MarketSignalDecision } from '../src/core/market-signals/validation.ts';

const FORWARDER = 'forwarder@example.test';

function forwardedMessage(originalBody: string): string {
  return `FYI\n\n---------- Forwarded message ---------\nFrom: provider@example.test\nDate: Tue, 4 Aug 2026 10:00:00 +0000\nSubject: Market rate\nTo: ${FORWARDER}\n\n${originalBody}`;
}

function completeRate(): string {
  return 'Spot offer: USD 4,300 per 40HQ from Port Alpha to Port Beta, valid until 31 Aug 2026.';
}

function page(body: string, overrides: Record<string, unknown> = {}) {
  return {
    slug: 'emails/2026/spot-offer',
    title: 'FW: spot offer',
    compiled_truth: body,
    frontmatter: {
      from_address: FORWARDER,
    },
    effective_date: new Date('2026-08-04T10:00:00.000Z'),
    ...overrides,
  };
}

function engineReturning(rows: ReturnType<typeof page>[]) {
  return {
    withReservedConnection: async <T>(
      fn: (conn: {
        executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      }) => Promise<T>,
    ): Promise<T> => fn({ executeRaw: async () => rows }),
  };
}

describe('market-signal discovery', () => {
  test('qualifies an exact-forwarder forwarded spot offer with an explicit rate', async () => {
    const candidates = await collectMarketSignalCandidates(
      engineReturning([
        page(forwardedMessage(
          'Spot offer: USD 4,300 per 40HQ from Port Alpha to Port Beta, valid until 31 Aug 2026.',
        )),
      ]) as never,
      {
        sourceId: 'default',
        forwarder: FORWARDER,
        since: '2026-08-01',
        until: '2026-08-05',
      },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.original.body).toContain('USD 4,300 per 40HQ');
  });

  test('marks a matching raw page without a forwarded original for source recovery', () => {
    const assessed = assessMarketSignalPage(
      page('USD 4,300 per 40HQ from Port Alpha to Port Beta.'),
      FORWARDER,
      20_000,
    );

    expect(assessed.decision).toBe('needs_source_recovery');
    expect(assessed.candidate).toBeUndefined();
  });

  test('keeps every supported rate-bearing market-signal class as a candidate', async () => {
    const candidates = await collectMarketSignalCandidates(
      engineReturning([
        page(forwardedMessage(
          'Spot offer: USD 4,300 per 40HQ from Port Alpha to Port Beta, valid until 31 Aug 2026.',
        ), { slug: 'emails/2026/spot' }),
        page(forwardedMessage(
          'Rate circular: USD 1,200 per 20GP from Port Alpha to Port Beta, valid until 31 Aug 2026.',
        ), { slug: 'emails/2026/circular' }),
        page(forwardedMessage(
          'Market update: USD 1,100 per 40HC from Port Alpha to Port Beta, valid until 31 Aug 2026.',
        ), { slug: 'emails/2026/update' }),
        page(forwardedMessage(
          'Capacity offer: 80 TEU available at USD 900 per 20GP from Port Alpha to Port Beta, valid until 31 Aug 2026.',
        ), { slug: 'emails/2026/capacity' }),
      ]) as never,
      { sourceId: 'default', forwarder: FORWARDER, since: '2026-08-01', until: '2026-08-05' },
    );

    expect(candidates.map(candidate => candidate.assessment.signalType)).toEqual([
      'spot_offer',
      'rate_circular',
      'market_update',
      'capacity_offer',
    ]);
    expect(candidates.every(candidate => candidate.assessment.decision === 'market_signal')).toBe(true);
  });

  test('rejects requests, status, promotions, and market commentary without a rate', async () => {
    const candidates = await collectMarketSignalCandidates(
      engineReturning([
        page(forwardedMessage('Could you quote your current 40HQ rate from Port Alpha to Port Beta?')),
        page(forwardedMessage('Booking status update: the vessel has departed.')),
        page(forwardedMessage('Unsubscribe from this generic promotion.')),
        page(forwardedMessage('SCFI news commentary: the index moved 100 points today.')),
      ]) as never,
      { sourceId: 'default', forwarder: FORWARDER, since: '2026-08-01', until: '2026-08-05' },
    );

    expect(candidates).toEqual([]);
    expect(assessMarketSignalPage(
      page(forwardedMessage('Booking status update: the vessel has departed.')),
      FORWARDER,
      20_000,
    ).decision).toBe('no_rate');
  });

  test('retains a rate-bearing original despite request and promotional footer wording', async () => {
    const candidates = await collectMarketSignalCandidates(
      engineReturning([
        page(forwardedMessage(
          'Rate circular: USD 1,200 per 20GP from Port Alpha to Port Beta, valid until 31 Aug 2026. Please provide feedback. Unsubscribe.',
        )),
      ]) as never,
      { sourceId: 'default', forwarder: FORWARDER, since: '2026-08-01', until: '2026-08-05' },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.assessment.decision).toBe('market_signal');
  });

  test('does not let quoted historical price text qualify a newer wrapper', async () => {
    const candidates = await collectMarketSignalCandidates(
      engineReturning([
        page(`${forwardedMessage('Please keep watching.')}

> From: older@example.test
> Subject: historical rate
>
> USD 9,999 per 40HQ from Port Alpha to Port Beta`),
      ]) as never,
      { sourceId: 'default', forwarder: FORWARDER, since: '2026-08-01', until: '2026-08-05' },
    );

    expect(candidates).toEqual([]);
  });

  test('does not let a header-less quoted rate tail qualify the current forwarded original', async () => {
    const candidates = await collectMarketSignalCandidates(
      engineReturning([
        page(`${forwardedMessage('Please review this market note.')}

> Spot offer: USD 9,999 per 40HQ from Port Alpha to Port Beta`),
      ]) as never,
      { sourceId: 'default', forwarder: FORWARDER, since: '2026-08-01', until: '2026-08-05' },
    );

    expect(candidates).toEqual([]);
  });

  test('requires the raw page sender to exactly match the supplied forwarder', async () => {
    const candidates = await collectMarketSignalCandidates(
      engineReturning([
        page(forwardedMessage(
          'Spot offer: USD 4,300 per 40HQ from Port Alpha to Port Beta, valid until 31 Aug 2026.',
        ), { frontmatter: { from_address: 'other@example.test' } }),
      ]) as never,
      { sourceId: 'default', forwarder: FORWARDER, since: '2026-08-01', until: '2026-08-05' },
    );

    expect(candidates).toEqual([]);
  });

  test('does not normalize a near-match into the supplied forwarder', async () => {
    const candidates = await collectMarketSignalCandidates(
      engineReturning([
        page(forwardedMessage(
          'Spot offer: USD 4,300 per 40HQ from Port Alpha to Port Beta, valid until 31 Aug 2026.',
        ), { frontmatter: { from_address: 'FORWARDER@example.test' } }),
      ]) as never,
      { sourceId: 'default', forwarder: FORWARDER, since: '2026-08-01', until: '2026-08-05' },
    );

    expect(candidates).toEqual([]);
  });

  test('filters the exact forwarder in SQL before the newest-first 25-page cap', async () => {
    const newerNonForwarders = Array.from(
      { length: MAX_MARKET_SIGNAL_SCAN_PAGES },
      (_, index) => page(forwardedMessage(completeRate()), {
        slug: `emails/2026/newer-non-forwarder-${index}`,
        frontmatter: { from_address: 'other@example.test' },
        effective_date: new Date(Date.parse('2026-08-04T23:00:00.000Z') - index * 3_600_000),
      }),
    );
    const olderMatching = page(forwardedMessage(completeRate()), {
      slug: 'emails/2026/older-exact-forwarder',
      effective_date: new Date('2026-08-03T00:00:00.000Z'),
    });
    let query = '';
    let parameters: unknown[] | undefined;
    const engine = {
      withReservedConnection: async <T>(
        fn: (conn: {
          executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>;
        }) => Promise<T>,
      ): Promise<T> => fn({
        executeRaw: async (sql, params) => {
          query = sql;
          parameters = params;
          const predicateIndex = sql.indexOf("frontmatter->>'from_address' = $4");
          const orderIndex = sql.indexOf('ORDER BY effective_date DESC, slug');
          const limitIndex = sql.indexOf('LIMIT $6');
          return predicateIndex >= 0 && predicateIndex < orderIndex && orderIndex < limitIndex
            ? [olderMatching]
            : newerNonForwarders;
        },
      }),
    };

    const candidates = await collectMarketSignalCandidates(engine as never, {
      sourceId: 'default',
      forwarder: FORWARDER,
      since: '2026-08-01',
      until: '2026-08-05',
    });

    expect(candidates.map(candidate => candidate.slug)).toEqual([
      'emails/2026/older-exact-forwarder',
    ]);
    expect(query.indexOf("frontmatter->>'from_address' = $4"))
      .toBeLessThan(query.indexOf('ORDER BY effective_date DESC, slug'));
    expect(parameters?.[3]).toBe(FORWARDER);
  });

  test('keeps generic fixture coverage for every supported, rejected, and review case', () => {
    const fixture = readFileSync(
      join(new URL('.', import.meta.url).pathname, 'fixtures/market-signals/messages.jsonl'),
      'utf8',
    ).trim().split('\n').map(line => JSON.parse(line) as {
      case: string;
      from_address: string;
      compiled_truth: string;
    });
    const expected = new Map<string, MarketSignalDecision>([
      ['spot_offer', 'market_signal'],
      ['rate_circular', 'market_signal'],
      ['market_update', 'market_signal'],
      ['capacity_offer', 'market_signal'],
      ['request', 'no_rate'],
      ['status', 'no_rate'],
      ['promotion', 'no_rate'],
      ['market_commentary', 'no_rate'],
      ['offer_with_request_and_footer', 'market_signal'],
      ['partial_signal', 'needs_review'],
      ['quoted_history', 'no_rate'],
      ['quoted_tail', 'no_rate'],
    ]);

    expect(fixture.map(entry => entry.case)).toEqual([...expected.keys()]);
    for (const entry of fixture) {
      const decision = expected.get(entry.case);
      if (decision === undefined) throw new Error(`missing expected fixture decision: ${entry.case}`);
      expect(assessMarketSignalPage(page(entry.compiled_truth, {
        frontmatter: { from_address: entry.from_address },
      }), FORWARDER, 20_000).decision).toBe(decision);
    }
  });

  test('validates the date window and makes a bounded newest-first source query', async () => {
    let query = '';
    let parameters: unknown[] | undefined;
    const rows = Array.from({ length: MAX_MARKET_SIGNAL_SCAN_PAGES + 1 }, (_, index) => page(
      forwardedMessage('Spot offer: USD 4,300 per 40HQ from Port Alpha to Port Beta, valid until 31 Aug 2026.'),
      { slug: `emails/2026/${index}` },
    ));
    const engine = {
      withReservedConnection: async <T>(
        fn: (conn: {
          executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>;
        }) => Promise<T>,
      ): Promise<T> => fn({
        executeRaw: async (sql, params) => {
          query = sql;
          parameters = params;
          return rows;
        },
      }),
    };

    const scanned = await enumerateMarketSignalPages(engine as never, {
      sourceId: 'default',
      forwarder: FORWARDER,
      since: '2026-08-01',
      until: '2026-08-05',
    });

    expect(scanned).toHaveLength(MAX_MARKET_SIGNAL_SCAN_PAGES);
    expect(query).toContain('LEFT(compiled_truth, $5) AS compiled_truth');
    expect(query).toContain("frontmatter->>'from_address' = $4");
    expect(query).toContain('ORDER BY effective_date DESC, slug');
    expect(parameters?.at(-1)).toBe(MAX_MARKET_SIGNAL_SCAN_PAGES);
    await expect(collectMarketSignalCandidates(engine as never, {
      sourceId: 'default',
      forwarder: FORWARDER,
      since: '2026-08-32',
      until: '2026-08-05',
    })).rejects.toThrow('--since must be an ISO calendar date');
    await expect(collectMarketSignalCandidates(engine as never, {
      sourceId: 'default',
      forwarder: FORWARDER,
      since: '2026-06-01',
      until: '2026-08-05',
    })).resolves.toHaveLength(MAX_MARKET_SIGNAL_SCAN_PAGES);
  });
});
