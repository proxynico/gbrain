import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveMarketSignalsConfig } from '../src/core/config.ts';
import { _resetDbPlaneMergeMemoForTests } from '../src/core/config-db-merge.ts';
import { inspectMarketRates } from '../src/core/market-signals/selection.ts';
import { BrainMarketSignalStore } from '../src/core/market-signals/store.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const FORWARDER = 'forwarder@example.test';
const RAW_SLUG = 'emails/2026/market-rate';

let engine: PGLiteEngine;
let store: BrainMarketSignalStore;

/** Registers one derived source with an explicit storage and federation shape. */
async function addDerivedSource(
  id = 'lp-rate-intel',
  options: { federated?: boolean; localPath?: string | null } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, NULL, $2::text::jsonb)`,
    [id, JSON.stringify({ federated: options.federated ?? false })],
  );
  if (options.localPath !== undefined) {
    await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [options.localPath, id]);
  }
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
      origin: 'Port Alpha', destination: 'Port Beta', equipment: '40HQ',
      currency: 'USD', carrier: 'Carrier One', provider: 'provider@example.test',
    })).rates).toEqual([expect.objectContaining({ signalId: candidates[1]!.signalId })]);
    expect((await store.readMarketRates({ origin: 'port alpha' })).rates)
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

  test('rejects missing, federated, and file-backed derived sources before writing', async () => {
    await putRawRatePage();
    const [candidate] = await inspectMarketRates(engine, {
      sourceId: 'default', sourceSlug: RAW_SLUG, forwarder: FORWARDER,
    });
    await addDerivedSource('federated-rate-intel', { federated: true });
    await addDerivedSource('file-rate-intel', { localPath: '/tmp/file-rate-intel' });

    const cases = [
      { sourceId: 'missing-rate-intel', message: 'must be registered' },
      { sourceId: 'federated-rate-intel', message: 'must not be federated' },
      { sourceId: 'file-rate-intel', message: 'must be a pure database source' },
    ];
    for (const { sourceId, message } of cases) {
      const invalidStore = new BrainMarketSignalStore(engine, {
        rawSourceId: 'default', derivedSourceId: sourceId,
      });
      await expect(invalidStore.keepMarketRates({
        sourceSlug: RAW_SLUG,
        forwarder: FORWARDER,
        signalIds: [candidate!.signalId],
      })).rejects.toThrow(message);
    }
    expect(await engine.listPages({ type: 'market-rate' })).toEqual([]);
  });

  test('does not read a legacy market-signal page from the same derived source', async () => {
    await engine.putPage('market-signal/legacy', {
      type: 'market-signal',
      title: 'legacy',
      compiled_truth: '',
      frontmatter: {},
    }, { sourceId: 'lp-rate-intel' });

    expect((await store.readMarketRates({})).rates).toEqual([]);
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
  test('reads non-empty exact-filter results and rejects invalid filters', async () => {
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite', market_signals: {
        raw_source_id: 'default', derived_source_id: 'lp-rate-intel',
      } },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'lp-rate-intel',
    };

    await putRawRatePage();
    const candidates = await inspectMarketRates(engine, {
      sourceId: 'default', sourceSlug: RAW_SLUG, forwarder: FORWARDER,
    });
    await store.keepMarketRates({
      sourceSlug: RAW_SLUG,
      forwarder: FORWARDER,
      signalIds: candidates.map(candidate => candidate.signalId),
    });

    expect(operationsByName.read_market_signals.scope).toBe('read');
    expect(operationsByName.read_market_signals.params).toMatchObject({
      carrier: { type: 'string', required: false },
      provider: { type: 'string', required: false },
      source_id: { type: 'string', required: false },
    });
    expect(operationsByName.read_market_signals.params).not.toHaveProperty('state');
    expect(operationsByName).not.toHaveProperty('review_market_signal');
    const sharedFilters = {
      origin: 'Port Alpha',
      destination: 'Port Beta',
      currency: 'USD',
      carrier: 'Carrier One',
      provider: 'provider@example.test',
    };
    for (const [field, value] of Object.entries(sharedFilters)) {
      const result = await operationsByName.read_market_signals.handler(ctx, { [field]: value });
      expect(result).toMatchObject({ rates: [expect.any(Object), expect.any(Object)] });
    }
    await expect(operationsByName.read_market_signals.handler(ctx, { equipment: '40HQ' }))
      .resolves.toMatchObject({ rates: [expect.objectContaining({ equipment: '40HQ' })] });
    await expect(operationsByName.read_market_signals.handler(ctx, { origin: ' ' }))
      .rejects.toThrow('origin must be a non-empty market rate filter');
    await expect(operationsByName.read_market_signals.handler(ctx, { limit: '1' }))
      .rejects.toThrow('limit must be a finite number');
  });

  test('rejects remote reads outside the single configured derived source', async () => {
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite', market_signals: {
        raw_source_id: 'default', derived_source_id: 'lp-rate-intel',
      } },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
    };
    // Bypass the required transport field to pin the runtime fail-closed guard.
    const unscopedCtx: OperationContext = { ...ctx, sourceId: undefined as never };

    await expect(operationsByName.read_market_signals.handler(ctx, {}))
      .rejects.toThrow("configured derived source 'lp-rate-intel'");
    const federatedCtx: OperationContext = {
      ...unscopedCtx,
      auth: { allowedSources: ['lp-rate-intel', 'default'] } as never,
    };
    await expect(operationsByName.read_market_signals.handler(federatedCtx, {
      source_id: 'lp-rate-intel',
    })).resolves.toEqual({ rates: [] });
    await expect(operationsByName.read_market_signals.handler(federatedCtx, {}))
      .rejects.toThrow('federated reads are not allowed');
    await expect(operationsByName.read_market_signals.handler({
      ...ctx,
      sourceId: '__all__',
    }, {})).rejects.toThrow('exactly one granted source');
    await expect(operationsByName.read_market_signals.handler(unscopedCtx, {}))
      .rejects.toThrow('exactly one granted source');
  });

  test('uses DB-plane source routing for a remote operation context', async () => {
    await addDerivedSource('db-rate-intel');
    await engine.setConfig('market_signals.raw_source_id', 'default');
    await engine.setConfig('market_signals.derived_source_id', 'db-rate-intel');
    _resetDbPlaneMergeMemoForTests();
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'db-rate-intel',
    };

    try {
      await expect(operationsByName.read_market_signals.handler(ctx, {
        source_id: 'db-rate-intel',
      })).resolves.toEqual({ rates: [] });
    } finally {
      await engine.unsetConfig('market_signals.raw_source_id');
      await engine.unsetConfig('market_signals.derived_source_id');
      _resetDbPlaneMergeMemoForTests();
    }
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
