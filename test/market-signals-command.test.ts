import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseMarketSignalIntake,
  parseMarketSignalsArgs,
  runMarketSignals,
} from '../src/commands/market-signals.ts';
import { CLI_ONLY } from '../src/cli.ts';

describe('market-signals CLI', () => {
  test('advertises the manual market-signals surface and retires rates', () => {
    const result = spawnSync('bun', ['run', 'src/cli.ts', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_HOME: '/tmp/gbrain-market-signals-help' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('market-signals read');
    expect(result.stdout).toContain('market-signals candidates');
    expect(result.stdout).not.toContain('rates read');
  });

  test('is registered and prints detailed manual help without opening a brain', () => {
    expect(CLI_ONLY.has('market-signals')).toBe(true);
    expect(CLI_ONLY.has('rates')).toBe(false);

    const result = spawnSync('bun', ['run', 'src/cli.ts', 'market-signals', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_HOME: '/tmp/gbrain-market-signals-command-help' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('never polls, schedules, syncs, or scans email automatically');
    expect(result.stdout).toContain('RAW_SOURCE is the read-only email corpus');
    expect(result.stdout).toContain('DERIVED_SOURCE is the separate pure');
  });

  test('requires a forwarder and valid calendar dates for raw-source inspection', () => {
    expect(() => parseMarketSignalsArgs([
      'census', '--source', 'default',
    ])).toThrow('--forwarder is required');
    expect(() => parseMarketSignalsArgs([
      'candidates', '--source', 'default', '--since', '2026-08-01', '--until', '2026-08-05',
    ])).toThrow('--forwarder is required');
    expect(() => parseMarketSignalsArgs([
      'candidates', '--source', 'default',
    ])).toThrow('--forwarder is required');
    expect(() => parseMarketSignalsArgs([
      'census', '--source', 'default', '--forwarder', 'forwarder@example.test',
      '--since', '2026-02-30', '--until', '2026-03-01',
    ])).toThrow('ISO calendar date');
    expect(() => parseMarketSignalsArgs([
      'candidates', '--source', 'default', '--forwarder', 'forwarder@example.test',
      '--since', '2026-08-01', '--until', '2026-08-32',
    ])).toThrow('ISO calendar date');
  });

  test('rejects conflicting or missing review decisions and reviewers', () => {
    const base = ['review', 'market-signal-id', '--source', 'lp-rate-intel'];
    expect(() => parseMarketSignalsArgs([...base, '--ready', '--exclude', '--reviewer', 'reviewer@example.test']))
      .toThrow('exactly one');
    expect(() => parseMarketSignalsArgs([...base, '--ready']))
      .toThrow('--reviewer is required');
    expect(() => parseMarketSignalsArgs([...base, '--reviewer', 'reviewer@example.test']))
      .toThrow('exactly one');
  });

  test('accepts a valid candidate interval longer than 31 days while keeping the caps', () => {
    expect(parseMarketSignalsArgs([
      'candidates', '--source', 'default', '--forwarder', 'forwarder@example.test',
      '--since', '2026-06-01', '--until', '2026-08-01', '--limit', '25', '--max-body', '20000',
    ])).toEqual({
      command: 'candidates',
      sourceId: 'default',
      forwarder: 'forwarder@example.test',
      since: '2026-06-01',
      until: '2026-08-01',
      limit: 25,
      maxBodyChars: 20_000,
    });
  });

  test('census only queries the selected raw source and forwarder', async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const writes: string[] = [];
    await expect(runMarketSignals({
      withReservedConnection: async <T>(fn: (connection: {
        executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      }) => Promise<T>): Promise<T> => fn({
        executeRaw: async (sql, params) => {
          calls.push({ sql, params });
          return [{ pages: 2 }];
        },
      }),
    } as never, [
      'census', '--source', 'raw.test', '--forwarder', 'forwarder@example.test', '--json',
    ], {
      config: {
        engine: 'pglite',
        market_signals: { raw_source_id: 'raw.test', derived_source_id: 'derived.test' },
      },
      write: line => writes.push(line),
    })).resolves.toEqual({
      sourceId: 'raw.test',
      forwarder: 'forwarder@example.test',
      pages: 2,
      samples: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("frontmatter->>'from_address' = $2");
    expect(calls[0]?.params).toEqual(['raw.test', 'forwarder@example.test']);
    expect(writes.join('')).toContain('"pages": 2');
  });

  test('accepts only raw-page references in the local intake file', () => {
    const fixture = JSON.parse(readFileSync(
      join(new URL('..', import.meta.url).pathname, 'test/fixtures/market-signals/intake.json'),
      'utf8',
    )) as unknown;

    expect(parseMarketSignalIntake(fixture)).toEqual([
      {
        sourceSlug: 'emails/2026/spot-offer',
        forwarder: 'forwarder@example.test',
      },
    ]);
    expect(() => parseMarketSignalIntake([{
      sourceSlug: 'emails/2026/spot-offer',
      forwarder: 'forwarder@example.test',
      decision: 'market_signal',
      amount: 1,
      evidence: { excerpt: 'forged', sha256: 'a'.repeat(64) },
      fingerprint: 'b'.repeat(64),
      state: 'ready',
      reviewer: 'attacker@example.test',
      review: { state: 'ready' },
    }])).toThrow('unsupported field');
    expect(() => parseMarketSignalIntake([{
      sourceSlug: 'emails/2026/spot-offer',
      forwarder: ' ',
    }])).toThrow('forwarder must be a non-empty string');
  });

  test('keeps guide and fixture identities in the generic test domain', () => {
    for (const relativePath of [
      'docs/guides/market-signal-intelligence.md',
      'test/fixtures/market-signals/messages.jsonl',
      'test/fixtures/market-signals/intake.json',
    ]) {
      const content = readFileSync(join(new URL('..', import.meta.url).pathname, relativePath), 'utf8');
      const addresses = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/giu) ?? [];
      expect(addresses.length).toBeGreaterThan(0);
      expect(addresses.every(address => address.endsWith('@example.test'))).toBe(true);
    }

    const guide = readFileSync(
      join(new URL('..', import.meta.url).pathname, 'docs/guides/market-signal-intelligence.md'),
      'utf8',
    );
    expect(guide).toContain('"sourceSlug": "emails/2026/spot-offer"');
    expect(guide).toContain('"forwarder": "forwarder@example.test"');
    expect(guide).toContain('reloads each referenced raw page');
    expect(guide).not.toContain('A complete signal can be included');
  });
});
