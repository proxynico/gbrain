import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';
import type { Page, PageInput } from '../types.ts';
import {
  assessMarketSignalPage,
  MAX_MARKET_SIGNAL_BODY_CHARS,
} from './agent-pass.ts';
import {
  buildEvidence,
  MAX_MARKET_SIGNAL_EVIDENCE_EXCERPT_CHARS,
} from './evidence.ts';
import { fingerprintMarketSignal } from './fingerprint.ts';
import {
  MARKET_SIGNAL_STATES,
  MARKET_SIGNAL_TYPES,
  type MarketSignalEvidence,
  type MarketSignalState,
  type MarketSignalType,
} from './types.ts';
import type { ParsedMarketSignal } from './validation.ts';

const RECEIPT_PAGE_TYPE = 'market-signal-receipt';
const SIGNAL_PAGE_TYPE = 'market-signal';
const RECEIPT_ANCESTRY_FIELD = 'market_signal_reconciliation_signal_ids';
const READ_PAGE_BATCH_SIZE = 500;
const MAX_SIGNAL_SCAN = 5_000;
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SIGNAL_ID_PATTERN = /^market-signal-([a-f0-9]{64})$/;

export interface MarketSignalStoreOptions {
  rawSourceId: string;
  derivedSourceId: string;
}

export interface MarketSignal {
  signalId: string;
  rawSourceId: string;
  sourceSlug: string;
  /** ISO timestamp the rate was observed — the raw email's effective_date. */
  observedAt: string;
  signalType: MarketSignalType;
  amount: number;
  currency: string;
  amountUnit: string;
  origin: string;
  destination: string;
  equipment: string;
  validity: string;
  provider: string;
  capacity?: string;
  evidence: MarketSignalEvidence;
  fingerprint: string;
  state: MarketSignalState;
}

export interface MarketSignalReceipt {
  sourceSlug: string;
  signalIds: string[];
  processedAt: string;
}

/** Untrusted manual intake identifies raw evidence; it never carries derived fields. */
export interface MarketSignalIntakeReference {
  sourceSlug: string;
  forwarder: string;
}

export interface ReadMarketSignalsInput {
  sourceId: string;
  states?: MarketSignalState[];
  origin?: string;
  destination?: string;
  equipment?: string;
  currency?: string;
  signalType?: MarketSignalType;
  limit?: number;
}

export interface ReadMarketSignalsResult {
  signals: MarketSignal[];
}

export interface ReviewMarketSignalInput {
  sourceId: string;
  signalId: string;
  state: 'ready' | 'excluded';
  reviewer: string;
  note?: string;
}

export interface MarketSignalStore {
  persistDecision(input: MarketSignalIntakeReference): Promise<MarketSignal | undefined>;
  readMarketSignals(input: ReadMarketSignalsInput): Promise<ReadMarketSignalsResult>;
  reviewMarketSignal(input: ReviewMarketSignalInput): Promise<MarketSignal>;
}

interface ReviewMetadata {
  state: 'ready' | 'excluded';
  reviewer: string;
  note?: string;
  reviewedAt: string;
}

