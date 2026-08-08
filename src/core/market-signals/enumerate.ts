import type { BrainEngine } from '../engine.ts';

export const MAX_MARKET_SIGNAL_SCAN_PAGES = 25;
export const MAX_MARKET_SIGNAL_BODY_CHARS = 20_000;

export interface MarketSignalSourcePage {
  slug: string;
  title: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  effective_date: Date | string | null;
}

export interface EnumerateMarketSignalPagesOptions {
  sourceId: string;
  forwarder: string;
  since: string;
  until: string;
  limit?: number;
  maxBodyChars?: number;
}

function parseCalendarDate(value: string, flag: '--since' | '--until'): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${flag} must be an ISO calendar date (YYYY-MM-DD)`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`${flag} must be an ISO calendar date (YYYY-MM-DD)`);
  }
  return date.getTime();
}

/** Validates the exclusive UTC calendar-date interval for a manual scan. */
export function validateMarketSignalDateWindow(
  since: string | undefined,
  until: string | undefined,
): { since: string; until: string } {
  if (since === undefined) throw new Error('--since is required for market-signals candidates');
  if (until === undefined) throw new Error('--until is required for market-signals candidates');
  const sinceTime = parseCalendarDate(since, '--since');
  const untilTime = parseCalendarDate(until, '--until');
  if (untilTime <= sinceTime) throw new Error('--until must be after --since');
  return { since, until };
}

function calendarTimestamp(value: string, flag: '--since' | '--until'): string {
  return new Date(parseCalendarDate(value, flag)).toISOString();
}

function validateBoundedInteger(
  value: number,
  field: '--limit' | '--max-body',
  max: number,
): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`market-signals candidates ${field} must be an integer in 1..${max}`);
  }
}

/**
 * Reads at most 25 source-backed raw pages and truncates the body in SQL.
 * The ordering deliberately makes manual scans repeatable and newest-first.
 */
export async function enumerateMarketSignalPages(
  engine: BrainEngine,
  options: EnumerateMarketSignalPagesOptions,
): Promise<MarketSignalSourcePage[]> {
  validateMarketSignalDateWindow(options.since, options.until);
  const limit = options.limit ?? MAX_MARKET_SIGNAL_SCAN_PAGES;
  const maxBodyChars = options.maxBodyChars ?? MAX_MARKET_SIGNAL_BODY_CHARS;
  validateBoundedInteger(limit, '--limit', MAX_MARKET_SIGNAL_SCAN_PAGES);
  validateBoundedInteger(maxBodyChars, '--max-body', MAX_MARKET_SIGNAL_BODY_CHARS);
  if (options.forwarder.trim() === '') {
    throw new Error('--forwarder is required for market-signals candidates');
  }

  const rows = await engine.withReservedConnection(conn => conn.executeRaw<MarketSignalSourcePage>(
    `SELECT slug, title, LEFT(compiled_truth, $5) AS compiled_truth, frontmatter, effective_date
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND source_path IS NOT NULL
        AND effective_date >= $2::timestamptz
        AND effective_date < $3::timestamptz
        AND frontmatter->>'from_address' = $4
      ORDER BY effective_date DESC, slug
      LIMIT $6`,
    [
      options.sourceId,
      calendarTimestamp(options.since, '--since'),
      calendarTimestamp(options.until, '--until'),
      options.forwarder,
      maxBodyChars,
      limit,
    ],
  ));
  return rows.slice(0, limit);
}
