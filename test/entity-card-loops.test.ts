/**
 * buildEntityCard (src/core/verbs/entity-card.ts) — the v0.47 open-loop-backed
 * open_threads entries. Additive optional fields (direction/due/counterparty/
 * status/loop_id) appear ONLY on threads backed by an open_loops row; a
 * commitment fact already surfaced via its loop's fact_id is not duplicated;
 * brains with no loop rows still build cards.
 *
 * Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { formatResult } from '../src/cli/main.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildEntityCard, type EntityCard } from '../src/core/verbs/entity-card.ts';
import { closeOpenLoop, upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';

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
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
  await engine.putPage(
    'people/alice-example',
    { title: 'Alice', type: 'person', compiled_truth: 'Alice, a founder at acme-example.' },
    { sourceId: 'g1' },
  );
});

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'g1',
    dedupKey: 'thread:18c2f4a9b3d21e07:unanswered_inbound',
    loopType: 'unanswered_inbound',
    counterpartySlug: 'people/alice-example',
    counterpartyEmail: 'alice@example.com',
    summary: 'Reply owed to alice@example.com: "Quarterly plan" (2d)',
    evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'Can you review the plan?' }],
    threadId: '18c2f4a9b3d21e07',
    detector: 'deterministic_thread',
    ...over,
  };
}

async function card(name = 'Alice'): Promise<EntityCard> {
  const res = await buildEntityCard(engine, 'g1', name, { remote: false });
  expect(res.found).toBe(true);
  return res.card!;
}

describe('entity card open-loop-backed open_threads', () => {
  test('an open loop pointing at the person surfaces first with loop_id/direction/due/status', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const c = await card();
    expect(c.open_threads.length).toBeGreaterThanOrEqual(1);
    const t = c.open_threads[0];
    expect(t.kind).toBe('commitment');
    expect(t.text).toBe('Reply owed to alice@example.com: "Quarterly plan" (2d)');
    expect(t.loop_id).toBe(id);
    expect(t.direction).toBe('my_turn'); // unanswered_inbound = I owe the reply
    expect(t.due).toBeNull();
    expect(t.status).toBe('open');
    expect(t.counterparty).toBe('people/alice-example');
    expect(t.date).toBeTruthy();
  });

  test('loop_type → direction mapping across all four mapped types', async () => {
    const cases: Array<{
      loopType: OpenLoopUpsert['loopType'];
      dedup: string;
      direction: string;
    }> = [
      { loopType: 'commitment_owed_by_me', dedup: 'commit:aaaaaaaa', direction: 'owed_by_me' },
      { loopType: 'commitment_owed_to_me', dedup: 'commit:bbbbbbbb', direction: 'owed_to_me' },
      { loopType: 'unanswered_inbound', dedup: 'thread:18c2f4a9b3d21e01:unanswered_inbound', direction: 'my_turn' },
      { loopType: 'unanswered_outbound', dedup: 'thread:18c2f4a9b3d21e02:unanswered_outbound', direction: 'their_turn' },
    ];
    for (const cse of cases) {
      await resetPgliteState(engine);
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('g1', 'g1') ON CONFLICT (id) DO NOTHING`,
      );
      await engine.putPage(
        'people/alice-example',
        { title: 'Alice', type: 'person', compiled_truth: 'Alice.' },
        { sourceId: 'g1' },
      );
      await upsertOpenLoop(
        engine,
        loop({
          loopType: cse.loopType,
          dedupKey: cse.dedup,
          detector: cse.loopType.startsWith('commitment') ? 'llm_extract' : 'deterministic_thread',
        }),
      );
      const c = await card();
      expect(c.open_threads[0].direction).toBe(cse.direction as never);
    }
  });

  test('due_at rides through on the thread', async () => {
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:cccccccc',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
        dueAt: due,
      }),
    );
    const c = await card();
    const t = c.open_threads[0];
    expect(t.due).toBeTruthy();
    expect(new Date(t.due as never as string).getTime()).toBe(Date.parse(due));
  });

  test('a commitment fact whose id is the loop fact_id is NOT duplicated as a second thread', async () => {
    const factRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source)
       VALUES ('g1', 'people/alice-example', 'Send the deck to alice-example', 'commitment', 'loops-test')
       RETURNING id`,
    );
    const factId = Number(factRows[0].id);
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:dddddddd',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
        summary: 'Loop: send the deck',
        factId,
      }),
    );
    const c = await card();
    // The loop-backed thread is present...
    const loopThreads = c.open_threads.filter((t) => t.loop_id !== undefined);
    expect(loopThreads).toHaveLength(1);
    expect(loopThreads[0].text).toBe('Loop: send the deck');
    // ...and the projected fact does NOT appear a second time.
    const factTexts = c.open_threads.filter((t) => t.text === 'Send the deck to alice-example');
    expect(factTexts).toHaveLength(0);
    // The fact still counts as an active fact.
    expect(c.active_fact_count).toBe(1);
  });

  test('a commitment fact NOT backed by any loop still surfaces (without the loop-only fields)', async () => {
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source)
       VALUES ('g1', 'people/alice-example', 'Intro alice-example to fund-a', 'commitment', 'loops-test')`,
    );
    const c = await card();
    const t = c.open_threads.find((x) => x.text === 'Intro alice-example to fund-a');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('commitment');
    expect(t!.loop_id).toBeUndefined();
    expect(t!.direction).toBeUndefined();
    expect(t!.status).toBeUndefined();
  });

  test('closed loops do not surface as open_threads', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    await closeOpenLoop(engine, 'g1', id, 'done', 'manual');
    const c = await card();
    expect(c.open_threads.filter((t) => t.loop_id !== undefined)).toHaveLength(0);
  });

  test('loops for the same slug in ANOTHER source do not leak into the card', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('g2', 'g2') ON CONFLICT (id) DO NOTHING`,
    );
    await upsertOpenLoop(engine, loop({ sourceId: 'g2' }));
    const c = await card();
    expect(c.open_threads.filter((t) => t.loop_id !== undefined)).toHaveLength(0);
  });

  test('open_threads cap: at most 3 loop-backed threads, newest activity first', async () => {
    for (let i = 1; i <= 4; i++) {
      await upsertOpenLoop(
        engine,
        loop({
          dedupKey: `thread:18c2f4a9b3d21e0${i}:unanswered_inbound`,
          threadId: `18c2f4a9b3d21e0${i}`,
          summary: `loop ${i}`,
          lastActivityAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        }),
      );
    }
    const c = await card();
    expect(c.open_threads).toHaveLength(3);
    expect(c.open_threads.map((t) => t.text)).toEqual(['loop 1', 'loop 2', 'loop 3']);
  });

  test('brains with zero loop rows still build the card (open_loops query matches nothing)', async () => {
    const c = await card();
    expect(c.entity.slug).toBe('people/alice-example');
    expect(c.open_threads.filter((t) => t.loop_id !== undefined)).toHaveLength(0);
    // No loop-only optional fields anywhere.
    for (const t of c.open_threads) {
      expect(t.loop_id).toBeUndefined();
      expect(t.direction).toBeUndefined();
    }
  });
});


describe('canonical vault Open Threads', () => {
  const thread = (i: number) => `- **Issue ${i} (2026-01-0${i})** ${i === 1 ? '[standing] ' : ''}— Detail. [Source: [[2026-W01]]]`;
  async function vault(body: string, frontmatter: Record<string, unknown> = {}) {
    await engine.putPage('people/alice-example', { title: 'Alice', type: 'person', compiled_truth: body, frontmatter }, { sourceId: 'g1' });
  }
  test('seven cited issues retain title date, standing marker and source-qualified pointer', async () => {
    await vault(`## Open Threads\n${Array.from({ length: 7 }, (_, i) => thread(i + 1)).join('\n')}\n## Timeline\n- unrelated event`);
    const c = await card();
    expect(c.vault_threads?.total).toBe(7);
    expect(c.vault_threads?.omitted).toBe(0);
    expect(c.vault_threads?.page).toEqual({ source_id: 'g1', slug: 'people/alice-example' });
    expect(c.vault_threads?.items[0]).toEqual({ text: thread(1).slice(2), date: '2026-01-01', standing: true, citations: ['[Source: [[2026-W01]]]'] });
    expect(c.vault_threads?.full_page_required).toBe(true);
    expect(c.open_threads.length).toBeLessThanOrEqual(3);
  });
  test('the default CLI prints vault issues, counts, citations and the full-page instruction', async () => {
    await vault(`## Open Threads\n${Array.from({ length: 8 }, (_, i) => thread(i + 1)).join('\n')}`);
    const c = await card();
    const output = formatResult('entity', { found: true, latency_ms: 0, card: c });
    expect(output).toContain('vault open threads: 8 total, 1 omitted (g1:people/alice-example)');
    expect(output).toContain(thread(1).slice(2));
    expect(output).toContain(thread(7).slice(2));
    expect(output).not.toContain('Issue 8');
    expect(output).toContain('Read the full page g1:people/alice-example for a complete brief.');
    const unavailable = formatResult('entity', { found: true, latency_ms: 0, card: { ...c, vault_threads: undefined,
      vault_threads_unavailable: { page: { source_id: 'g1', slug: 'people/alice-example' }, reason: 'section_exceeds_card_prefix', full_page_required: true } } });
    expect(unavailable).toContain('vault open threads unavailable: section_exceeds_card_prefix (g1:people/alice-example)');
    expect(unavailable).toContain('Read the full page g1:people/alice-example for a complete brief.');
  });
  test('cap reports omitted items; empty section does not invent a recent event', async () => {
    await vault(`## Open Threads\n${Array.from({ length: 8 }, (_, i) => thread(i + 1)).join('\n')}`);
    expect((await card()).vault_threads).toMatchObject({ total: 8, omitted: 1, items: expect.any(Array) });
    expect((await card()).vault_threads?.items).toHaveLength(7);
    await vault('## Open Threads\n\n## Timeline\n- A recent event');
    expect((await card()).vault_threads).toMatchObject({ items: [], total: 0, omitted: 0 });
  });
  test('a bounded body prefix never claims a partial section has exact totals', async () => {
    const longDetail = 'An unresolved issue still needs a decision. '.repeat(2000);
    await vault(`## Open Threads\n${thread(1)}\n- **Long issue (2026-01-02)** — ${longDetail} [Source: [[2026-W01]]]\n## Timeline`);
    const partial = await card();
    expect(partial.vault_threads).toBeUndefined();
    expect(partial.vault_threads_unavailable).toEqual({ page: { source_id: 'g1', slug: 'people/alice-example' }, reason: 'section_exceeds_card_prefix', full_page_required: true });
    await vault(`## Open Threads\n${thread(1)}\n## Timeline\n${longDetail}`);
    expect((await card()).vault_threads).toMatchObject({ total: 1, omitted: 0 });
  });
  test('aliases use the current owner and explicit historical slugs keep their own section', async () => {
    await vault(`## Open Threads\n${thread(1)}`);
    await engine.setPageAliases('people/alice-example', 'g1', ['example founder']);
    await engine.putPage('archive/alice-example', { title: 'Alice', type: 'person', compiled_truth: `## Open Threads\n${thread(2)}`, frontmatter: { status: 'archived' } }, { sourceId: 'g1' });
    expect((await card('example founder')).vault_threads?.items[0].date).toBe('2026-01-01');
    expect((await card('Alice')).vault_threads?.page.slug).toBe('people/alice-example');
    expect((await card('archive/alice-example')).vault_threads?.items[0].date).toBe('2026-01-02');
  });
  test('remote page and fence visibility apply before thread counting', async () => {
    await vault(`## Open Threads\n${thread(1)}\n<!--- gbrain:takes:begin -->\n${thread(2)}\n<!--- gbrain:takes:end -->`);
    const remote = await buildEntityCard(engine, 'g1', 'Alice', { remote: true });
    expect(remote.card?.vault_threads?.total).toBe(1);
    expect(JSON.stringify(remote.card?.vault_threads)).not.toContain('Issue 2');
    await vault(`## Open Threads\n${thread(1)}`, { visibility: 'private' });
    const hidden = await buildEntityCard(engine, 'g1', 'Alice', { remote: true });
    expect(hidden.found).toBe(false);
    expect(hidden.card).toBeUndefined();
  });
});