function integrityError(detail: string): Error {
  return new Error(`Market signal integrity error: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, pageSlug: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw integrityError(`invalid ${field} in stored market signal ${pageSlug}`);
  }
  return value;
}

function optionalString(value: unknown, field: string, pageSlug: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field, pageSlug);
}

function requiredNumber(value: unknown, field: string, pageSlug: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw integrityError(`invalid ${field} in stored market signal ${pageSlug}`);
  }
  return value;
}

function readState(value: unknown, pageSlug: string): MarketSignalState {
  if (typeof value !== 'string' || !(MARKET_SIGNAL_STATES as readonly string[]).includes(value)) {
    throw integrityError(`invalid state in stored market signal ${pageSlug}`);
  }
  return value as MarketSignalState;
}

function readSignalType(value: unknown, pageSlug: string): MarketSignalType {
  if (typeof value !== 'string' || !(MARKET_SIGNAL_TYPES as readonly string[]).includes(value)) {
    throw integrityError(`invalid signalType in stored market signal ${pageSlug}`);
  }
  return value as MarketSignalType;
}

function readEvidence(value: unknown, pageSlug: string): MarketSignalEvidence {
  if (!isRecord(value)) {
    throw integrityError(`missing evidence metadata for ${pageSlug}`);
  }
  const excerpt = requiredString(value.excerpt, 'evidence excerpt', pageSlug);
  const sha256 = requiredString(value.sha256, 'evidence sha256', pageSlug);
  if (!SHA256_PATTERN.test(sha256)) {
    throw integrityError(`invalid evidence sha256 for ${pageSlug}`);
  }
  return { excerpt, sha256 };
}

function parseStoredSignal(page: Page): MarketSignal {
  if (page.type !== SIGNAL_PAGE_TYPE) {
    throw integrityError(`unexpected page type for ${page.slug}`);
  }
  if (page.frontmatter.market_signal_kind !== 'signal') {
    throw integrityError(`unexpected kind marker for ${page.slug}`);
  }
  const stored = page.frontmatter.signal;
  if (!isRecord(stored)) {
    throw integrityError(`missing structured signal metadata for ${page.slug}`);
  }
  const fingerprint = requiredString(stored.fingerprint, 'fingerprint', page.slug);
  if (!SHA256_PATTERN.test(fingerprint)) {
    throw integrityError(`invalid fingerprint for ${page.slug}`);
  }
  const signalId = requiredString(stored.signalId, 'signalId', page.slug);
  const idMatch = SIGNAL_ID_PATTERN.exec(signalId);
  if (idMatch === null || idMatch[1] !== fingerprint) {
    throw integrityError(`signalId/fingerprint mismatch for ${page.slug}`);
  }
  if (page.slug !== `market-signal/${signalId}`) {
    throw integrityError(`slug/signalId mismatch for ${page.slug}`);
  }
  const capacity = optionalString(stored.capacity, 'capacity', page.slug);
  const observedAt = requiredString(stored.observedAt, 'observedAt', page.slug);
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw integrityError(`invalid observedAt for ${page.slug}`);
  }

  return {
    signalId,
    rawSourceId: requiredString(stored.rawSourceId, 'rawSourceId', page.slug),
    sourceSlug: requiredString(stored.sourceSlug, 'sourceSlug', page.slug),
    observedAt,
    signalType: readSignalType(stored.signalType, page.slug),
    amount: requiredNumber(stored.amount, 'amount', page.slug),
    currency: requiredString(stored.currency, 'currency', page.slug),
    amountUnit: requiredString(stored.amountUnit, 'amountUnit', page.slug),
    origin: requiredString(stored.origin, 'origin', page.slug),
    destination: requiredString(stored.destination, 'destination', page.slug),
    equipment: requiredString(stored.equipment, 'equipment', page.slug),
    validity: requiredString(stored.validity, 'validity', page.slug),
    provider: requiredString(stored.provider, 'provider', page.slug),
    ...(capacity === undefined ? {} : { capacity }),
    evidence: readEvidence(stored.evidence, page.slug),
    fingerprint,
    state: readState(stored.state, page.slug),
  };
}

function parseReviewMetadata(page: Page): ReviewMetadata | undefined {
  const stored = page.frontmatter.review;
  if (stored === undefined) return undefined;
  if (!isRecord(stored)) {
    throw integrityError(`invalid review metadata for ${page.slug}`);
  }
  if (stored.state !== 'ready' && stored.state !== 'excluded') {
    throw integrityError(`invalid review state for ${page.slug}`);
  }
  const reviewer = requiredString(stored.reviewer, 'reviewer', page.slug);
  const note = optionalString(stored.note, 'note', page.slug);
  const reviewedAt = requiredString(stored.reviewedAt, 'reviewedAt', page.slug);
  if (!Number.isFinite(Date.parse(reviewedAt))) {
    throw integrityError(`invalid reviewedAt for ${page.slug}`);
  }
  return {
    state: stored.state,
    reviewer,
    ...(note === undefined ? {} : { note }),
    reviewedAt,
  };
}

function reviewedState(
  signal: MarketSignal,
  review: ReviewMetadata | undefined,
  pageSlug: string,
): 'ready' | 'excluded' | undefined {
  if (signal.state === 'ready' || signal.state === 'excluded') {
    if (review === undefined) {
      throw integrityError(`reviewed state lacks provenance for ${pageSlug}`);
    }
    if (signal.state !== review.state) {
      throw integrityError(`review state mismatch for ${pageSlug}`);
    }
    return signal.state;
  }
  if (signal.state === 'superseded' && review !== undefined) return review.state;
  return undefined;
}

function signalMetadata(signal: MarketSignal): MarketSignal {
  return {
    signalId: signal.signalId,
    rawSourceId: signal.rawSourceId,
    sourceSlug: signal.sourceSlug,
    observedAt: signal.observedAt,
    signalType: signal.signalType,
    amount: signal.amount,
    currency: signal.currency,
    amountUnit: signal.amountUnit,
    origin: signal.origin,
    destination: signal.destination,
    equipment: signal.equipment,
    validity: signal.validity,
    provider: signal.provider,
    ...(signal.capacity === undefined ? {} : { capacity: signal.capacity }),
    evidence: { ...signal.evidence },
    fingerprint: signal.fingerprint,
    state: signal.state,
  };
}

function compactLine(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function signalPage(signal: MarketSignal, review?: ReviewMetadata): PageInput {
  return {
    type: SIGNAL_PAGE_TYPE,
    title: `${compactLine(signal.origin)} to ${compactLine(signal.destination)} ${compactLine(signal.equipment)}`,
    compiled_truth: [
      '# Market signal',
      '',
      `- Type: ${signal.signalType}`,
      `- Route: ${compactLine(signal.origin)} to ${compactLine(signal.destination)}`,
      `- Equipment: ${compactLine(signal.equipment)}`,
      `- Rate: ${signal.currency} ${signal.amount} per ${signal.amountUnit}`,
      `- Observed: ${signal.observedAt.slice(0, 10)}`,
      `- State: ${signal.state}`,
      `- Source: ${compactLine(signal.sourceSlug)}`,
    ].join('\n'),
    frontmatter: {
      date: signal.observedAt,
      market_signal_kind: 'signal',
      signal: signalMetadata(signal),
      ...(review === undefined ? {} : { review }),
    },
    effective_date: new Date(signal.observedAt),
    effective_date_source: 'date',
  };
}

function receiptPage(
  receipt: MarketSignalReceipt,
  ancestry?: string[],
): PageInput {
  return {
    type: RECEIPT_PAGE_TYPE,
    title: `Market signal receipt ${compactLine(receipt.sourceSlug)}`,
    compiled_truth: [
      '# Market signal receipt',
      '',
      `- Source: ${compactLine(receipt.sourceSlug)}`,
      `- Signals: ${receipt.signalIds.length}`,
    ].join('\n'),
    frontmatter: {
      market_signal_kind: 'receipt',
      receipt: {
        sourceSlug: receipt.sourceSlug,
        signalIds: [...receipt.signalIds],
        processedAt: receipt.processedAt,
      },
      ...(ancestry === undefined ? {} : { [RECEIPT_ANCESTRY_FIELD]: [...ancestry] }),
    },
  };
}

function clampReadLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_READ_LIMIT;
  const floored = Math.floor(limit);
  return floored < 1 ? DEFAULT_READ_LIMIT : Math.min(floored, MAX_READ_LIMIT);
}

function signalIds(value: unknown, field: string, sourceSlug: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_SIGNAL_SCAN) {
    throw integrityError(`invalid ${field} for ${sourceSlug}`);
  }
  const ids = value.map((entry, index) => {
    if (typeof entry !== 'string' || SIGNAL_ID_PATTERN.test(entry) === false) {
      throw integrityError(`invalid ${field} entry at index ${index} for ${sourceSlug}`);
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length) {
    throw integrityError(`duplicate ${field} for ${sourceSlug}`);
  }
  return ids;
}

function parsePriorReceiptSignalIds(page: Page, sourceSlug: string): string[] {
  const expectedSlug = `receipt/${sourceSlug}`;
  if (page.type !== RECEIPT_PAGE_TYPE || page.slug !== expectedSlug) {
    throw integrityError(`invalid prior receipt page for ${sourceSlug}`);
  }
  if (page.frontmatter.market_signal_kind !== 'receipt') {
    throw integrityError(`invalid prior receipt kind for ${sourceSlug}`);
  }
  const receipt = page.frontmatter.receipt;
  if (!isRecord(receipt) || receipt.sourceSlug !== sourceSlug) {
    throw integrityError(`invalid prior receipt metadata for ${sourceSlug}`);
  }
  const currentIds = signalIds(receipt.signalIds, 'receipt signalIds', sourceSlug);
  const ancestry = page.frontmatter[RECEIPT_ANCESTRY_FIELD];
  if (ancestry === undefined) return currentIds;
  if (currentIds.length !== 0) {
    throw integrityError(`prior receipt mixes current signal IDs and ancestry for ${sourceSlug}`);
  }
  return signalIds(ancestry, 'receipt ancestry', sourceSlug);
}

async function priorReceiptSignalIds(
  engine: BrainEngine,
  sourceId: string,
  sourceSlug: string,
): Promise<string[]> {
  const page = await engine.getPage(`receipt/${sourceSlug}`, { sourceId });
  return page === null ? [] : parsePriorReceiptSignalIds(page, sourceSlug);
}

async function listSignalPages(engine: BrainEngine, sourceId: string): Promise<Page[]> {
  const pages: Page[] = [];
  for (let offset = 0; ;) {
    const requestLimit = Math.min(READ_PAGE_BATCH_SIZE, MAX_SIGNAL_SCAN + 1 - pages.length);
    const batch = await engine.listPages({
      sourceId,
      type: SIGNAL_PAGE_TYPE,
      slugPrefix: 'market-signal/',
      sort: 'slug',
      limit: requestLimit,
      offset,
    });
    pages.push(...batch);
    if (pages.length > MAX_SIGNAL_SCAN) {
      throw new Error(
        `Market signal scan budget exceeded: source ${sourceId} has more than ${MAX_SIGNAL_SCAN} market-signal pages`,
      );
    }
    if (batch.length < requestLimit) return pages;
    offset += batch.length;
  }
}

function matchesReadFilters(
  signal: MarketSignal,
  input: ReadMarketSignalsInput,
  states: MarketSignalState[],
): boolean {
  if (!states.includes(signal.state)) return false;
  if (input.origin !== undefined && signal.origin !== input.origin) return false;
  if (input.destination !== undefined && signal.destination !== input.destination) return false;
  if (input.equipment !== undefined && signal.equipment !== input.equipment) return false;
  if (input.currency !== undefined && signal.currency !== input.currency) return false;
  if (input.signalType !== undefined && signal.signalType !== input.signalType) return false;
  return true;
}

function intakeReference(input: MarketSignalIntakeReference): MarketSignalIntakeReference {
  if (!isRecord(input)) throw new Error('market signal intake reference must be an object');
  const allowed = new Set(['sourceSlug', 'forwarder']);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      throw new Error(`market signal intake reference contains unsupported field '${field}'`);
    }
  }
  if (typeof input.sourceSlug !== 'string' || input.sourceSlug.trim() === '') {
    throw new Error('market signal intake sourceSlug must be a non-empty string');
  }
  if (typeof input.forwarder !== 'string' || input.forwarder.trim() === '') {
    throw new Error('market signal intake forwarder must be a non-empty string');
  }
  return {
    sourceSlug: input.sourceSlug.trim(),
    forwarder: input.forwarder.trim(),
  };
}

function toObservedAt(value: Date | string | null, sourceSlug: string): string {
  const millis = value instanceof Date ? value.getTime() : value === null ? NaN : Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw integrityError(`raw page lacks a usable effective_date for ${sourceSlug}`);
  }
  return new Date(millis).toISOString();
}

function completeParsedField(
  value: string | undefined,
  field: string,
  sourceSlug: string,
): string {
  if (value === undefined || value.trim() === '') {
    throw integrityError(`complete assessment lacks ${field} for ${sourceSlug}`);
  }
  return value;
}

function signalFromAssessment(
  sourceSlug: string,
  rawSourceId: string,
  observedAt: string,
  assessment: ParsedMarketSignal,
  evidence: MarketSignalEvidence,
): MarketSignal {
  if (assessment.decision !== 'market_signal') {
    throw integrityError(`cannot materialize incomplete assessment for ${sourceSlug}`);
  }
  if (
    assessment.signalType === undefined
    || assessment.amount === undefined
    || !Number.isFinite(assessment.amount)
    || assessment.amount <= 0
    || assessment.lane === undefined
  ) {
    throw integrityError(`complete assessment lacks required fields for ${sourceSlug}`);
  }
  const fingerprint = fingerprintMarketSignal(assessment, evidence.sha256, sourceSlug);
  return {
    signalId: `market-signal-${fingerprint}`,
    rawSourceId,
    sourceSlug,
    observedAt,
    signalType: assessment.signalType,
    amount: assessment.amount,
    currency: completeParsedField(assessment.currency, 'currency', sourceSlug),
    amountUnit: completeParsedField(assessment.amountUnit, 'amountUnit', sourceSlug),
    origin: completeParsedField(assessment.lane.origin, 'origin', sourceSlug),
    destination: completeParsedField(assessment.lane.destination, 'destination', sourceSlug),
    equipment: completeParsedField(assessment.equipment, 'equipment', sourceSlug),
    validity: completeParsedField(assessment.validity, 'validity', sourceSlug),
    provider: completeParsedField(assessment.provider, 'provider', sourceSlug),
    ...(assessment.capacity === undefined ? {} : { capacity: assessment.capacity }),
    evidence,
    fingerprint,
    state: 'needs_review',
  };
}

export class BrainMarketSignalStore implements MarketSignalStore {
  readonly #stagedReceipts = new Map<string, MarketSignalReceipt>();

  constructor(
    private readonly engine: BrainEngine,
    private readonly options: MarketSignalStoreOptions,
  ) {
    assertValidSourceId(options.rawSourceId);
    assertValidSourceId(options.derivedSourceId);
  }

  private assertDerivedSourceId(sourceId: string): void {
    assertValidSourceId(sourceId);
    if (sourceId !== this.options.derivedSourceId) {
      throw new Error(
        `market signals require the configured derived source '${this.options.derivedSourceId}'`,
      );
    }
  }

  private async assertDerivedWriteSource(): Promise<void> {
    if (this.options.rawSourceId === this.options.derivedSourceId) {
      throw new Error('market_signals.raw_source_id and market_signals.derived_source_id must differ');
    }
    const source = (await this.engine.listAllSources()).find(
      row => row.id === this.options.derivedSourceId,
    );
    if (source === undefined) {
      throw new Error(`market signals derived source '${this.options.derivedSourceId}' must be registered`);
    }
    if (source.config.federated === true) {
      throw new Error(`market signals derived source '${this.options.derivedSourceId}' must not be federated`);
    }
    if (source.local_path !== null) {
      throw new Error(`market signals derived source '${this.options.derivedSourceId}' must be a pure database source`);
    }
  }

  async persistDecision(
    input: MarketSignalIntakeReference,
  ): Promise<MarketSignal | undefined> {
    const reference = intakeReference(input);
    await this.assertDerivedWriteSource();
    const rawPage = await this.engine.getPage(reference.sourceSlug, {
      sourceId: this.options.rawSourceId,
    });
    if (rawPage === null) {
      throw new Error(
        `market signal raw page not found in source '${this.options.rawSourceId}': ${reference.sourceSlug}`,
      );
    }
    const assessed = assessMarketSignalPage({
      slug: rawPage.slug,
      title: rawPage.title,
      compiled_truth: rawPage.compiled_truth,
      frontmatter: rawPage.frontmatter,
      effective_date: rawPage.effective_date ?? null,
    }, reference.forwarder, MAX_MARKET_SIGNAL_BODY_CHARS);
    if (rawPage.frontmatter.from_address !== reference.forwarder) {
      throw new Error(
        `market signal raw page sender does not match the exact forwarder for ${reference.sourceSlug}`,
      );
    }
    if (assessed.decision === 'needs_source_recovery') {
      throw new Error(`market signal forwarded original could not be recovered for ${reference.sourceSlug}`);
    }
    if (assessed.candidate === undefined || assessed.candidate.assessment.decision !== 'market_signal') {
      const receipt: MarketSignalReceipt = {
        sourceSlug: reference.sourceSlug,
        signalIds: [],
        processedAt: new Date().toISOString(),
      };
      await this.#putReceipt(receipt);
      await this.#reconcileMarketSignals(reference.sourceSlug, []);
      return undefined;
    }
    const original = assessed.candidate.original;
    const evidence = buildEvidence(
      original,
      original.body.slice(0, MAX_MARKET_SIGNAL_EVIDENCE_EXCERPT_CHARS),
    );
    const signal = signalFromAssessment(
      reference.sourceSlug,
      this.options.rawSourceId,
      toObservedAt(assessed.candidate.effectiveDate, reference.sourceSlug),
      assessed.candidate.assessment,
      evidence,
    );
    const receipt: MarketSignalReceipt = {
      sourceSlug: signal.sourceSlug,
      signalIds: [signal.signalId],
      processedAt: new Date().toISOString(),
    };
    await this.#putReceipt(receipt);
    await this.#reconcileMarketSignals(signal.sourceSlug, [signal]);
    const page = await this.engine.getPage(
      `market-signal/${signal.signalId}`,
      { sourceId: this.options.derivedSourceId },
    );
    if (page === null) {
      throw integrityError(`persisted signal is missing: ${signal.signalId}`);
    }
    const persisted = parseStoredSignal(page);
    reviewedState(persisted, parseReviewMetadata(page), page.slug);
    return persisted;
  }

  async #putReceipt(receipt: MarketSignalReceipt): Promise<void> {
    await this.assertDerivedWriteSource();
    if (receipt.sourceSlug.trim() === '') {
      throw new Error('market signal receipt sourceSlug must be non-empty');
    }
    if (!Number.isFinite(Date.parse(receipt.processedAt))) {
      throw new Error('market signal receipt processedAt must be a valid timestamp');
    }
    signalIds(receipt.signalIds, 'receipt signalIds', receipt.sourceSlug);
    if (this.#stagedReceipts.has(receipt.sourceSlug)) {
      throw integrityError(`successful receipt staging overlap for ${receipt.sourceSlug}`);
    }
    this.#stagedReceipts.set(receipt.sourceSlug, {
      sourceSlug: receipt.sourceSlug,
      signalIds: [...receipt.signalIds],
      processedAt: receipt.processedAt,
    });
  }

  async #reconcileInEngine(
    tx: BrainEngine,
    sourceSlug: string,
    signals: MarketSignal[],
  ): Promise<void> {
    if (signals.length > MAX_SIGNAL_SCAN) {
      throw new Error(`Market signal reconciliation exceeds ${MAX_SIGNAL_SCAN} rows`);
    }
    const currentIds = new Set<string>();
    for (const signal of signals) {
      if (signal.sourceSlug !== sourceSlug) {
        throw integrityError('reconciliation signal sourceSlug mismatch');
      }
      if (signal.rawSourceId !== this.options.rawSourceId) {
        throw integrityError('reconciliation signal rawSourceId mismatch');
      }
      const expectedId = `market-signal-${signal.fingerprint}`;
      if (!SHA256_PATTERN.test(signal.fingerprint) || signal.signalId !== expectedId) {
        throw integrityError(`invalid incoming signal identity for ${signal.signalId}`);
      }
      if (currentIds.has(signal.signalId)) {
        throw integrityError(`duplicate incoming signalId ${signal.signalId}`);
      }
      currentIds.add(signal.signalId);
    }

    const priorIds = await priorReceiptSignalIds(
      tx,
      this.options.derivedSourceId,
      sourceSlug,
    );

    for (const signal of signals) {
      const slug = `market-signal/${signal.signalId}`;
      const page = await tx.getPage(slug, { sourceId: this.options.derivedSourceId });
      if (page === null) {
        await tx.putPage(slug, signalPage(signal), { sourceId: this.options.derivedSourceId });
        continue;
      }
      const prior = parseStoredSignal(page);
      if (prior.sourceSlug !== sourceSlug || prior.rawSourceId !== this.options.rawSourceId) {
        throw integrityError(`signalId collision for ${signal.signalId}`);
      }
      if (prior.fingerprint !== signal.fingerprint) {
        throw integrityError(`fingerprint collision for ${signal.signalId}`);
      }
      const review = parseReviewMetadata(page);
      const state = reviewedState(prior, review, page.slug) ?? signal.state;
      await tx.putPage(
        slug,
        signalPage(
          { ...signal, state },
          state === 'ready' || state === 'excluded' ? review : undefined,
        ),
        { sourceId: this.options.derivedSourceId },
      );
    }

    for (const signalId of priorIds) {
      if (currentIds.has(signalId)) continue;
      const page = await tx.getPage(
        `market-signal/${signalId}`,
        { sourceId: this.options.derivedSourceId },
      );
      if (page === null) {
        throw integrityError(`prior receipt references missing signal ${signalId}`);
      }
      const signal = parseStoredSignal(page);
      if (signal.sourceSlug !== sourceSlug || signal.rawSourceId !== this.options.rawSourceId) {
        throw integrityError(`prior receipt source mismatch for ${signalId}`);
      }
      const review = parseReviewMetadata(page);
      reviewedState(signal, review, page.slug);
      if (signal.state === 'superseded') continue;
      await tx.putPage(
        page.slug,
        signalPage({ ...signal, state: 'superseded' }, review),
        { sourceId: this.options.derivedSourceId },
      );
    }
  }

  async #reconcileMarketSignals(
    sourceSlug: string,
    signals: MarketSignal[],
  ): Promise<void> {
    await this.assertDerivedWriteSource();
    const receipt = this.#stagedReceipts.get(sourceSlug);
    if (receipt === undefined) {
      throw integrityError(`matching staged success receipt required for ${sourceSlug}`);
    }
    try {
      if (
        receipt.signalIds.length !== signals.length
        || receipt.signalIds.some((signalId, index) => signalId !== signals[index]?.signalId)
      ) {
        throw integrityError('staged success receipt signalIds mismatch');
      }
      await this.engine.transaction(async tx => {
        await this.#reconcileInEngine(tx, sourceSlug, signals);
        await tx.putPage(
          `receipt/${receipt.sourceSlug}`,
          receiptPage(receipt),
          { sourceId: this.options.derivedSourceId },
        );
      });
    } finally {
      if (this.#stagedReceipts.get(sourceSlug) === receipt) {
        this.#stagedReceipts.delete(sourceSlug);
      }
    }
  }

  async readMarketSignals(input: ReadMarketSignalsInput): Promise<ReadMarketSignalsResult> {
    this.assertDerivedSourceId(input.sourceId);
    const states = input.states ?? ['ready'];
    for (const state of states) {
      if (!(MARKET_SIGNAL_STATES as readonly string[]).includes(state)) {
        throw new Error(`invalid market signal state: ${String(state)}`);
      }
    }
    const signals = (await listSignalPages(this.engine, input.sourceId))
      .map(page => {
        const signal = parseStoredSignal(page);
        reviewedState(signal, parseReviewMetadata(page), page.slug);
        return signal;
      })
      .filter(signal => matchesReadFilters(signal, input, states))
      .sort((left, right) => left.signalId.localeCompare(right.signalId))
      .slice(0, clampReadLimit(input.limit));
    return { signals };
  }

  async reviewMarketSignal(input: ReviewMarketSignalInput): Promise<MarketSignal> {
    this.assertDerivedSourceId(input.sourceId);
    await this.assertDerivedWriteSource();
    if (input.state !== 'ready' && input.state !== 'excluded') {
      throw new Error('review state must be ready or excluded');
    }
    if (typeof input.reviewer !== 'string' || input.reviewer.trim() === '') {
      throw new Error('reviewer must be non-empty');
    }
    if (input.note !== undefined && typeof input.note !== 'string') {
      throw new Error('review note must be a string');
    }

    return this.engine.transaction(async tx => {
      const slug = `market-signal/${input.signalId}`;
      const page = await tx.getPage(slug, { sourceId: input.sourceId });
      if (page === null) throw new Error(`market signal not found: ${input.signalId}`);
      const signal = parseStoredSignal(page);
      if (signal.state === 'superseded') {
        throw new Error('superseded market signals cannot be reviewed');
      }
      const review: ReviewMetadata = {
        state: input.state,
        reviewer: input.reviewer.trim(),
        reviewedAt: new Date().toISOString(),
        ...(input.note?.trim() === '' || input.note === undefined ? {} : { note: input.note.trim() }),
      };
      const updated = { ...signal, state: input.state };
      await tx.putPage(slug, signalPage(updated, review), { sourceId: input.sourceId });
      return updated;
    });
  }
}
