import { describe, expect, test } from 'bun:test';
import { fingerprintMarketSignal } from '../src/core/market-signals/fingerprint.ts';
import { parseMarketSignal } from '../src/core/market-signals/parse.ts';
import { asDerivedMarketSignal } from '../src/core/market-signals/validation.ts';

describe('market-signal parsing', () => {
  test('keeps a priced spot offer with missing lane and equipment in review', () => {
    const parsed = parseMarketSignal({
      header: 'From: provider@example.test',
      body: 'Spot offer: USD 4,300. Valid until 31 Aug 2026.',
    });

    expect(parsed.decision).toBe('needs_review');
    expect(parsed.signalType).toBe('spot_offer');
    expect(parsed.amount).toBe(4300);
    expect(parsed.currency).toBe('USD');
    expect(parsed.lane).toBeUndefined();
    expect(parsed.equipment).toBeUndefined();
    expect(parsed.missing).toEqual(expect.arrayContaining(['lane', 'equipment']));
    expect(asDerivedMarketSignal(parsed)).toBeUndefined();
  });

  test.each([
    ['rate circular', 'Rate circular: USD 1,200 per 20GP from Port Alpha to Port Beta, valid until 31 Aug 2026.', 'rate_circular'],
    ['market update', 'Market update: USD 1,100 per 40HC from Port Alpha to Port Beta, valid until 31 Aug 2026.', 'market_update'],
    ['capacity offer', 'Capacity offer: 80 TEU available at USD 900 per 20GP from Port Alpha to Port Beta, valid until 31 Aug 2026.', 'capacity_offer'],
  ] as const)('parses an explicit %s without inventing fields', (_label, body, expectedType) => {
    const parsed = parseMarketSignal({ header: 'From: provider@example.test', body });

    expect(parsed).toMatchObject({
      decision: 'market_signal',
      signalType: expectedType,
      currency: 'USD',
      lane: { origin: 'Port Alpha', destination: 'Port Beta' },
      provider: 'provider@example.test',
    });
    expect(asDerivedMarketSignal(parsed)).toBe(parsed);
  });

  test('fingerprints a complete signal with its raw source slug and rejects an incomplete one', () => {
    const complete = parseMarketSignal({
      header: 'From: provider@example.test',
      body: 'Spot offer: USD 4,300 per 40HQ from Port Alpha to Port Beta, valid until 31 Aug 2026.',
    });
    const incomplete = parseMarketSignal({
      header: 'From: provider@example.test',
      body: 'Spot offer: USD 4,300.',
    });

    const first = fingerprintMarketSignal(complete, 'a'.repeat(64), 'emails/2026/first');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintMarketSignal(complete, 'a'.repeat(64), 'emails/2026/first')).toBe(first);
    expect(fingerprintMarketSignal(complete, 'a'.repeat(64), 'emails/2026/second')).not.toBe(first);
    expect(() => fingerprintMarketSignal(incomplete, 'a'.repeat(64), 'emails/2026/first')).toThrow(
      'only market_signal decisions can be fingerprinted',
    );
  });
});
