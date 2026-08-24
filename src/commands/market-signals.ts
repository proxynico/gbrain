import type { BrainEngine } from '../core/engine.ts';
import {
  loadConfig,
  loadConfigWithEngine,
  resolveMarketSignalsConfig,
  type GBrainConfig,
} from '../core/config.ts';
import { inspectMarketRates } from '../core/market-signals/selection.ts';
import { BrainMarketSignalStore } from '../core/market-signals/store.ts';
import { isMarketRateId, type MarketRateId } from '../core/market-signals/types.ts';

const HELP = `gbrain market-signals — attended, evidence-backed market-rate selection

RAW_SOURCE is the read-only email corpus. DERIVED_SOURCE is the separate pure
database source that holds explicitly kept market-rate rows.

USAGE
  gbrain market-signals inspect --source RAW_SOURCE --forwarder EMAIL
                                --slug RAW_PAGE_SLUG
  gbrain market-signals keep --source RAW_SOURCE --derived DERIVED_SOURCE
                             --forwarder EMAIL --slug RAW_PAGE_SLUG
                             --row MARKET_RATE_ID [--row MARKET_RATE_ID ...]
  gbrain market-signals read --source DERIVED_SOURCE [--origin TEXT]
                             [--destination TEXT] [--equipment TEXT]
                             [--currency TEXT] [--carrier TEXT]
                             [--provider TEXT] [--limit N]

inspect returns disposable table-row suggestions and does not write. keep is an
attended local CLI action: it rebuilds the selected rows from the raw email and
writes only those rows to the configured derived source. read returns explicitly
kept rows from that derived source.
`;

type InspectArgs = {
  command: 'inspect';
  sourceId: string;
  sourceSlug: string;
  forwarder: string;
};

type KeepArgs = {
  command: 'keep';
  sourceId: string;
  derivedSourceId: string;
  sourceSlug: string;
  forwarder: string;
  signalIds: MarketRateId[];
};

type ReadArgs = {
  command: 'read';
  sourceId: string;
  origin?: string;
  destination?: string;
  equipment?: string;
  currency?: string;
  carrier?: string;
  provider?: string;
  limit?: number;
};

export type MarketSignalsArgs = InspectArgs | KeepArgs | ReadArgs;

export interface MarketSignalsCommandDependencies {
  config?: GBrainConfig;
  write?: (line: string) => void;
}

/** Reads the next CLI token for a value-bearing market-signals flag. */
function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim() === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value.trim();
}

/** Requires a parsed field before constructing a subcommand input. */
function requiredField(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} is required`);
  return value;
}

/** Rejects repeated single-use flags while parsing a subcommand. */
function once(seen: Set<string>, flag: string): void {
  if (seen.has(flag)) throw new Error(`duplicate ${flag}`);
  seen.add(flag);
}

/** Parses the bounded read-result limit accepted by the attended CLI. */
function parseLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('--limit must be an integer in 1..100');
  }
  return value;
}

/** Parses the raw-email inspection subcommand. */
function parseInspectArgs(args: string[]): InspectArgs {
  let sourceId: string | undefined;
  let sourceSlug: string | undefined;
  let forwarder: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--source' || flag === '--slug' || flag === '--forwarder') {
      once(seen, flag);
      const value = requiredValue(args, index, flag);
      if (flag === '--source') sourceId = value;
      if (flag === '--slug') sourceSlug = value;
      if (flag === '--forwarder') forwarder = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown market-signals inspect argument: ${flag}`);
  }

  return {
    command: 'inspect',
    sourceId: requiredField(sourceId, '--source'),
    sourceSlug: requiredField(sourceSlug, '--slug'),
    forwarder: requiredField(forwarder, '--forwarder'),
  };
}

