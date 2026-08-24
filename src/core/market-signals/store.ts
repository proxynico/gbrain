import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';
import type { Page, PageInput } from '../types.ts';
import {
  isMarketRateId,
  type MarketRateCandidate,
  type MarketRateId,
  type MarketSignalEvidence,
} from './types.ts';
import { inspectMarketRates } from './selection.ts';

const RATE_PAGE_TYPE = 'market-rate';
const MAX_RATE_SCAN = 5_000;
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface MarketSignalStoreOptions {
  rawSourceId: string;
  derivedSourceId: string;
}

export interface KeepMarketRatesInput {
  sourceSlug: string;
  forwarder: string;
  signalIds: MarketRateId[];
}

export interface MarketRate extends MarketRateCandidate {
  state: 'ready';
}

export interface ReadMarketRatesInput {
  origin?: string;
  destination?: string;
  equipment?: string;
  currency?: string;
  carrier?: string;
  provider?: string;
  limit?: number;
}

/** Creates a consistent loud failure for malformed derived-rate records. */
function integrityError(detail: string): Error {
  return new Error(`Market rate integrity error: ${detail}`);
}

/** Narrows JSON metadata to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads a required non-blank string from persisted rate metadata. */
function requiredString(value: unknown, field: string, pageSlug: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw integrityError(`invalid ${field} in stored market rate ${pageSlug}`);
  }
  return value;
}

/** Reads an optional persisted string through the same integrity checks. */
function optionalString(value: unknown, field: string, pageSlug: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field, pageSlug);
}

/** Reads a positive finite number from persisted rate metadata. */
function requiredNumber(value: unknown, field: string, pageSlug: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw integrityError(`invalid ${field} in stored market rate ${pageSlug}`);
  }
  return value;
}

/** Validates and reconstructs the retained evidence metadata. */
function readEvidence(value: unknown, pageSlug: string): MarketSignalEvidence {
  if (!isRecord(value)) throw integrityError(`missing evidence metadata for ${pageSlug}`);
  const excerpt = requiredString(value.excerpt, 'evidence excerpt', pageSlug);
  const sha256 = requiredString(value.sha256, 'evidence sha256', pageSlug);
  if (!SHA256_PATTERN.test(sha256)) {
    throw integrityError(`invalid evidence sha256 for ${pageSlug}`);
  }
  return { excerpt, sha256 };
}

/** Validates an optional ISO-compatible observation timestamp. */
function readObservedAt(value: unknown, pageSlug: string): string | undefined {
  if (value === undefined) return undefined;
  const observedAt = requiredString(value, 'observedAt', pageSlug);
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw integrityError(`invalid observedAt in stored market rate ${pageSlug}`);
  }
  return observedAt;
}

