import type { BrainEngine } from '../core/engine.ts';
import {
  loadConfig,
  resolveMarketSignalsConfig,
  type GBrainConfig,
} from '../core/config.ts';
import { collectMarketSignalCandidates } from '../core/market-signals/agent-pass.ts';
import { validateMarketSignalDateWindow } from '../core/market-signals/enumerate.ts';
import {
  BrainMarketSignalStore,
  type MarketSignalIntakeReference,
} from '../core/market-signals/store.ts';
import {
  MARKET_SIGNAL_STATES,
  MARKET_SIGNAL_TYPES,
  type MarketSignalState,
  type MarketSignalType,
} from '../core/market-signals/types.ts';

const HELP = `gbrain market-signals — manual, evidence-backed market-signal feed

This command never polls, schedules, syncs, or scans email automatically.
RAW_SOURCE is the read-only email corpus. DERIVED_SOURCE is the separate pure
database source that holds reviewed market-signal records.

USAGE
  gbrain market-signals read --source DERIVED_SOURCE [--state STATE]
                              [--origin TEXT] [--destination TEXT]
                              [--equipment TEXT] [--currency TEXT]
                              [--signal-type TYPE] [--limit N]
  gbrain market-signals review SIGNAL_ID --ready|--exclude --reviewer TEXT
                              [--note TEXT] --source DERIVED_SOURCE
  gbrain market-signals census --source RAW_SOURCE --forwarder EMAIL
                              [--since YYYY-MM-DD --until YYYY-MM-DD]
                              [--sample N] [--json]
  gbrain market-signals candidates --source RAW_SOURCE --forwarder EMAIL
                              --since YYYY-MM-DD --until YYYY-MM-DD
                              [--limit N --max-body N]
  gbrain market-signals ingest --from FILE --source RAW_SOURCE
                              --derived DERIVED_SOURCE

census and candidates are read-only. candidates isolate the newest forwarded
original and require the exact --forwarder address. ingest accepts only a local
JSON array of raw-page references shaped as {"sourceSlug":"...","forwarder":"..."}.
It reloads and re-assesses those raw pages before writing through the derived-
record safety checks; run it only after explicit human review.
`;

interface ReadArgs {
  command: 'read';
  sourceId: string;
  state?: MarketSignalState;
  origin?: string;
  destination?: string;
  equipment?: string;
  currency?: string;
  signalType?: MarketSignalType;
  limit?: number;
}

interface ReviewArgs {
  command: 'review';
  sourceId: string;
  signalId: string;
  state: 'ready' | 'excluded';
  reviewer: string;
  note?: string;
}

interface CensusArgs {
  command: 'census';
  sourceId: string;
  forwarder: string;
  since?: string;
  until?: string;
  sampleLimit?: number;
  json: boolean;
}

interface CandidatesArgs {
  command: 'candidates';
  sourceId: string;
  forwarder: string;
  since: string;
  until: string;
  limit?: number;
  maxBodyChars?: number;
}

interface IngestArgs {
  command: 'ingest';
  sourceId: string;
  derivedSourceId: string;
  from: string;
}

export type MarketSignalsArgs =
  | ReadArgs
  | ReviewArgs
  | CensusArgs
  | CandidatesArgs
  | IngestArgs;

