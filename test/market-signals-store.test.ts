import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveMarketSignalsConfig } from '../src/core/config.ts';
import { inspectMarketRates } from '../src/core/market-signals/selection.ts';
import { BrainMarketSignalStore } from '../src/core/market-signals/store.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const FORWARDER = 'forwarder@example.test';
const RAW_SLUG = 'emails/2026/market-rate';

let engine: PGLiteEngine;
let store: BrainMarketSignalStore;

async function addDerivedSource(): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, NULL, $2::text::jsonb)`,
    ['lp-rate-intel', JSON.stringify({ federated: false })],
  );
}

async function putRawRatePage(rate = 'USD1200/2100 PER 20GP/40HQ'): Promise<void> {
  await engine.putPage(RAW_SLUG, {
    type: 'email',
    title: 'FW: market rate',
    compiled_truth: [
      'FYI', '', '---------- Forwarded message ---------',
      'From: provider@example.test', `To: ${FORWARDER}`, '',
      'POL', 'POD', 'ETD(validity)', 'RATE', 'SSL',
      'Port Alpha', 'Port Beta', '3Aug-9Aug', rate, 'Carrier One',
    ].join('\n'),
    frontmatter: { from_address: FORWARDER },
  }, { sourceId: 'default' });
}

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
  await addDerivedSource();
  store = new BrainMarketSignalStore(engine, {
    rawSourceId: 'default',
    derivedSourceId: 'lp-rate-intel',
  });
});

describe('selected market-rate storage', () => {
  test('writes only a selected rebuilt rate and reads it with exact filters', async () => {
    await putRawRatePage();
    const candidates = await inspectMarketRates(engine, {
      sourceId: 'default', sourceSlug: RAW_SLUG, forwarder: FORWARDER,
    });

    const kept = await store.keepMarketRates({
      sourceSlug: RAW_SLUG,
      forwarder: FORWARDER,
      signalIds: [candidates[1]!.signalId],
    });

    expect(kept).toEqual([expect.objectContaining({
      signalId: candidates[1]!.signalId, equipment: '40HQ', state: 'ready',
    })]);
    expect((await store.readMarketRates({
      sourceId: 'lp-rate-intel', origin: 'Port Alpha', destination: 'Port Beta', equipment: '40HQ',
      currency: 'USD', carrier: 'Carrier One', provider: 'provider@example.test',
    })).rates).toEqual([expect.objectContaining({ signalId: candidates[1]!.signalId })]);
    expect((await store.readMarketRates({ sourceId: 'lp-rate-intel', origin: 'port alpha' })).rates)
      .toEqual([]);
  });

  test('rejects forged or duplicate selected IDs before writing', async () => {
    await putRawRatePage();
    const [candidate] = await inspectMarketRates(engine, {
      sourceId: 'default', sourceSlug: RAW_SLUG, forwarder: FORWARDER,
    });

    await expect(store.keepMarketRates({
      sourceSlug: RAW_SLUG, forwarder: FORWARDER, signalIds: [`market-rate-${'a'.repeat(64)}`],
    })).rejects.toThrow('not available');
    await expect(store.keepMarketRates({
      sourceSlug: RAW_SLUG, forwarder: FORWARDER, signalIds: [candidate!.signalId, candidate!.signalId],
    })).rejects.toThrow('duplicate');
    expect(await engine.listPages({ sourceId: 'lp-rate-intel', type: 'market-rate' })).toEqual([]);
  });

  test('rejects a selected ID that becomes stale when the raw table changes', async () => {
    await putRawRatePage();
    const [stale] = await inspectMarketRates(engine, {
      sourceId: 'default', sourceSlug: RAW_SLUG, forwarder: FORWARDER,
    });
    await putRawRatePage('USD1300/2300 PER 20GP/40HQ');

    await expect(store.keepMarketRates({
      sourceSlug: RAW_SLUG, forwarder: FORWARDER, signalIds: [stale!.signalId],
    })).rejects.toThrow('not available');
    expect(await engine.listPages({ sourceId: 'lp-rate-intel', type: 'market-rate' })).toEqual([]);
  });

  test('does not read a legacy market-signal page from the same derived source', async () => {
    await engine.putPage('market-signal/legacy', {
      type: 'market-signal',
      title: 'legacy',
      compiled_truth: '',
      frontmatter: {},
    }, { sourceId: 'lp-rate-intel' });

    expect((await store.readMarketRates({ sourceId: 'lp-rate-intel' })).rates).toEqual([]);
  });

  test('rewrites the same selected ID idempotently with stable rate content', async () => {
    await putRawRatePage();
    const candidates = await inspectMarketRates(engine, {
      sourceId: 'default', sourceSlug: RAW_SLUG, forwarder: FORWARDER,
    });
    const input = {
      sourceSlug: RAW_SLUG,
      forwarder: FORWARDER,
      signalIds: [candidates[1]!.signalId],
    };

    const first = await store.keepMarketRates(input);
    const before = await engine.getPage(`market-rate/${candidates[1]!.signalId}`, {
      sourceId: 'lp-rate-intel',
    });
    if (before === null) throw new Error('expected kept market rate');
    const second = await store.keepMarketRates(input);
    const after = await engine.getPage(`market-rate/${candidates[1]!.signalId}`, {
      sourceId: 'lp-rate-intel',
    });

    expect(second).toEqual(first);
    expect(await engine.listPages({ sourceId: 'lp-rate-intel', type: 'market-rate' })).toHaveLength(1);
    expect(after).toMatchObject({
      compiled_truth: before.compiled_truth,
      frontmatter: before.frontmatter,
      content_hash: before.content_hash,
    });
  });
});

describe('market-signal operations', () => {
  test('keeps only the read operation with exact rate filters and no review state', async () => {
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite', market_signals: {
        raw_source_id: 'default', derived_source_id: 'lp-rate-intel',
      } },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'lp-rate-intel',
    };

    expect(operationsByName.read_market_signals.scope).toBe('read');
    expect(operationsByName.read_market_signals.params).toMatchObject({
      carrier: { type: 'string', required: false },
      provider: { type: 'string', required: false },
    });
    expect(operationsByName.read_market_signals.params).not.toHaveProperty('state');
    expect(operationsByName).not.toHaveProperty('review_market_signal');
    await expect(operationsByName.read_market_signals.handler(ctx, {})).resolves.toEqual({ rates: [] });
  });
});

describe('market-signals config', () => {
  test('uses separate raw and derived source defaults and rejects overlap', () => {
    expect(resolveMarketSignalsConfig({ engine: 'pglite' })).toEqual({
      raw_source_id: 'default', derived_source_id: 'lp-rate-intel',
    });
    expect(() => resolveMarketSignalsConfig({
      engine: 'pglite', market_signals: { raw_source_id: 'default', derived_source_id: 'default' },
    })).toThrow('must differ');
  });
});