/** Parses an attended keep request with one or more selected row IDs. */
function parseKeepArgs(args: string[]): KeepArgs {
  let sourceId: string | undefined;
  let derivedSourceId: string | undefined;
  let sourceSlug: string | undefined;
  let forwarder: string | undefined;
  const signalIds: MarketRateId[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--row') {
      const value = requiredValue(args, index, flag);
      if (!isMarketRateId(value)) {
        throw new Error(`invalid --row: ${value}`);
      }
      if (signalIds.includes(value)) {
        throw new Error(`duplicate --row: ${value}`);
      }
      signalIds.push(value);
      index += 1;
      continue;
    }
    if (flag === '--source' || flag === '--derived' || flag === '--slug' || flag === '--forwarder') {
      once(seen, flag);
      const value = requiredValue(args, index, flag);
      if (flag === '--source') sourceId = value;
      if (flag === '--derived') derivedSourceId = value;
      if (flag === '--slug') sourceSlug = value;
      if (flag === '--forwarder') forwarder = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown market-signals keep argument: ${flag}`);
  }
  if (signalIds.length === 0) throw new Error('--row is required');

  return {
    command: 'keep',
    sourceId: requiredField(sourceId, '--source'),
    derivedSourceId: requiredField(derivedSourceId, '--derived'),
    sourceSlug: requiredField(sourceSlug, '--slug'),
    forwarder: requiredField(forwarder, '--forwarder'),
    signalIds,
  };
}

/** Parses exact derived-rate filters for the local read subcommand. */
function parseReadArgs(args: string[]): ReadArgs {
  let sourceId: string | undefined;
  let origin: string | undefined;
  let destination: string | undefined;
  let equipment: string | undefined;
  let currency: string | undefined;
  let carrier: string | undefined;
  let provider: string | undefined;
  let limit: number | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--limit') {
      once(seen, flag);
      limit = parseLimit(requiredValue(args, index, flag));
      index += 1;
      continue;
    }
    const field = ({
      '--source': 'sourceId',
      '--origin': 'origin',
      '--destination': 'destination',
      '--equipment': 'equipment',
      '--currency': 'currency',
      '--carrier': 'carrier',
      '--provider': 'provider',
    } as const)[flag];
    if (field !== undefined) {
      once(seen, flag);
      const value = requiredValue(args, index, flag);
      if (field === 'sourceId') sourceId = value;
      if (field === 'origin') origin = value;
      if (field === 'destination') destination = value;
      if (field === 'equipment') equipment = value;
      if (field === 'currency') currency = value;
      if (field === 'carrier') carrier = value;
      if (field === 'provider') provider = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown market-signals read argument: ${flag}`);
  }

  return {
    command: 'read',
    sourceId: requiredField(sourceId, '--source'),
    ...(origin === undefined ? {} : { origin }),
    ...(destination === undefined ? {} : { destination }),
    ...(equipment === undefined ? {} : { equipment }),
    ...(currency === undefined ? {} : { currency }),
    ...(carrier === undefined ? {} : { carrier }),
    ...(provider === undefined ? {} : { provider }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Dispatches strict market-signals arguments to one supported subcommand. */
export function parseMarketSignalsArgs(args: string[]): MarketSignalsArgs {
  const command = args[0];
  if (command === 'inspect') return parseInspectArgs(args.slice(1));
  if (command === 'keep') return parseKeepArgs(args.slice(1));
  if (command === 'read') return parseReadArgs(args.slice(1));
  throw new Error(`unknown market-signals command: ${command ?? '(missing)'}`);
}

/** Enforces the configured raw or derived source boundary. */
function assertConfiguredSource(actual: string, expected: string, role: 'raw' | 'derived'): void {
  if (actual !== expected) {
    throw new Error(`market-signals ${role} source must match configured source '${expected}'`);
  }
}

/** Runs attended inspect, keep, and read workflows against the local engine. */
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
    deps.config
      ?? await loadConfigWithEngine(engine, loadConfig())
      ?? ({ engine: 'pglite' } satisfies GBrainConfig),
  );
  const write = deps.write ?? (line => process.stdout.write(line));

  if (parsed.command === 'inspect') {
    assertConfiguredSource(parsed.sourceId, config.raw_source_id, 'raw');
    const rates = await inspectMarketRates(engine, {
      sourceId: parsed.sourceId,
      sourceSlug: parsed.sourceSlug,
      forwarder: parsed.forwarder,
    });
    write(`${JSON.stringify(rates, null, 2)}\n`);
    return rates;
  }

  if (parsed.command === 'keep') {
    assertConfiguredSource(parsed.sourceId, config.raw_source_id, 'raw');
    assertConfiguredSource(parsed.derivedSourceId, config.derived_source_id, 'derived');
    const store = new BrainMarketSignalStore(engine, {
      rawSourceId: parsed.sourceId,
      derivedSourceId: parsed.derivedSourceId,
    });
    const rates = await store.keepMarketRates({
      sourceSlug: parsed.sourceSlug,
      forwarder: parsed.forwarder,
      signalIds: parsed.signalIds,
    });
    write(`${JSON.stringify(rates, null, 2)}\n`);
    return rates;
  }

  assertConfiguredSource(parsed.sourceId, config.derived_source_id, 'derived');
  const store = new BrainMarketSignalStore(engine, {
    rawSourceId: config.raw_source_id,
    derivedSourceId: parsed.sourceId,
  });
  const result = await store.readMarketRates({
    ...(parsed.origin === undefined ? {} : { origin: parsed.origin }),
    ...(parsed.destination === undefined ? {} : { destination: parsed.destination }),
    ...(parsed.equipment === undefined ? {} : { equipment: parsed.equipment }),
    ...(parsed.currency === undefined ? {} : { currency: parsed.currency }),
    ...(parsed.carrier === undefined ? {} : { carrier: parsed.carrier }),
    ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  });
  write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