/** Reconstructs one ready market rate while checking its storage identity. */
function parseStoredRate(page: Page): MarketRate {
  if (page.type !== RATE_PAGE_TYPE) throw integrityError(`unexpected page type for ${page.slug}`);
  if (page.frontmatter.market_rate_kind !== 'rate') {
    throw integrityError(`unexpected kind marker for ${page.slug}`);
  }
  const stored = page.frontmatter.rate;
  if (!isRecord(stored)) throw integrityError(`missing structured rate metadata for ${page.slug}`);
  const fingerprint = requiredString(stored.fingerprint, 'fingerprint', page.slug);
  if (!SHA256_PATTERN.test(fingerprint)) {
    throw integrityError(`invalid fingerprint for ${page.slug}`);
  }
  const signalId = requiredString(stored.signalId, 'signalId', page.slug);
  if (!isMarketRateId(signalId) || signalId !== `market-rate-${fingerprint}`) {
    throw integrityError(`signalId/fingerprint mismatch for ${page.slug}`);
  }
  if (page.slug !== `market-rate/${signalId}`) {
    throw integrityError(`slug/signalId mismatch for ${page.slug}`);
  }
  if (stored.state !== 'ready') throw integrityError(`invalid state in stored market rate ${page.slug}`);
  const validity = optionalString(stored.validity, 'validity', page.slug);
  const observedAt = readObservedAt(stored.observedAt, page.slug);

  return {
    signalId,
    rawSourceId: requiredString(stored.rawSourceId, 'rawSourceId', page.slug),
    sourceSlug: requiredString(stored.sourceSlug, 'sourceSlug', page.slug),
    amount: requiredNumber(stored.amount, 'amount', page.slug),
    currency: requiredString(stored.currency, 'currency', page.slug),
    equipment: requiredString(stored.equipment, 'equipment', page.slug),
    origin: requiredString(stored.origin, 'origin', page.slug),
    destination: requiredString(stored.destination, 'destination', page.slug),
    ...(validity === undefined ? {} : { validity }),
    carrier: requiredString(stored.carrier, 'carrier', page.slug),
    provider: requiredString(stored.provider, 'provider', page.slug),
    evidenceExcerpt: requiredString(stored.evidenceExcerpt, 'evidenceExcerpt', page.slug),
    ...(observedAt === undefined ? {} : { observedAt }),
    evidence: readEvidence(stored.evidence, page.slug),
    fingerprint,
    state: 'ready',
  };
}

