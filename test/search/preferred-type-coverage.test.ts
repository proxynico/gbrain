import { describe, expect, test } from 'bun:test';
import type { PageType, SearchResult } from '../../src/core/types.ts';
import {
  applyPreferredTypeCoverage,
  isPreferredTypeWinner,
  selectPreferredTypeWinners,
} from '../../src/core/search/preferred-type-coverage.ts';

function result(
  slug: string,
  type: PageType,
  rank: number,
  sourceId = 'source-a',
): SearchResult {
  return {
    slug,
    source_id: sourceId,
    page_id: 1_000 + rank,
    title: slug,
    type,
    chunk_text: `${slug} document`,
    chunk_source: 'compiled_truth',
    chunk_id: 2_000 + rank,
    chunk_index: 0,
    score: 1 - rank / 1_000,
    stale: false,
  };
}

describe('preferred-type coverage', () => {
  test('selects one composite page winner per preferred type in typed rank order', () => {
    const meeting = result('shared/answer', 'meeting', 0, 'curated');
    const transcript = result('shared/answer', 'transcript', 1, 'raw');
    const transcriptDecoy = result('transcripts/decoy', 'transcript', 2, 'raw');

    const winners = selectPreferredTypeWinners(
      ['meeting', 'transcript'],
      [meeting, transcript, transcriptDecoy],
    );

    expect(winners).toEqual([
      { sourceId: 'curated', slug: 'shared/answer', type: 'meeting' },
      { sourceId: 'raw', slug: 'shared/answer', type: 'transcript' },
    ]);
  });

  test('puts the best winner first, bounds the second at 15, and preserves every other order', () => {
    const normal = Array.from({ length: 20 }, (_, i) => result(`normal/${i}`, 'note', i));
    const meeting = result('meetings/curated', 'meeting', 100, 'curated');
    const transcript = result('transcripts/best', 'transcript', 101, 'raw');
    const transcriptDecoy = result('transcripts/decoy', 'transcript', 102, 'raw');
    const ranked = [
      normal[0]!,
      normal[1]!,
      meeting,
      ...normal.slice(2, 16),
      transcriptDecoy,
      ...normal.slice(16),
      transcript,
    ];
    const winners = selectPreferredTypeWinners(
      ['meeting', 'transcript'],
      [meeting, transcript, transcriptDecoy],
    );

    const covered = applyPreferredTypeCoverage(ranked, winners, ranked);

    expect(covered[0]).toBe(meeting);
    expect(covered.findIndex((item) => item === transcript) + 1).toBeLessThanOrEqual(15);
    expect(covered.findIndex((item) => item === transcriptDecoy) + 1).toBeGreaterThan(15);
    expect(covered.filter((item) => item.type === 'note')).toEqual(normal);
  });

  test('leaves an additional winner at its existing rank inside the first 15', () => {
    const normal = Array.from({ length: 16 }, (_, i) => result(`normal/${i}`, 'note', i));
    const meeting = result('meetings/curated', 'meeting', 100, 'curated');
    const transcript = result('transcripts/best', 'transcript', 101, 'raw');
    const ranked = [normal[0]!, meeting, ...normal.slice(1, 6), transcript, ...normal.slice(6)];
    const transcriptRank = ranked.findIndex((item) => item === transcript) + 1;
    const winners = selectPreferredTypeWinners(
      ['meeting', 'transcript'],
      [meeting, transcript],
    );

    const covered = applyPreferredTypeCoverage(ranked, winners, ranked);

    expect(covered[0]).toBe(meeting);
    expect(covered.findIndex((item) => item === transcript) + 1).toBe(transcriptRank);
    expect(covered.filter((item) => item.type === 'note')).toEqual(normal);
  });

  test('re-admits the selected fused page when dedup removed it', () => {
    const normal = Array.from({ length: 20 }, (_, i) => result(`normal/${i}`, 'note', i));
    const meeting = result('meetings/curated', 'meeting', 100, 'curated');
    const transcript = result('transcripts/best', 'transcript', 101, 'raw');
    const winners = selectPreferredTypeWinners(
      ['meeting', 'transcript'],
      [meeting, transcript],
    );

    const covered = applyPreferredTypeCoverage(
      [meeting, ...normal],
      winners,
      [meeting, ...normal, transcript],
    );

    expect(covered[0]).toBe(meeting);
    expect(covered.findIndex((item) => item === transcript) + 1).toBe(15);
    expect(covered.filter((item) => item.type === 'note')).toEqual(normal);
  });

  test('winner matching uses source_id plus slug for autocut preservation', () => {
    const winner = result('shared/answer', 'transcript', 0, 'raw-a');
    const sameSlugOtherSource = result('shared/answer', 'transcript', 1, 'raw-b');
    const winners = selectPreferredTypeWinners(['transcript'], [winner]);

    expect(isPreferredTypeWinner(winner, winners)).toBe(true);
    expect(isPreferredTypeWinner(sameSlugOtherSource, winners)).toBe(false);
  });
});