export interface MarketSignalsCommandDependencies {
  config?: GBrainConfig;
  write?: (line: string) => void;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim() === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requiredSource(sourceId: string | undefined): string {
  if (!sourceId) throw new Error('--source is required');
  return sourceId;
}

function requiredForwarder(forwarder: string | undefined, command: 'census' | 'candidates'): string {
  if (!forwarder?.trim()) {
    throw new Error(`--forwarder is required for market-signals ${command}`);
  }
  return forwarder.trim();
}

function parseLimit(raw: string, flag: '--limit' | '--max-body' | '--sample', maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${flag} must be an integer in 1..${maximum}`);
  }
  return value;
}

function parseReadArgs(args: string[]): ReadArgs {
  let sourceId: string | undefined;
  let state: MarketSignalState | undefined;
  let origin: string | undefined;
  let destination: string | undefined;
  let equipment: string | undefined;
  let currency: string | undefined;
  let signalType: MarketSignalType | undefined;
  let limit: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--source') {
      sourceId = requiredValue(args, index, flag);
      index += 1;
      continue;
    }
    if (flag === '--state') {
      const value = requiredValue(args, index, flag);
      if (!(MARKET_SIGNAL_STATES as readonly string[]).includes(value)) {
        throw new Error(`invalid market signal state: ${value}`);
      }
      state = value as MarketSignalState;
      index += 1;
      continue;
    }
    if (flag === '--signal-type') {
      const value = requiredValue(args, index, flag);
      if (!(MARKET_SIGNAL_TYPES as readonly string[]).includes(value)) {
        throw new Error(`invalid market signal type: ${value}`);
      }
      signalType = value as MarketSignalType;
      index += 1;
      continue;
    }
    if (flag === '--limit') {
      limit = parseLimit(requiredValue(args, index, flag), flag, 100);
      index += 1;
      continue;
    }
    const field = ({
      '--origin': 'origin',
      '--destination': 'destination',
      '--equipment': 'equipment',
      '--currency': 'currency',
    } as const)[flag];
    if (field !== undefined) {
      const value = requiredValue(args, index, flag);
      if (field === 'origin') origin = value;
      if (field === 'destination') destination = value;
      if (field === 'equipment') equipment = value;
      if (field === 'currency') currency = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown market-signals read argument: ${flag}`);
  }

  return {
    command: 'read',
    sourceId: requiredSource(sourceId),
    ...(state === undefined ? {} : { state }),
    ...(origin === undefined ? {} : { origin }),
    ...(destination === undefined ? {} : { destination }),
    ...(equipment === undefined ? {} : { equipment }),
    ...(currency === undefined ? {} : { currency }),
    ...(signalType === undefined ? {} : { signalType }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parseReviewArgs(args: string[]): ReviewArgs {
  const signalId = args[0];
  if (!signalId || signalId.startsWith('--')) {
    throw new Error('market-signals review requires a signal id');
  }
  let sourceId: string | undefined;
  let reviewer: string | undefined;
  let note: string | undefined;
  let ready = false;
  let exclude = false;

  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--ready') {
      ready = true;
      continue;
    }
    if (flag === '--exclude') {
      exclude = true;
      continue;
    }
    if (flag === '--source' || flag === '--reviewer' || flag === '--note') {
      const value = requiredValue(args, index, flag);
      if (flag === '--source') sourceId = value;
      if (flag === '--reviewer') reviewer = value;
      if (flag === '--note') note = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown market-signals review argument: ${flag}`);
  }

  if (ready === exclude) {
    throw new Error('pass exactly one of --ready or --exclude');
  }
  if (!reviewer?.trim()) throw new Error('--reviewer is required');
  return {
    command: 'review',
    sourceId: requiredSource(sourceId),
    signalId,
    state: ready ? 'ready' : 'excluded',
    reviewer: reviewer.trim(),
    ...(note === undefined ? {} : { note }),
  };
}

function validateOptionalDateWindow(since: string | undefined, until: string | undefined): void {
  if (since === undefined && until === undefined) return;
  validateMarketSignalDateWindow(since, until);
}

function parseCensusArgs(args: string[]): CensusArgs {
  let sourceId: string | undefined;
  let forwarder: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let sampleLimit: number | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--sample') {
      sampleLimit = parseLimit(requiredValue(args, index, flag), flag, 25);
      index += 1;
      continue;
    }
    if (flag === '--source' || flag === '--forwarder' || flag === '--since' || flag === '--until') {
      const value = requiredValue(args, index, flag);
      if (flag === '--source') sourceId = value;
      if (flag === '--forwarder') forwarder = value;
      if (flag === '--since') since = value;
      if (flag === '--until') until = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown market-signals census argument: ${flag}`);
  }

  validateOptionalDateWindow(since, until);
  return {
    command: 'census',
    sourceId: requiredSource(sourceId),
    forwarder: requiredForwarder(forwarder, 'census'),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(sampleLimit === undefined ? {} : { sampleLimit }),
    json,
  };
}

