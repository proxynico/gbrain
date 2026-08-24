import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  parseMarketSignalsArgs,
  runMarketSignals,
} from '../src/commands/market-signals.ts';
import { CLI_ONLY } from '../src/cli.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const FORWARDER = 'forwarder@example.test';
const RAW_SLUG = 'emails/2026/market-rate';
const repoRoot = new URL('..', import.meta.url).pathname;
const CONFIG = {
  engine: 'pglite' as const,
  market_signals: { raw_source_id: 'default', derived_source_id: 'lp-rate-intel' },
};

let engine: PGLiteEngine;

async function addDerivedSource(): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, NULL, $2::text::jsonb)`,
    ['lp-rate-intel', JSON.stringify({ federated: false })],
  );
}

async function putRawRatePage(): Promise<void> {
  await engine.putPage(RAW_SLUG, {
    type: 'email',
    title: 'FW: market rate',
    compiled_truth: [
      'FYI', '', '---------- Forwarded message ---------',
      'From: provider@example.test', `To: ${FORWARDER}`, '',
      'POL', 'POD', 'ETD(validity)', 'RATE', 'SSL',
      'Port Alpha', 'Port Beta', '3Aug-9Aug', 'USD1200/2100 PER 20GP/40HQ', 'Carrier One',
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
});

describe('market-signals CLI', () => {
  test('parses inspect and selected-row keep arguments exactly', () => {
    expect(parseMarketSignalsArgs([
      'inspect', '--source', 'default', '--forwarder', 'forwarder@example.test', '--slug', 'emails/2026/market-rate',
    ])).toEqual({
      command: 'inspect', sourceId: 'default', forwarder: 'forwarder@example.test', sourceSlug: 'emails/2026/market-rate',
    });

    expect(parseMarketSignalsArgs([
      'keep', '--source', 'default', '--derived', 'lp-rate-intel', '--forwarder', 'forwarder@example.test', '--slug', 'emails/2026/market-rate',
      '--row', `market-rate-${'a'.repeat(64)}`, '--row', `market-rate-${'b'.repeat(64)}`,
    ])).toMatchObject({
      command: 'keep', signalIds: [`market-rate-${'a'.repeat(64)}`, `market-rate-${'b'.repeat(64)}`],
    });

    expect(() => parseMarketSignalsArgs([
      'keep', '--source', 'default', '--derived', 'lp-rate-intel', '--forwarder', 'forwarder@example.test', '--slug', 'emails/2026/market-rate',
    ])).toThrow('--row is required');
  });

  test('requires every flag once except rows and rejects duplicate rows before an engine is used', () => {
    expect(() => parseMarketSignalsArgs([
      'inspect', '--source', 'default', '--source', 'other', '--forwarder', FORWARDER, '--slug', RAW_SLUG,
    ])).toThrow('duplicate --source');
    expect(() => parseMarketSignalsArgs([
      'read', '--source', 'lp-rate-intel', '--carrier', 'Carrier One', '--carrier', 'Carrier Two',
    ])).toThrow('duplicate --carrier');
    expect(() => parseMarketSignalsArgs([
      'keep', '--source', 'default', '--derived', 'lp-rate-intel', '--forwarder', FORWARDER, '--slug', RAW_SLUG,
      '--row', `market-rate-${'a'.repeat(64)}`, '--row', `market-rate-${'a'.repeat(64)}`,
    ])).toThrow('duplicate --row');
  });

  test('inspects, keeps one returned row, then reads exactly that derived row', async () => {
    await putRawRatePage();
    const writes: string[] = [];

    const inspected = await runMarketSignals(engine, [
      'inspect', '--source', 'default', '--forwarder', FORWARDER, '--slug', RAW_SLUG,
    ], { config: CONFIG, write: line => writes.push(line) });
    expect(inspected).toEqual(expect.arrayContaining([
      expect.objectContaining({ signalId: expect.stringMatching(/^market-rate-[a-f0-9]{64}$/) }),
    ]));
    expect(await engine.listPages({ sourceId: 'lp-rate-intel', type: 'market-rate' })).toEqual([]);

    const selectedId = (inspected as Array<{ signalId: string }>)[1]!.signalId;
    const kept = await runMarketSignals(engine, [
      'keep', '--source', 'default', '--derived', 'lp-rate-intel', '--forwarder', FORWARDER, '--slug', RAW_SLUG,
      '--row', selectedId,
    ], { config: CONFIG, write: line => writes.push(line) });
    expect(kept).toEqual([expect.objectContaining({ signalId: selectedId, state: 'ready' })]);

    const read = await runMarketSignals(engine, [
      'read', '--source', 'lp-rate-intel', '--origin', 'Port Alpha', '--destination', 'Port Beta',
      '--equipment', '40HQ', '--currency', 'USD', '--carrier', 'Carrier One', '--provider', 'provider@example.test',
    ], { config: CONFIG, write: line => writes.push(line) });
    expect(read).toEqual({ rates: [expect.objectContaining({ signalId: selectedId })] });
    expect(writes.join('')).toContain(selectedId);
  });

  test('keeps require the configured raw and derived sources and reads reject review state', async () => {
    await putRawRatePage();
    const row = `market-rate-${'a'.repeat(64)}`;
    await expect(runMarketSignals(engine, [
      'keep', '--source', 'other', '--derived', 'lp-rate-intel', '--forwarder', FORWARDER, '--slug', RAW_SLUG, '--row', row,
    ], { config: CONFIG })).rejects.toThrow("raw source must match configured source 'default'");
    await expect(runMarketSignals(engine, [
      'keep', '--source', 'default', '--derived', 'other', '--forwarder', FORWARDER, '--slug', RAW_SLUG, '--row', row,
    ], { config: CONFIG })).rejects.toThrow("derived source must match configured source 'lp-rate-intel'");
    expect(() => parseMarketSignalsArgs(['read', '--source', 'lp-rate-intel', '--state', 'ready']))
      .toThrow('unknown market-signals read argument: --state');
  });

  test('is registered and exposes only inspect, keep, and read', () => {
    expect(CLI_ONLY.has('market-signals')).toBe(true);
    expect(CLI_ONLY.has('rates')).toBe(false);

    const result = spawnSync('bun', ['run', 'src/cli.ts', 'market-signals', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_HOME: '/tmp/gbrain-market-signals-command-help' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('market-signals inspect');
    expect(result.stdout).toContain('market-signals keep');
    expect(result.stdout).toContain('market-signals read');
    for (const retired of ['census', 'candidates', 'ingest', 'review', '--since', '--until', '--state', '--reviewer', '--note', '--from']) {
      expect(result.stdout).not.toContain(retired);
    }
  });

  test('documents the selected market-rate capture flow without the retired review workflow', () => {
    const guide = readFileSync(join(repoRoot, 'docs/guides/market-signal-intelligence.md'), 'utf8');
    expect(guide).toContain('inspect');
    expect(guide).toContain('keep');
    expect(guide).toContain('only selected rows are written');
    expect(guide).toContain('does not poll mail, schedule work, sync a source, call a model, or');
    expect(guide).toContain('run automatically');
    expect(guide).not.toContain('needs_review');
    expect(guide).not.toContain('ingest');
    expect(guide).not.toContain('review market-signal');
  });
});