/** Normalizes user-visible fields for the generated markdown summary. */
function compactLine(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/** Builds the derived page written for one explicitly kept rate. */
function ratePage(rate: MarketRate): PageInput {
  return {
    type: RATE_PAGE_TYPE,
    title: `${compactLine(rate.origin)} to ${compactLine(rate.destination)} ${compactLine(rate.equipment)}`,
    compiled_truth: [
      '# Market rate',
      '',
      `- Route: ${compactLine(rate.origin)} to ${compactLine(rate.destination)}`,
      `- Rate: ${rate.currency} ${rate.amount} per ${rate.equipment}`,
      `- Carrier: ${compactLine(rate.carrier)}`,
      `- Source: ${compactLine(rate.sourceSlug)}`,
      '- State: ready',
    ].join('\n'),
    frontmatter: {
      market_rate_kind: 'rate',
      rate: {
        signalId: rate.signalId,
        rawSourceId: rate.rawSourceId,
        sourceSlug: rate.sourceSlug,
        amount: rate.amount,
        currency: rate.currency,
        equipment: rate.equipment,
        origin: rate.origin,
        destination: rate.destination,
        ...(rate.validity === undefined ? {} : { validity: rate.validity }),
        carrier: rate.carrier,
        provider: rate.provider,
        evidenceExcerpt: rate.evidenceExcerpt,
        evidence: { ...rate.evidence },
        fingerprint: rate.fingerprint,
        ...(rate.observedAt === undefined ? {} : { observedAt: rate.observedAt }),
        state: 'ready',
      },
    },
  };
}

/** Validates the non-empty, unique set of selected candidate IDs. */
function validSelectedIds(value: unknown): MarketRateId[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('market rate selected IDs must be a non-empty array');
  }
  const ids = value.map((entry, index) => {
    if (!isMarketRateId(entry)) {
      throw new Error(`invalid market rate selected ID at index ${index}`);
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error('market rate selected IDs contain a duplicate');
  }
  return ids;
}

/** Applies the bounded derived-rate read limit. */
function clampReadLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_READ_LIMIT;
  const floored = Math.floor(limit);
  return floored < 1 ? DEFAULT_READ_LIMIT : Math.min(floored, MAX_READ_LIMIT);
}

/** Lists derived rate pages within the fixed integrity-scan budget. */
async function listRatePages(engine: BrainEngine, sourceId: string): Promise<Page[]> {
  const pages = await engine.listPages({
    sourceId,
    type: RATE_PAGE_TYPE,
    slugPrefix: 'market-rate/',
    sort: 'slug',
    limit: MAX_RATE_SCAN + 1,
  });
  if (pages.length > MAX_RATE_SCAN) {
    throw new Error(`Market rate scan budget exceeded: source ${sourceId} has more than ${MAX_RATE_SCAN} market-rate pages`);
  }
  return pages;
}

/** Applies the supported exact-match filters to one stored rate. */
function matchesReadFilters(rate: MarketRate, input: ReadMarketRatesInput): boolean {
  if (input.origin !== undefined && rate.origin !== input.origin) return false;
  if (input.destination !== undefined && rate.destination !== input.destination) return false;
  if (input.equipment !== undefined && rate.equipment !== input.equipment) return false;
  if (input.currency !== undefined && rate.currency !== input.currency) return false;
  if (input.carrier !== undefined && rate.carrier !== input.carrier) return false;
  if (input.provider !== undefined && rate.provider !== input.provider) return false;
  return true;
}

/** Stores attended selections and reads ready rates within one derived source. */
export class BrainMarketSignalStore {
  constructor(
    private readonly engine: BrainEngine,
    private readonly options: MarketSignalStoreOptions,
  ) {
    assertValidSourceId(options.rawSourceId);
    assertValidSourceId(options.derivedSourceId);
  }

  private async assertDerivedWriteSource(): Promise<void> {
    if (this.options.rawSourceId === this.options.derivedSourceId) {
      throw new Error('market_signals.raw_source_id and market_signals.derived_source_id must differ');
    }
    const source = (await this.engine.listAllSources()).find(row => row.id === this.options.derivedSourceId);
    if (source === undefined) {
      throw new Error(`market rates derived source '${this.options.derivedSourceId}' must be registered`);
    }
    if (source.config.federated === true) {
      throw new Error(`market rates derived source '${this.options.derivedSourceId}' must not be federated`);
    }
    if (source.local_path !== null) {
      throw new Error(`market rates derived source '${this.options.derivedSourceId}' must be a pure database source`);
    }
  }

  async keepMarketRates(input: KeepMarketRatesInput): Promise<MarketRate[]> {
    const selectedIds = validSelectedIds(input.signalIds);
    const candidates = await inspectMarketRates(this.engine, {
      sourceId: this.options.rawSourceId,
      sourceSlug: input.sourceSlug,
      forwarder: input.forwarder,
    });
    const byId = new Map(candidates.map(candidate => [candidate.signalId, candidate]));
    const selected = selectedIds.map(signalId => {
      const candidate = byId.get(signalId);
      if (candidate === undefined) {
        throw new Error(`market rate selected ID is not available from current raw email: ${signalId}`);
      }
      return { ...candidate, state: 'ready' as const };
    });

    await this.assertDerivedWriteSource();
    await this.engine.transaction(async tx => {
      for (const rate of selected) {
        const slug = `market-rate/${rate.signalId}`;
        const existing = await tx.getPage(slug, { sourceId: this.options.derivedSourceId });
        if (existing !== null) {
          const prior = parseStoredRate(existing);
          if (
            prior.rawSourceId !== rate.rawSourceId
            || prior.sourceSlug !== rate.sourceSlug
            || prior.fingerprint !== rate.fingerprint
          ) {
            throw integrityError(`signalId collision for ${rate.signalId}`);
          }
        }
        await tx.putPage(slug, ratePage(rate), { sourceId: this.options.derivedSourceId });
      }
    });
    return selected;
  }

  async readMarketRates(input: ReadMarketRatesInput): Promise<{ rates: MarketRate[] }> {
    const rates = (await listRatePages(this.engine, this.options.derivedSourceId))
      .map(parseStoredRate)
      .filter(rate => matchesReadFilters(rate, input))
      .sort((left, right) => (
        (left.observedAt ?? '').localeCompare(right.observedAt ?? '')
        || left.signalId.localeCompare(right.signalId)
      ))
      .slice(0, clampReadLimit(input.limit));
    return { rates };
  }
}