function parseCandidatesArgs(args: string[]): CandidatesArgs {
  let sourceId: string | undefined;
  let forwarder: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let limit: number | undefined;
  let maxBodyChars: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--limit' || flag === '--max-body') {
      const maximum = flag === '--limit' ? 25 : 20_000;
      const value = parseLimit(requiredValue(args, index, flag), flag, maximum);
      if (flag === '--limit') limit = value;
      else maxBodyChars = value;
      index += 1;
      continue;
    }
    if (flag === '--source' || flag === '--forwarder' || flag === '--since' || flag === '--until') {
      const value = requiredValue(args, index, flag);
      if (flag === '--source') sourceId = value;
      if (flag === '--forwarder') forwarder = value;
      if (flag === '--since') since = value;
      if (flag === '--until') until = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown market-signals candidates argument: ${flag}`);
  }

  const requiredForwarderValue = requiredForwarder(forwarder, 'candidates');
  const interval = validateMarketSignalDateWindow(since, until);
  return {
    command: 'candidates',
    sourceId: requiredSource(sourceId),
    forwarder: requiredForwarderValue,
    ...interval,
    ...(limit === undefined ? {} : { limit }),
    ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
  };
}

function parseIngestArgs(args: string[]): IngestArgs {
  let sourceId: string | undefined;
  let derivedSourceId: string | undefined;
  let from: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--source' || flag === '--derived' || flag === '--from') {
      const value = requiredValue(args, index, flag);
      if (flag === '--source') sourceId = value;
      if (flag === '--derived') derivedSourceId = value;
      if (flag === '--from') from = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown market-signals ingest argument: ${flag}`);
  }

  if (!from) throw new Error('--from is required');
  if (!derivedSourceId) throw new Error('--derived is required');
  return {
    command: 'ingest',
    sourceId: requiredSource(sourceId),
    derivedSourceId,
    from,
  };
}

export function parseMarketSignalsArgs(args: string[]): MarketSignalsArgs {
  const command = args[0];
  if (command === 'read') return parseReadArgs(args.slice(1));
  if (command === 'review') return parseReviewArgs(args.slice(1));
  if (command === 'census') return parseCensusArgs(args.slice(1));
  if (command === 'candidates') return parseCandidatesArgs(args.slice(1));
  if (command === 'ingest') return parseIngestArgs(args.slice(1));
  throw new Error(`unknown market-signals command: ${command ?? '(missing)'}`);
}

function assertConfiguredSource(actual: string, expected: string, role: 'raw' | 'derived'): void {
  if (actual !== expected) {
    throw new Error(
      `market-signals ${role} source must match configured source '${expected}'`,
    );
  }
}

