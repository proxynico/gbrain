/**
 * #4275-adjacent — the `entity` verb resolves across federated sources.
 *
 * Pre-fix the verb pinned a single source:
 *   buildEntityCard(ctx.engine, ctx.sourceId ?? 'default', name, ...)
 * On a multi-source brain an unqualified lookup therefore searched only
 * 'default' and returned found:false for pages that get_page and search both
 * resolve — the verb disagreed with every other read surface. It now takes the
 * same visibility ladder (federatedSearchScope): grant array, explicit scalar,
 * else the trusted-local federated span.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const entity = operations.find(o => o.name === 'entity')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    localFederatedSourceIds: ['default', 'alpha', 'beta'],
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha','alpha','/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta','beta','/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  await engine.putPage('people/ada-lovelace', {
    type: 'person', title: 'Ada Lovelace', compiled_truth: 'analyst',
    frontmatter: { type: 'person', aliases: ['LOVELACE Ada'] },
  }, { sourceId: 'alpha' });
  // putPage does not project frontmatter aliases; the import pipeline calls
  // setPageAliases. Set the row directly so this test exercises the lookup
  // path it is about rather than the projection.
  await engine.setPageAliases('people/ada-lovelace', 'alpha', ['lovelace ada']);
});

describe('entity verb federated scope', () => {
  test('unqualified lookup resolves a page in a non-default source', async () => {
    const r: any = await entity.handler(ctxOf(), { name: 'Ada Lovelace' });
    expect(r.found).toBe(true);
    expect(r.card.entity.slug).toBe('people/ada-lovelace');
  });

  test('an alias resolves across the federated span too', async () => {
    const r: any = await entity.handler(ctxOf(), { name: 'LOVELACE Ada' });
    expect(r.found).toBe(true);
    expect(r.card.entity.slug).toBe('people/ada-lovelace');
  });

  test('an explicit scalar source still pins, so isolation is unchanged', async () => {
    const r: any = await entity.handler(
      ctxOf({ sourceId: 'beta', localFederatedSourceIds: undefined }),
      { name: 'Ada Lovelace' },
    );
    expect(r.found).toBe(false);
  });

  test('a federated grant never widens past the granted sources', async () => {
    const r: any = await entity.handler(
      ctxOf({ remote: true, sourceId: undefined, auth: { allowedSources: ['beta'] } as any }),
      { name: 'Ada Lovelace' },
    );
    expect(r.found).toBe(false);
  });
});
