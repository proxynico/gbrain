import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { BrainMarketSignalStore } from '../src/core/market-signals/store.ts';
import { resolveMarketSignalsConfig } from '../src/core/config.ts';
import {
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const FORWARDER = 'forwarder@example.test';
const DEFAULT_SOURCE_SLUG = 'emails/2026/market-update';

let engine: PGLiteEngine;
let store: BrainMarketSignalStore;

function forwardedMessage(body: string): string {
  return `FYI\n\n---------- Forwarded message ---------\nFrom: provider@example.test\nDate: Tue, 4 Aug 2026 10:00:00 +0000\nSubject: Market rate\nTo: ${FORWARDER}\n\n${body}`;
}

function completeSignalBody(amount = '4,300'): string {
  return `Spot offer: USD ${amount} per 40HQ from Port Alpha to Port Beta, valid until 31 Aug 2026.`;
}

async function putRawPage(
  sourceSlug = DEFAULT_SOURCE_SLUG,
  options: {
    body?: string;
    compiledTruth?: string;
    sender?: string;
  } = {},
): Promise<void> {
  await engine.putPage(sourceSlug, {
    type: 'email',
    title: 'FW: market rate',
    compiled_truth: options.compiledTruth ?? forwardedMessage(options.body ?? completeSignalBody()),
    frontmatter: { from_address: options.sender ?? FORWARDER, date: '2026-08-04' },
    effective_date: new Date('2026-08-04T10:00:00Z'),
    effective_date_source: 'date',
  }, { sourceId: 'default' });
}

async function persist(
  sourceSlug = DEFAULT_SOURCE_SLUG,
  forwarder = FORWARDER,
) {
  return store.persistDecision({ sourceSlug, forwarder });
}

async function readySignalAndReceipt(sourceSlug = DEFAULT_SOURCE_SLUG) {
  await putRawPage(sourceSlug);
  const signal = await persist(sourceSlug);
  if (signal === undefined) throw new Error('expected signal');
  await store.reviewMarketSignal({
    sourceId: 'lp-rate-intel',
    signalId: signal.signalId,
    state: 'ready',
    reviewer: 'reviewer@example.test',
  });
  const receipt = await engine.getPage(`receipt/${sourceSlug}`, {
    sourceId: 'lp-rate-intel',
  });
  if (receipt === null) throw new Error('expected receipt');
  return { signal, receipt };
}

async function addDerivedSource(
  id = 'lp-rate-intel',
  options: { federated?: boolean; localPath?: string | null } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, $2, $3::text::jsonb)`,
    [
      id,
      options.localPath ?? null,
      JSON.stringify({ federated: options.federated ?? false }),
    ],
  );
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

describe('market-signal derived storage', () => {
  test('reloads a raw-page reference and computes every derived field inside the store', async () => {
    await putRawPage();

    const created = await persist();

    expect(created).toMatchObject({
      sourceSlug: DEFAULT_SOURCE_SLUG,
      rawSourceId: 'default',
      signalType: 'spot_offer',
      amount: 4300,
      currency: 'USD',
      amountUnit: '40HQ',
      origin: 'Port Alpha',
      destination: 'Port Beta',
      equipment: '40HQ',
      provider: 'provider@example.test',
      state: 'needs_review',
      evidence: {
        excerpt: expect.stringContaining('USD 4,300 per 40HQ'),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('rejects missing or mismatched raw references and never accepts caller-owned derived or review fields', async () => {
    await expect(persist('emails/2026/missing')).rejects.toThrow('raw page not found');

    await putRawPage(DEFAULT_SOURCE_SLUG, { sender: 'other@example.test' });
    await expect(persist()).rejects.toThrow('does not match the exact forwarder');

    await expect(store.persistDecision({
      sourceSlug: DEFAULT_SOURCE_SLUG,
      forwarder: FORWARDER,
      amount: 1,
      evidence: { excerpt: 'forged', sha256: 'a'.repeat(64) },
      fingerprint: 'b'.repeat(64),
      state: 'ready',
      reviewer: 'attacker@example.test',
      review: { state: 'ready' },
    } as never)).rejects.toThrow('unsupported field');

    expect(await engine.listPages({ sourceId: 'lp-rate-intel' })).toEqual([]);
  });

  test('rejects the raw source and a federated or source-backed derived source before writing', async () => {
    await putRawPage();
    const rawStore = new BrainMarketSignalStore(engine, {
      rawSourceId: 'default',
      derivedSourceId: 'default',
    });
    await expect(rawStore.persistDecision({
      sourceSlug: DEFAULT_SOURCE_SLUG,
      forwarder: FORWARDER,
    })).rejects.toThrow('must differ');

    await engine.executeRaw('DELETE FROM sources WHERE id = $1', ['lp-rate-intel']);
    await addDerivedSource('lp-rate-intel', { federated: true });
    await expect(persist()).rejects.toThrow('must not be federated');

    await engine.executeRaw('DELETE FROM sources WHERE id = $1', ['lp-rate-intel']);
    await addDerivedSource('lp-rate-intel', { localPath: '/fixture/source' });
    await expect(persist()).rejects.toThrow('pure database source');

    expect(await engine.listPages({ sourceId: 'lp-rate-intel' })).toEqual([]);
  });

  test('is idempotent for an unchanged raw page and supersedes a changed signal from that page', async () => {
    await putRawPage();
    const firstPersisted = await persist();
    const duplicate = await persist();
    await putRawPage(DEFAULT_SOURCE_SLUG, { body: completeSignalBody('4,500') });
    const changed = await persist();

    expect(duplicate).toEqual(firstPersisted);
    expect(changed).toMatchObject({ state: 'needs_review', amount: 4500 });
    expect(changed?.signalId).not.toBe(firstPersisted?.signalId);
    const all = await store.readMarketSignals({
      sourceId: 'lp-rate-intel',
      states: ['needs_review', 'superseded'],
    });
    expect(all.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ signalId: firstPersisted?.signalId, state: 'superseded' }),
      expect.objectContaining({ signalId: changed?.signalId, state: 'needs_review', amount: 4500 }),
    ]));
  });

  test('does not inherit a ready review when the current raw content changes', async () => {
    await putRawPage();
    const first = await persist();
    if (first === undefined) throw new Error('expected first signal');
    await store.reviewMarketSignal({
      sourceId: 'lp-rate-intel',
      signalId: first.signalId,
      state: 'ready',
      reviewer: 'reviewer@example.test',
    });

    await putRawPage(DEFAULT_SOURCE_SLUG, { body: completeSignalBody('4,500') });
    const changed = await persist();
    if (changed === undefined) throw new Error('expected changed signal');

    expect(changed).toMatchObject({ amount: 4500, state: 'needs_review' });
    expect(changed.signalId).not.toBe(first.signalId);
    const changedPage = await engine.getPage(`market-signal/${changed.signalId}`, {
      sourceId: 'lp-rate-intel',
    });
    expect(changedPage?.frontmatter.review).toBeUndefined();
    expect((await store.readMarketSignals({
      sourceId: 'lp-rate-intel',
      states: ['superseded'],
    })).signals).toContainEqual(expect.objectContaining({ signalId: first.signalId }));
  });

  test('preserves a ready signal and receipt when its raw page is missing on re-check', async () => {
    const { signal, receipt } = await readySignalAndReceipt();
    await engine.deletePage(DEFAULT_SOURCE_SLUG, { sourceId: 'default' });

    await expect(persist()).rejects.toThrow('raw page not found');
    expect((await store.readMarketSignals({ sourceId: 'lp-rate-intel' })).signals)
      .toEqual([expect.objectContaining({ signalId: signal.signalId, state: 'ready' })]);
    expect(await engine.getPage(`receipt/${DEFAULT_SOURCE_SLUG}`, {
      sourceId: 'lp-rate-intel',
    })).toEqual(receipt);
  });

  test('preserves a ready signal and receipt when the re-check has a wrong forwarder', async () => {
    const { signal, receipt } = await readySignalAndReceipt();
    await putRawPage(DEFAULT_SOURCE_SLUG, { sender: 'other@example.test' });

    await expect(persist()).rejects.toThrow('does not match the exact forwarder');
    expect((await store.readMarketSignals({ sourceId: 'lp-rate-intel' })).signals)
      .toEqual([expect.objectContaining({ signalId: signal.signalId, state: 'ready' })]);
    expect(await engine.getPage(`receipt/${DEFAULT_SOURCE_SLUG}`, {
      sourceId: 'lp-rate-intel',
    })).toEqual(receipt);
  });

  test('preserves a ready signal and receipt when the forwarded original cannot be recovered', async () => {
    const { signal, receipt } = await readySignalAndReceipt();
    await putRawPage(DEFAULT_SOURCE_SLUG, { compiledTruth: 'Unstructured email body.' });

    await expect(persist()).rejects.toThrow('forwarded original');
    expect((await store.readMarketSignals({ sourceId: 'lp-rate-intel' })).signals)
      .toEqual([expect.objectContaining({ signalId: signal.signalId, state: 'ready' })]);
    expect(await engine.getPage(`receipt/${DEFAULT_SOURCE_SLUG}`, {
      sourceId: 'lp-rate-intel',
    })).toEqual(receipt);
  });

  test('supersedes a ready signal when a trusted manual re-check finds no rate', async () => {
    await putRawPage();
    const first = await persist();
    if (first === undefined) throw new Error('expected first signal');
    await store.reviewMarketSignal({
      sourceId: 'lp-rate-intel',
      signalId: first.signalId,
      state: 'ready',
      reviewer: 'reviewer@example.test',
    });

    await putRawPage(DEFAULT_SOURCE_SLUG, { body: 'Booking status update: vessel departed.' });

    await expect(persist()).resolves.toBeUndefined();
    expect((await store.readMarketSignals({ sourceId: 'lp-rate-intel' })).signals).toEqual([]);
    expect((await store.readMarketSignals({
      sourceId: 'lp-rate-intel',
      states: ['superseded'],
    })).signals).toEqual([expect.objectContaining({ signalId: first.signalId, state: 'superseded' })]);
    expect(await engine.getPage(`receipt/${DEFAULT_SOURCE_SLUG}`, {
      sourceId: 'lp-rate-intel',
    })).toMatchObject({
      frontmatter: { receipt: { sourceSlug: DEFAULT_SOURCE_SLUG, signalIds: [] } },
    });
  });

  test('supersedes a ready signal when a trusted manual re-check needs review', async () => {
    await putRawPage();
    const first = await persist();
    if (first === undefined) throw new Error('expected first signal');
    await store.reviewMarketSignal({
      sourceId: 'lp-rate-intel',
      signalId: first.signalId,
      state: 'ready',
      reviewer: 'reviewer@example.test',
    });

    await putRawPage(DEFAULT_SOURCE_SLUG, { body: 'Spot offer: USD 4,300.' });

    await expect(persist()).resolves.toBeUndefined();
    expect((await store.readMarketSignals({ sourceId: 'lp-rate-intel' })).signals).toEqual([]);
    expect((await store.readMarketSignals({
      sourceId: 'lp-rate-intel',
      states: ['superseded'],
    })).signals).toEqual([expect.objectContaining({ signalId: first.signalId, state: 'superseded' })]);
    expect(await engine.getPage(`receipt/${DEFAULT_SOURCE_SLUG}`, {
      sourceId: 'lp-rate-intel',
    })).toMatchObject({
      frontmatter: { receipt: { sourceSlug: DEFAULT_SOURCE_SLUG, signalIds: [] } },
    });
  });

  test('keeps identical originals on distinct raw slugs separate and reconciles each raw page independently', async () => {
    const firstSlug = 'emails/2026/duplicate-a';
    const secondSlug = 'emails/2026/duplicate-b';
    await putRawPage(firstSlug);
    await putRawPage(secondSlug);

    const first = await persist(firstSlug);
    const second = await persist(secondSlug);
    if (first === undefined || second === undefined) throw new Error('expected two signals');
    expect(first.signalId).not.toBe(second.signalId);

    await putRawPage(firstSlug, { body: completeSignalBody('4,500') });
    const changedFirst = await persist(firstSlug);
    const all = (await store.readMarketSignals({
      sourceId: 'lp-rate-intel',
      states: ['needs_review', 'superseded'],
    })).signals;

    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ signalId: first.signalId, sourceSlug: firstSlug, state: 'superseded' }),
      expect.objectContaining({ signalId: changedFirst?.signalId, sourceSlug: firstSlug, state: 'needs_review' }),
      expect.objectContaining({ signalId: second.signalId, sourceSlug: secondSlug, state: 'needs_review' }),
    ]));
  });

  test('requires exactly one ready or excluded decision with a named reviewer', async () => {
    await putRawPage();
    const created = await persist();
    if (created === undefined) throw new Error('expected signal');

    await expect(store.reviewMarketSignal({
      sourceId: 'lp-rate-intel',
      signalId: created.signalId,
      state: 'needs_review',
      reviewer: 'reviewer.example.test',
    } as unknown as Parameters<BrainMarketSignalStore['reviewMarketSignal']>[0])).rejects.toThrow('ready or excluded');
    await expect(store.reviewMarketSignal({
      sourceId: 'lp-rate-intel',
      signalId: created.signalId,
      state: 'ready',
      reviewer: '   ',
    })).rejects.toThrow('reviewer');

    const ready = await store.reviewMarketSignal({
      sourceId: 'lp-rate-intel',
      signalId: created.signalId,
      state: 'ready',
      reviewer: ' reviewer.example.test ',
      note: 'Verified against the forwarded original.',
    });
    expect(ready).toMatchObject({ state: 'ready' });
  });

  test('reads ready signals by default with exact deterministic downstream filters', async () => {
    const readySlug = 'emails/2026/ready';
    const excludedSlug = 'emails/2026/excluded';
    await putRawPage(readySlug);
    await putRawPage(excludedSlug, {
      body: 'Rate circular: EUR 1,200 per 40HQ from Port Alpha to Port Gamma, valid until 31 Aug 2026.',
    });
    const ready = await persist(readySlug);
    const excluded = await persist(excludedSlug);
    if (ready === undefined || excluded === undefined) throw new Error('expected signals');
    await store.reviewMarketSignal({
      sourceId: 'lp-rate-intel', signalId: ready.signalId, state: 'ready', reviewer: 'reviewer.example.test',
    });
    await store.reviewMarketSignal({
      sourceId: 'lp-rate-intel', signalId: excluded.signalId, state: 'excluded', reviewer: 'reviewer.example.test',
    });

    expect((await store.readMarketSignals({ sourceId: 'lp-rate-intel' })).signals)
      .toEqual([expect.objectContaining({ signalId: ready.signalId, state: 'ready' })]);
    expect((await store.readMarketSignals({
      sourceId: 'lp-rate-intel',
      origin: 'Port Alpha',
      destination: 'Port Beta',
      equipment: '40HQ',
      currency: 'USD',
      signalType: 'spot_offer',
      states: ['ready', 'excluded'],
    })).signals).toEqual([expect.objectContaining({ signalId: ready.signalId })]);
    expect((await store.readMarketSignals({
      sourceId: 'lp-rate-intel',
      origin: 'port alpha',
    })).signals).toEqual([]);
  });

  test('writes empty receipts but no derived signals for no-rate or incomplete raw pages and rejects unrecoverable raw content', async () => {
    await putRawPage('emails/2026/no-rate', { body: 'Booking status update: vessel departed.' });
    await putRawPage('emails/2026/incomplete', { body: 'Spot offer: USD 4,300.' });
    await putRawPage('emails/2026/unrecoverable', { compiledTruth: 'USD 4,300 per 40HQ.' });

    await expect(persist('emails/2026/no-rate')).resolves.toBeUndefined();
    await expect(persist('emails/2026/incomplete')).resolves.toBeUndefined();
    await expect(persist('emails/2026/unrecoverable')).rejects.toThrow('forwarded original');
    expect(await engine.listPages({
      sourceId: 'lp-rate-intel',
      type: 'market-signal',
    })).toEqual([]);
    expect(await engine.getPage('receipt/emails/2026/no-rate', {
      sourceId: 'lp-rate-intel',
    })).toMatchObject({
      frontmatter: { receipt: { signalIds: [] } },
    });
    expect(await engine.getPage('receipt/emails/2026/incomplete', {
      sourceId: 'lp-rate-intel',
    })).toMatchObject({
      frontmatter: { receipt: { signalIds: [] } },
    });
    expect(await engine.getPage('receipt/emails/2026/unrecoverable', {
      sourceId: 'lp-rate-intel',
    })).toBeNull();
  });

  test('does not expose staging or reconciliation that could bypass a named review', () => {
    expect('putReceipt' in store).toBe(false);
    expect('reconcileMarketSignals' in store).toBe(false);
  });

  test('returns the persisted signal even when it sorts after the bounded reader window', async () => {
    for (let index = 0; index < 100; index++) {
      const sourceSlug = `emails/2026/window-${index}`;
      await putRawPage(sourceSlug);
      await persist(sourceSlug);
    }
    const targetSlug = 'emails/2026/window-target';
    await putRawPage(targetSlug);

    await expect(persist(targetSlug)).resolves.toMatchObject({
      sourceSlug: targetSlug,
      state: 'needs_review',
    });
  });
});

describe('market-signals config', () => {
  test('uses separate raw and derived source defaults and rejects an unsafe overlap', () => {
    expect(resolveMarketSignalsConfig({ engine: 'pglite' })).toEqual({
      raw_source_id: 'default',
      derived_source_id: 'lp-rate-intel',
    });
    expect(() => resolveMarketSignalsConfig({
      engine: 'pglite',
      market_signals: { raw_source_id: 'default', derived_source_id: 'default' },
    })).toThrow('must differ');
  });
});

describe('market-signal operations', () => {
  test('reads ready signals by default and records an explicit local review only in the configured derived source', async () => {
    await putRawPage();
    const created = await persist();
    if (created === undefined) throw new Error('expected signal');
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
    expect(operationsByName.review_market_signal.scope).toBe('write');
    expect(await operationsByName.read_market_signals.handler(ctx, {})).toEqual({ signals: [] });
    await expect(operationsByName.review_market_signal.handler(ctx, {
      signal_id: created.signalId,
      state: 'ready',
      reviewer: '   ',
    })).rejects.toThrow('reviewer');

    await expect(operationsByName.review_market_signal.handler(ctx, {
      signal_id: created.signalId,
      state: 'ready',
      reviewer: 'reviewer.example.test',
    })).resolves.toMatchObject({ signalId: created.signalId, state: 'ready' });
    await expect(operationsByName.read_market_signals.handler(ctx, {
      origin: 'Port Alpha', currency: 'USD', signal_type: 'spot_offer',
    })).resolves.toEqual({ signals: [expect.objectContaining({ signalId: created.signalId })] });
  });
});
