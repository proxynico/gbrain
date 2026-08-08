/**
 * Preferred-type recall regression.
 *
 * A federated corpus can contain enough bulk lexical matches to consume the
 * ordinary candidate window before a tiny, semantically authoritative type is
 * considered. These fixtures keep the bulk and derived sources separate and
 * prove the classifier's preferred types add recall without widening the
 * caller's source grant.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { PageType, SearchResult } from '../../src/core/types.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const DIMS = 1536;
const QUERY_VECTOR = Array.from({ length: DIMS }, (_, i) => i === 0 ? 1 : 0);
const BULK_COUNT = 110;

let engine: PGLiteEngine;
let embedCalls = 0;
let previousGbrainHome: string | undefined;
let isolatedHome: string;

function installWorkingEmbedTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    embedCalls += values.length;
    return { embeddings: values.map(() => QUERY_VECTOR) } as never;
  });
}

beforeAll(async () => {
  previousGbrainHome = process.env.GBRAIN_HOME;
  isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-preferred-type-recall-'));
  process.env.GBRAIN_HOME = isolatedHome;

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  installWorkingEmbedTransport();
});

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (previousGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = previousGbrainHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  embedCalls = 0;
});

async function addSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, '{"federated": true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function seedPage(input: {
  sourceId: string;
  slug: string;
  type: string;
  title: string;
  body: string;
}): Promise<void> {
  await engine.putPage(input.slug, {
    type: input.type,
    title: input.title,
    compiled_truth: input.body,
  }, { sourceId: input.sourceId });
  await engine.upsertChunks(input.slug, [{
    chunk_index: 0,
    chunk_text: input.body,
    chunk_source: 'compiled_truth',
  }], { sourceId: input.sourceId });
}

async function seedBulkMail(sourceId: string, phrase: string): Promise<void> {
  for (let i = 0; i < BULK_COUNT; i++) {
    await seedPage({
      sourceId,
      slug: `mail/bulk-message-${String(i).padStart(3, '0')}`,
      type: 'email',
      title: `Bulk message ${i}`,
      body: `${phrase} ${phrase} ${phrase} routine email thread ${i}`,
    });
  }
}

function searchOpts(sourceIds: string[]) {
  return {
    limit: 20,
    sourceIds,
    detail: 'high' as const,
    expansion: false,
    reranker: { enabled: false, topNIn: 20, topNOut: null },
    autocut: false,
    adaptiveReturn: false,
    graph_signals: false,
    relationalRetrieval: false,
    salience: 'off' as const,
    recency: 'off' as const,
  };
}

async function seedMarketCorpus(): Promise<string[]> {
  const allowed = ['bulk-mail', 'derived-weekly'];
  for (const sourceId of [...allowed, 'outside-grant']) await addSource(sourceId);
  await seedBulkMail('bulk-mail', 'what happened in the market last week');
  await seedPage({
    sourceId: 'derived-weekly',
    slug: 'reports/freight-digest-2026-w31',
    type: 'market-weekly',
    title: 'Freight Digest 2026-W31',
    body: 'What happened in the market last week? Capacity tightened and spot rates moved higher.',
  });
  await seedPage({
    sourceId: 'outside-grant',
    slug: 'reports/outside-market-decoy',
    type: 'market-weekly',
    title: 'Outside Freight Digest',
    body: 'what happened in the market last week '.repeat(12),
  });
  return allowed;
}

function syntheticResult(
  slug: string,
  type: PageType,
  rank: number,
  sourceId = 'synthetic-source',
): SearchResult {
  return {
    slug,
    source_id: sourceId,
    page_id: 10_000 + rank,
    title: slug,
    type,
    chunk_text: `${slug} unique retrieval document`,
    chunk_source: 'compiled_truth',
    chunk_id: 20_000 + rank,
    chunk_index: 0,
    score: 1 - rank / 10_000,
    stale: false,
  };
}

function installSyntheticSearchArms(preferred: SearchResult[]): {
  ordinary: SearchResult[];
  restore: () => void;
} {
  const ordinaryTypes = ['note', 'email', 'person', 'company'];
  const ordinary = Array.from({ length: 60 }, (_, i) =>
    syntheticResult(
      `ordinary/result-${String(i).padStart(2, '0')}`,
      ordinaryTypes[i % ordinaryTypes.length]!,
      i,
    ));
  const preferredTypes = new Set(['market-weekly', 'meeting', 'transcript']);
  const originalSearchKeyword = engine.searchKeyword.bind(engine);
  const originalSearchTitles = engine.searchTitles.bind(engine);
  const originalSearchVector = engine.searchVector.bind(engine);
  const resultsFor = (types: readonly string[] | undefined): SearchResult[] =>
    types?.some((type) => preferredTypes.has(type)) ? preferred : ordinary;

  engine.searchKeyword = async (_query, opts) => resultsFor(opts?.types);
  engine.searchTitles = async (_query, opts) => resultsFor(opts?.types);
  engine.searchVector = async (_embedding, opts) => resultsFor(opts?.types);

  return {
    ordinary,
    restore: () => {
      engine.searchKeyword = originalSearchKeyword;
      engine.searchTitles = originalSearchTitles;
      engine.searchVector = originalSearchVector;
    },
  };
}

describe('hybridSearch preferred-type recall', () => {
  test('explicit scalar and list type filters win without preferred typed lookups', async () => {
    const allowed = await seedMarketCorpus();

    const cases: Array<{
      hardFilter: { type: PageType } | { types: PageType[] };
      expectedType: PageType;
    }> = [
      { hardFilter: { type: 'market-weekly' }, expectedType: 'market-weekly' },
      { hardFilter: { types: ['email'] }, expectedType: 'email' },
    ];
    for (const { hardFilter, expectedType } of cases) {
      const originalSearchKeyword = engine.searchKeyword.bind(engine);
      const originalSearchTitles = engine.searchTitles.bind(engine);
      const originalSearchVector = engine.searchVector.bind(engine);
      let preferredTypedCalls = 0;
      const isPreferredLookup = (
        type: string | undefined,
        types: readonly string[] | undefined,
      ): boolean => type === undefined && types?.join(',') === 'market-weekly';
      engine.searchKeyword = async (query, opts) => {
        if (isPreferredLookup(opts?.type, opts?.types)) preferredTypedCalls += 1;
        return originalSearchKeyword(query, opts);
      };
      engine.searchTitles = async (query, opts) => {
        if (isPreferredLookup(opts?.type, opts?.types)) preferredTypedCalls += 1;
        return originalSearchTitles(query, opts);
      };
      engine.searchVector = async (embedding, opts) => {
        if (isPreferredLookup(opts?.type, opts?.types)) preferredTypedCalls += 1;
        return originalSearchVector(embedding, opts);
      };

      try {
        const results = await hybridSearch(
          engine,
          'What happened in the market last week?',
          { ...searchOpts(allowed), ...hardFilter },
        );
        expect(results.length).toBeGreaterThan(0);
        expect(results.every((result) => result.type === expectedType)).toBe(true);
        expect(preferredTypedCalls).toBe(0);
      } finally {
        engine.searchKeyword = originalSearchKeyword;
        engine.searchTitles = originalSearchTitles;
        engine.searchVector = originalSearchVector;
      }
    }
  });

  test('effective image-only modality suppresses every preferred-type lookup', async () => {
    await engine.setConfig('search.cross_modal.llm_intent', 'true');
    __setChatTransportForTests(async () => ({
      text: 'image',
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: 'test-model',
      providerId: 'test-provider',
    }));

    const originalSearchKeyword = engine.searchKeyword.bind(engine);
    const originalSearchTitles = engine.searchTitles.bind(engine);
    const originalSearchVector = engine.searchVector.bind(engine);
    let typedCalls = 0;
    engine.searchKeyword = async (query, opts) => {
      if (opts?.types?.length) typedCalls += 1;
      return originalSearchKeyword(query, opts);
    };
    engine.searchTitles = async (query, opts) => {
      if (opts?.types?.length) typedCalls += 1;
      return originalSearchTitles(query, opts);
    };
    engine.searchVector = async (embedding, opts) => {
      if (opts?.types?.length) typedCalls += 1;
      return originalSearchVector(embedding, opts);
    };

    try {
      await hybridSearch(
        engine,
        'What was actually said at the meeting about the chart?',
        searchOpts([]),
      );
      expect(typedCalls).toBe(0);
    } finally {
      engine.searchKeyword = originalSearchKeyword;
      engine.searchTitles = originalSearchTitles;
      engine.searchVector = originalSearchVector;
      __setChatTransportForTests(null);
    }
  });

  test('weekly market page ranks first after the ordinary federated window is exhausted', async () => {
    const allowed = await seedMarketCorpus();

    const originalSearchVector = engine.searchVector.bind(engine);
    let typedVectorCalls = 0;
    engine.searchVector = async (embedding, opts) => {
      if (opts?.types?.join(',') === 'market-weekly') typedVectorCalls += 1;
      return originalSearchVector(embedding, opts);
    };
    try {
      const results = await hybridSearch(
        engine,
        'What happened in the market last week?',
        searchOpts(allowed),
      );
      expect(results[0]?.slug).toBe('reports/freight-digest-2026-w31');
      expect(results.every((r) => r.source_id !== undefined && allowed.includes(r.source_id))).toBe(true);
      expect(typedVectorCalls).toBe(1);
      expect(embedCalls).toBe(1);
    } finally {
      engine.searchVector = originalSearchVector;
    }
  });

  test('preferred lexical candidates survive an embedding-provider outage', async () => {
    const allowed = await seedMarketCorpus();
    __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
      embedCalls += values.length;
      throw new Error('synthetic embedding outage');
    });
    try {
      const results = await hybridSearch(
        engine,
        'What happened in the market last week?',
        searchOpts(allowed),
      );
      expect(results[0]?.slug).toBe('reports/freight-digest-2026-w31');
      expect(results.every((r) => r.source_id !== undefined && allowed.includes(r.source_id))).toBe(true);
      expect(embedCalls).toBe(1);
    } finally {
      installWorkingEmbedTransport();
    }
  });

  test('preferred lexical candidates work without an embedding provider', async () => {
    const allowed = await seedMarketCorpus();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: DIMS,
      env: {},
    });
    try {
      const results = await hybridSearch(
        engine,
        'What happened in the market last week?',
        searchOpts(allowed),
      );
      expect(results[0]?.slug).toBe('reports/freight-digest-2026-w31');
      expect(results.every((r) => r.source_id !== undefined && allowed.includes(r.source_id))).toBe(true);
      expect(embedCalls).toBe(0);
    } finally {
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: DIMS,
        env: { OPENAI_API_KEY: 'sk-test' },
      });
      installWorkingEmbedTransport();
    }
  });

  test('meeting note stays first while the raw transcript reaches the first 15 results', async () => {
    const allowed = ['bulk-mail', 'curated-meetings', 'raw-transcripts'];
    for (const sourceId of [...allowed, 'outside-grant']) await addSource(sourceId);
    await seedBulkMail('bulk-mail', 'what was actually said at the acme kickoff meeting');
    await seedPage({
      sourceId: 'curated-meetings',
      slug: 'meetings/acme-kickoff',
      type: 'meeting',
      title: 'Acme Kickoff Meeting',
      body: 'What was actually said at the Acme kickoff meeting? This curated note records the decisions.',
    });
    await seedPage({
      sourceId: 'raw-transcripts',
      slug: 'transcripts/acme-kickoff-raw',
      type: 'transcript',
      title: 'Session Recording 2026-08-01',
      body: 'What was actually said at the Acme kickoff meeting? This is the verbatim speaker transcript.',
    });
    await seedPage({
      sourceId: 'outside-grant',
      slug: 'transcripts/outside-acme-decoy',
      type: 'transcript',
      title: 'Outside Session Recording',
      body: 'what was actually said at the acme kickoff meeting '.repeat(12),
    });

    const originalSearchVector = engine.searchVector.bind(engine);
    let typedVectorCalls = 0;
    engine.searchVector = async (embedding, opts) => {
      if (opts?.types?.join(',') === 'meeting,transcript') typedVectorCalls += 1;
      return originalSearchVector(embedding, opts);
    };
    try {
      const results = await hybridSearch(
        engine,
        'What was actually said at the Acme kickoff meeting?',
        searchOpts(allowed),
      );
      const transcriptRank = results.findIndex((r) => r.slug === 'transcripts/acme-kickoff-raw') + 1;
      expect(results[0]?.slug).toBe('meetings/acme-kickoff');
      expect(transcriptRank).toBeGreaterThan(0);
      expect(transcriptRank).toBeLessThanOrEqual(15);
      expect(results.every((r) => r.source_id !== undefined && allowed.includes(r.source_id))).toBe(true);
      expect(typedVectorCalls).toBe(1);
      expect(embedCalls).toBe(1);
    } finally {
      engine.searchVector = originalSearchVector;
    }
  });

  test('tokenmax fail-open reranker input includes the weekly winner and returns it first', async () => {
    const weekly = syntheticResult('reports/preferred-weekly', 'market-weekly', 100);
    const { ordinary, restore } = installSyntheticSearchArms([weekly]);
    let rerankerDocuments: string[] = [];
    try {
      const results = await hybridSearch(
        engine,
        'What happened in the market last week?',
        {
          ...searchOpts(['synthetic-source']),
          mode: 'tokenmax',
          limit: 50,
          autocut: true,
          reranker: {
            enabled: true,
            topNIn: 50,
            topNOut: null,
            rerankerFn: async (input) => {
              rerankerDocuments = input.documents;
              throw new Error('synthetic reranker outage');
            },
          },
        },
      );

      expect(rerankerDocuments).toContain(weekly.chunk_text);
      expect(results[0]?.slug).toBe(weekly.slug);
      expect(results.filter((r) => r.slug.startsWith('ordinary/')).map((r) => r.slug))
        .toEqual(ordinary.slice(0, 49).map((r) => r.slug));
      expect(embedCalls).toBe(1);
    } finally {
      restore();
    }
  });

  test('successful tokenmax rerank cannot drop or displace selected meeting coverage', async () => {
    const meeting = syntheticResult('meetings/preferred-curated', 'meeting', 100);
    const transcript = syntheticResult('transcripts/preferred-best', 'transcript', 101);
    const transcriptDecoy = syntheticResult('transcripts/lower-ranked-decoy', 'transcript', 102);
    const { restore } = installSyntheticSearchArms([meeting, transcript, transcriptDecoy]);
    let rerankerDocuments: string[] = [];
    let expectedNormalOrder: string[] = [];
    let autocutApplied: boolean | undefined;
    try {
      const results = await hybridSearch(
        engine,
        'What was actually said at the kickoff meeting?',
        {
          ...searchOpts(['synthetic-source']),
          mode: 'tokenmax',
          limit: 50,
          autocut: true,
          onMeta: (meta) => { autocutApplied = meta.autocut?.applied; },
          reranker: {
            enabled: true,
            topNIn: 50,
            topNOut: null,
            rerankerFn: async (input) => {
              rerankerDocuments = input.documents;
              const normalIndices = input.documents
                .map((document, index) => ({ document, index }))
                .filter(({ document }) => document.startsWith('ordinary/'))
                .reverse();
              expectedNormalOrder = normalIndices.map(({ document }) => document);
              const preferredIndices = input.documents
                .map((document, index) => ({ document, index }))
                .filter(({ document }) => !document.startsWith('ordinary/'));
              return [
                ...normalIndices.map(({ index }, rank) => ({ index, relevanceScore: 0.9 - rank * 0.001 })),
                ...preferredIndices.map(({ index }, rank) => ({ index, relevanceScore: 0.01 - rank * 0.001 })),
              ];
            },
          },
        },
      );

      expect(rerankerDocuments).toContain(meeting.chunk_text);
      expect(rerankerDocuments).toContain(transcript.chunk_text);
      expect(rerankerDocuments).not.toContain(transcriptDecoy.chunk_text);
      expect(results[0]?.slug).toBe(meeting.slug);
      expect(results.findIndex((r) => r.slug === transcript.slug) + 1).toBeLessThanOrEqual(15);
      expect(results.findIndex((r) => r.slug === transcriptDecoy.slug)).toBe(-1);
      expect(results.filter((r) => r.slug.startsWith('ordinary/')).map((r) => r.chunk_text))
        .toEqual(expectedNormalOrder);
      expect(autocutApplied).toBe(true);
      expect(embedCalls).toBe(1);
    } finally {
      restore();
    }
  });
});
