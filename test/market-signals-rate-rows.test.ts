import { describe, expect, test } from 'bun:test';
import { extractMarketRateRows } from '../src/core/market-signals/rate-rows.ts';

const original = (body: string) => ({ header: 'From: provider@example.test', body });

describe('market-rate table suggestions', () => {
  test('splits flattened rows and multiple equipment prices', () => {
    const rows = extractMarketRateRows(original([
      'POL', 'POD', 'ETD', 'RATE', 'SSL',
      'Port Alpha', 'Port Beta', '04-10-AUG', 'USD 1200/20GP USD 2100/40HQ', 'Carrier One',
      'Port Gamma', 'Port Delta', '11-17-AUG', 'EUR 900/20GP', 'Carrier Two',
    ].join('\n')));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount: 1200, currency: 'USD', equipment: '20GP', origin: 'Port Alpha', destination: 'Port Beta', validity: '04-10-AUG', carrier: 'Carrier One' }),
      expect.objectContaining({ amount: 2100, currency: 'USD', equipment: '40HQ', origin: 'Port Alpha', destination: 'Port Beta', validity: '04-10-AUG', carrier: 'Carrier One' }),
      expect.objectContaining({ amount: 900, currency: 'EUR', equipment: '20GP', origin: 'Port Gamma', destination: 'Port Delta', validity: '11-17-AUG', carrier: 'Carrier Two' }),
    ]));
    expect(rows).toHaveLength(3);
  });

  test('allows a blank validity as an incomplete suggestion field', () => {
    const rows = extractMarketRateRows(original([
      'POL', 'POD', 'ETD', 'RATE', 'SSL',
      'Port Alpha', 'Port Beta', '', 'USD 1200/20GP', 'Carrier One',
    ].join('\n')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 1200, equipment: '20GP' });
    expect(rows[0]?.validity).toBeUndefined();
  });

  test('rejects prose and unheaded market-average values', () => {
    expect(extractMarketRateRows(original('Market average: USD 9999 per container.'))).toEqual([]);
  });

  test('extracts shared-currency amounts aligned to equipment under ETD(validity)', () => {
    const rows = extractMarketRateRows(original([
      'POL', 'POD', 'ETD(validity)', 'RATE', 'SSL',
      'Port Alpha', 'Port Beta', '3Aug-9Aug', 'USD1200/2100 PER 20GP/40HQ', 'Carrier One',
    ].join('\n')));

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount: 1200, currency: 'USD', equipment: '20GP', validity: '3Aug-9Aug', carrier: 'Carrier One' }),
      expect.objectContaining({ amount: 2100, currency: 'USD', equipment: '40HQ', validity: '3Aug-9Aug', carrier: 'Carrier One' }),
    ]));
  });

  test('accepts a direct pair with a trailing service qualifier', () => {
    const rows = extractMarketRateRows(original([
      'POL', 'POD', 'ETD', 'RATE', 'SSL',
      'Port Alpha', 'Port Beta', '6-Aug', 'EUR900/20GP (Direct service)', 'Carrier One',
    ].join('\n')));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 900, currency: 'EUR', equipment: '20GP', validity: '6-Aug', carrier: 'Carrier One' });
  });

  test('returns a syntactically table-shaped later group as a suggestion, not a storage decision', () => {
    const rows = extractMarketRateRows(original([
      'POL', 'POD', 'ETD', 'RATE', 'SSL',
      'Port Alpha', 'Port Beta', '3Aug-9Aug', 'USD1200/20GP', 'Carrier One',
      'Narrative', 'could resemble a route', '6-Aug', 'USD9999/20GP', 'Not a carrier',
    ].join('\n')));

    expect(rows).toHaveLength(2);
  });

  test('reads separately headed tables without duplicating their rows', () => {
    const rows = extractMarketRateRows(original([
      'POL', 'POD', 'ETD', 'RATE', 'SSL',
      'Port Alpha', 'Port Beta', '04-10-AUG', 'USD 1200/20GP', 'Carrier One',
      'POL', 'POD', 'ETD', 'RATE', 'SSL',
      'Port Gamma', 'Port Delta', '11-17-AUG', 'EUR 900/40HQ', 'Carrier Two',
    ].join('\n')));

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount: 1200, currency: 'USD', equipment: '20GP' }),
      expect.objectContaining({ amount: 900, currency: 'EUR', equipment: '40HQ' }),
    ]));
  });
});
