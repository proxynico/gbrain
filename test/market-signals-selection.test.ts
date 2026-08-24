import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { inspectMarketRates } from '../src/core/market-signals/selection.ts';

const FORWARDER = 'forwarder@example.test';
const SLUG = 'emails/2026/market-rate';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function forwardedTable(): string {
  return [
    'FYI', '', '---------- Forwarded message ---------',
    'From: provider@example.test', 'To: forwarder@example.test', '',
    'POL', 'POD', 'ETD(validity)', 'RATE', 'SSL',
    'Port Alpha', 'Port Beta', '3Aug-9Aug', 'USD1200/2100 PER 20GP/40HQ', 'Carrier One',
  ].join('\n');
}

async function seededEngine(
  slug: string,
  compiledTruth: string,
  sender: string,
  effectiveDate: string | null,
  sourceId = 'default',
): Promise<void> {
  await engine.putPage(slug, {
    type: 'email',
    title: 'FW: market rate',
    compiled_truth: compiledTruth,
    frontmatter: { from_address: sender },
    source_path: '/fixture/market-rate.eml',
    ...(effectiveDate === null ? {} : { effective_date: new Date(effectiveDate) }),
  }, { sourceId });
}

describe('market-rate inspection', () => {
  test('returns stable, row-level suggestions without writing a source', async () => {
    await seededEngine(SLUG, forwardedTable(), FORWARDER, '2026-08-04T10:00:00.000Z');
    const rows = await inspectMarketRates(engine, { sourceId: 'default', sourceSlug: SLUG, forwarder: FORWARDER });
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'Port Alpha', destination: 'Port Beta', amount: 1200, currency: 'USD', equipment: '20GP', carrier: 'Carrier One', observedAt: '2026-08-04T10:00:00.000Z' }),
      expect.objectContaining({ origin: 'Port Alpha', destination: 'Port Beta', amount: 2100, currency: 'USD', equipment: '40HQ', carrier: 'Carrier One' }),
    ]));
    expect(new Set(rows.map(row => row.signalId)).size).toBe(2);
    expect(await engine.listPages({ sourceId: 'default' })).toHaveLength(1);
  });

  test('rejects a wrong forwarder and does not allow the wrapper or quoted history to create a row', async () => {
    await seededEngine(SLUG, forwardedTable(), FORWARDER, null);
    await expect(inspectMarketRates(engine, { sourceId: 'default', sourceSlug: SLUG, forwarder: 'other@example.test' }))
      .rejects.toThrow('exact forwarder');
  });

  test('rejects an invalid source ID before it can fall through to a same-slug page', async () => {
    await seededEngine(SLUG, forwardedTable(), FORWARDER, null);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ($1, $1, NULL, '{}'::jsonb, NOW())`,
      ['other'],
    );
    await engine.putPage(SLUG, {
      type: 'email',
      title: 'FW: other market rate',
      compiled_truth: forwardedTable(),
      frontmatter: { from_address: FORWARDER },
      source_path: '/fixture/other-market-rate.eml',
    }, { sourceId: 'other' });

    await expect(inspectMarketRates(engine, { sourceId: '', sourceSlug: SLUG, forwarder: FORWARDER }))
      .rejects.toThrow('Invalid source_id');
  });

  test('includes the raw source in the identity of otherwise identical rows', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ($1, $1, NULL, '{}'::jsonb, NOW())`,
      ['other'],
    );
    await seededEngine(SLUG, forwardedTable(), FORWARDER, null, 'default');
    await seededEngine(SLUG, forwardedTable(), FORWARDER, null, 'other');

    const [defaultRate] = await inspectMarketRates(engine, {
      sourceId: 'default', sourceSlug: SLUG, forwarder: FORWARDER,
    });
    const [otherRate] = await inspectMarketRates(engine, {
      sourceId: 'other', sourceSlug: SLUG, forwarder: FORWARDER,
    });

    expect(defaultRate!.rawSourceId).toBe('default');
    expect(otherRate!.rawSourceId).toBe('other');
    expect(otherRate!.fingerprint).not.toBe(defaultRate!.fingerprint);
    expect(otherRate!.signalId).not.toBe(defaultRate!.signalId);
  });
});
