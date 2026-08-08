import type { PageType, SearchResult } from '../types.ts';

export interface PreferredTypeWinner {
  sourceId: string | undefined;
  slug: string;
  type: PageType;
}

function pageKey(sourceId: string | undefined, slug: string): string {
  return `${sourceId ?? 'default'}:${slug}`;
}

function matchesWinner(result: SearchResult, winner: PreferredTypeWinner): boolean {
  return pageKey(result.source_id, result.slug) === pageKey(winner.sourceId, winner.slug);
}

/** Select the first page-grain result for each preferred type in typed rank order. */
export function selectPreferredTypeWinners(
  preferredTypes: readonly PageType[],
  typedResults: readonly SearchResult[],
): PreferredTypeWinner[] {
  if (preferredTypes.length === 0 || typedResults.length === 0) return [];

  const wantedTypes = new Set(preferredTypes);
  const selectedTypes = new Set<PageType>();
  const selectedPages = new Set<string>();
  const winners: PreferredTypeWinner[] = [];

  for (const result of typedResults) {
    if (!wantedTypes.has(result.type) || selectedTypes.has(result.type)) continue;
    const key = pageKey(result.source_id, result.slug);
    if (selectedPages.has(key)) continue;

    winners.push({ sourceId: result.source_id, slug: result.slug, type: result.type });
    selectedTypes.add(result.type);
    selectedPages.add(key);
    if (selectedTypes.size === wantedTypes.size) break;
  }

  return winners;
}

export function isPreferredTypeWinner(
  result: SearchResult,
  winners: readonly PreferredTypeWinner[],
): boolean {
  return winners.some((winner) => matchesWinner(result, winner));
}

/**
 * Enforce bounded page-type coverage without re-sorting ordinary results.
 * Missing winners are re-admitted from the pre-dedup/pre-rerank candidate
 * pool. The best typed winner becomes rank 1; later winners already in the
 * first 15 stay put, otherwise they move to rank 15.
 */
export function applyPreferredTypeCoverage(
  ranked: readonly SearchResult[],
  winners: readonly PreferredTypeWinner[],
  candidates: readonly SearchResult[] = ranked,
): SearchResult[] {
  if (winners.length === 0) return [...ranked];

  const covered = [...ranked];
  for (const winner of winners) {
    if (covered.some((result) => matchesWinner(result, winner))) continue;
    const candidate = candidates.find((result) => matchesWinner(result, winner));
    if (candidate) covered.push(candidate);
  }

  const availableWinners = winners.filter((winner) =>
    covered.some((result) => matchesWinner(result, winner)));
  const bestWinner = availableWinners[0];
  if (!bestWinner) return covered;

  const bestIndex = covered.findIndex((result) => matchesWinner(result, bestWinner));
  if (bestIndex > 0) {
    const [best] = covered.splice(bestIndex, 1);
    covered.unshift(best!);
  }

  for (const winner of availableWinners.slice(1)) {
    const index = covered.findIndex((result) => matchesWinner(result, winner));
    if (index < 15) continue;
    const [result] = covered.splice(index, 1);
    covered.splice(Math.min(14, covered.length), 0, result!);
  }

  return covered;
}