export function parseMarketSignalIntake(value: unknown): MarketSignalIntakeReference[] {
  if (!Array.isArray(value)) throw new Error('market-signals intake must be an array');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`intake[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const allowed = new Set(['sourceSlug', 'forwarder']);
    for (const field of Object.keys(record)) {
      if (!allowed.has(field)) {
        throw new Error(`intake[${index}] contains unsupported field '${field}'`);
      }
    }
    if (typeof record.sourceSlug !== 'string' || record.sourceSlug.trim() === '') {
      throw new Error(`intake[${index}].sourceSlug must be a non-empty string`);
    }
    if (typeof record.forwarder !== 'string' || record.forwarder.trim() === '') {
      throw new Error(`intake[${index}].forwarder must be a non-empty string`);
    }
    return {
      sourceSlug: record.sourceSlug.trim(),
      forwarder: record.forwarder.trim(),
    };
  });
}

interface CensusRow {
  pages: number | string;
}

interface CensusSampleRow {
  slug: string;
  title: string;
  effective_date: Date | string | null;
}

async function censusMarketSignals(
  engine: BrainEngine,
  args: CensusArgs,
): Promise<{
  sourceId: string;
  forwarder: string;
  pages: number;
  samples: CensusSampleRow[];
  since?: string;
  until?: string;
}> {
  const params: unknown[] = [args.sourceId, args.forwarder];
  let dateFilter = '';
  if (args.since !== undefined && args.until !== undefined) {
    params.push(`${args.since}T00:00:00.000Z`, `${args.until}T00:00:00.000Z`);
    dateFilter = ' AND effective_date >= $3::timestamptz AND effective_date < $4::timestamptz';
  }
  const sourceFilter = `source_id = $1
        AND deleted_at IS NULL
        AND source_path IS NOT NULL
        AND frontmatter->>'from_address' = $2${dateFilter}`;
  const samples = await engine.withReservedConnection(async conn => {
    const rows = await conn.executeRaw<CensusRow>(
      `SELECT COUNT(*) AS pages FROM pages WHERE ${sourceFilter}`,
      params,
    );
    if (args.sampleLimit === undefined) {
      return { pages: Number(rows[0]?.pages ?? 0), samples: [] as CensusSampleRow[] };
    }
    const sampleRows = await conn.executeRaw<CensusSampleRow>(
      `SELECT slug, title, effective_date FROM pages WHERE ${sourceFilter}
       ORDER BY effective_date DESC, slug
       LIMIT $${params.length + 1}`,
      [...params, args.sampleLimit],
    );
    return { pages: Number(rows[0]?.pages ?? 0), samples: sampleRows };
  });
  return {
    sourceId: args.sourceId,
    forwarder: args.forwarder,
    pages: samples.pages,
    samples: samples.samples,
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.until === undefined ? {} : { until: args.until }),
  };
}

export async function runMarketSignals(
  engine: BrainEngine,
  args: string[],
  deps: MarketSignalsCommandDependencies = {},
): Promise<unknown> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    (deps.write ?? (line => process.stdout.write(line)))(HELP);
    return;
  }

  const parsed = parseMarketSignalsArgs(args);
  const config = resolveMarketSignalsConfig(
    deps.config ?? loadConfig() ?? ({ engine: 'pglite' } satisfies GBrainConfig),
  );
  const write = deps.write ?? (line => process.stdout.write(line));

  if (parsed.command === 'census') {
    assertConfiguredSource(parsed.sourceId, config.raw_source_id, 'raw');
    const result = await censusMarketSignals(engine, parsed);
    write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (parsed.command === 'candidates') {
    assertConfiguredSource(parsed.sourceId, config.raw_source_id, 'raw');
    const result = await collectMarketSignalCandidates(engine, {
      sourceId: parsed.sourceId,
      forwarder: parsed.forwarder,
      since: parsed.since,
      until: parsed.until,
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.maxBodyChars === undefined ? {} : { maxBodyChars: parsed.maxBodyChars }),
    });
    write(`${JSON.stringify({ count: result.length, candidates: result }, null, 2)}\n`);
    return result;
  }

  if (parsed.command === 'ingest') {
    assertConfiguredSource(parsed.sourceId, config.raw_source_id, 'raw');
    assertConfiguredSource(parsed.derivedSourceId, config.derived_source_id, 'derived');
    const records = parseMarketSignalIntake(JSON.parse(await Bun.file(parsed.from).text()) as unknown);
    const store = new BrainMarketSignalStore(engine, {
      rawSourceId: parsed.sourceId,
      derivedSourceId: parsed.derivedSourceId,
    });
    const signals = [];
    for (const record of records) {
      const signal = await store.persistDecision(record);
      if (signal !== undefined) signals.push(signal);
    }
    const result = { processed: records.length, signals };
    write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  assertConfiguredSource(parsed.sourceId, config.derived_source_id, 'derived');
  const store = new BrainMarketSignalStore(engine, {
    rawSourceId: config.raw_source_id,
    derivedSourceId: parsed.sourceId,
  });
  const result = parsed.command === 'read'
    ? await store.readMarketSignals({
      sourceId: parsed.sourceId,
      ...(parsed.state === undefined ? {} : { states: [parsed.state] }),
      ...(parsed.origin === undefined ? {} : { origin: parsed.origin }),
      ...(parsed.destination === undefined ? {} : { destination: parsed.destination }),
      ...(parsed.equipment === undefined ? {} : { equipment: parsed.equipment }),
      ...(parsed.currency === undefined ? {} : { currency: parsed.currency }),
      ...(parsed.signalType === undefined ? {} : { signalType: parsed.signalType }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    })
    : await store.reviewMarketSignal({
      sourceId: parsed.sourceId,
      signalId: parsed.signalId,
      state: parsed.state,
      reviewer: parsed.reviewer,
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
    });
  write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
