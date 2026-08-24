/**
 * Manual market-rate read operation. Kept rows live in one configured,
 * non-federated derived source; raw email inspection and selection stay on
 * the attended local CLI.
 */

import { resolveMarketSignalsConfig } from '../config.ts';
import { BrainMarketSignalStore, type ReadMarketRatesInput } from '../market-signals/store.ts';
import { ALL_SOURCES } from '../source-id.ts';
import { OperationError, type Operation, type OperationContext } from './contract.ts';
import { sourceScopeOpts } from './context.ts';

const FILTER_FIELDS = [
  'origin',
  'destination',
  'equipment',
  'currency',
  'carrier',
  'provider',
] as const;
type MarketRateFilter = (typeof FILTER_FIELDS)[number];

/** Reads one optional exact-match rate filter and rejects blank values. */
function optionalMarketRateFilter(
  params: Record<string, unknown>,
  field: MarketRateFilter,
): string | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OperationError('invalid_params', `${field} must be a non-empty market rate filter`);
  }
  return value.trim();
}

/** Converts operation parameters into the store's bounded exact-filter input. */
export function parseReadMarketRatesInput(params: Record<string, unknown>): ReadMarketRatesInput {
  let limit: number | undefined;
  if (params.limit !== undefined) {
    if (typeof params.limit !== 'number' || !Number.isFinite(params.limit)) {
      throw new OperationError('invalid_params', 'limit must be a finite number');
    }
    limit = Math.max(1, Math.min(100, Math.floor(params.limit)));
  }

  const filters = Object.fromEntries(
    FILTER_FIELDS.flatMap(field => {
      const value = optionalMarketRateFilter(params, field);
      return value === undefined ? [] : [[field, value]];
    }),
  ) as Partial<Record<MarketRateFilter, string>>;

  return {
    ...filters,
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Requires a concrete source equal to the configured derived-rate source. */
function requireExpectedMarketSignalSource(
  sourceId: string | undefined,
  expectedSourceId: string,
): string {
  if (!sourceId || sourceId === ALL_SOURCES) {
    throw new OperationError(
      'permission_denied',
      'Market rate rows require exactly one granted source.',
    );
  }
  if (sourceId !== expectedSourceId) {
    throw new OperationError(
      'permission_denied',
      `Market rate rows require the configured derived source '${expectedSourceId}'.`,
    );
  }
  return sourceId;
}

/** Resolves the caller's read grant and rejects multi-source federation. */
function requireSingleMarketSignalReadSource(
  ctx: OperationContext,
  expectedSourceId: string,
): string {
  const scope = sourceScopeOpts(ctx);
  if (scope.sourceIds !== undefined) {
    if (scope.sourceIds.length !== 1) {
      throw new OperationError(
        'permission_denied',
        'Market rate rows require exactly one granted source; federated reads are not allowed.',
      );
    }
    return requireExpectedMarketSignalSource(scope.sourceIds[0], expectedSourceId);
  }
  return requireExpectedMarketSignalSource(scope.sourceId, expectedSourceId);
}

const readMarketSignals: Operation = {
  name: 'read_market_signals',
  description:
    'Read explicitly kept market-rate rows from exactly one granted configured derived source ' +
    'without model calls. Supports exact origin, destination, equipment, currency, carrier, ' +
    'and provider filters.',
  scope: 'read',
  params: {
    origin: { type: 'string', required: false },
    destination: { type: 'string', required: false },
    equipment: { type: 'string', required: false },
    currency: { type: 'string', required: false },
    carrier: { type: 'string', required: false },
    provider: { type: 'string', required: false },
    limit: { type: 'number', required: false },
  },
  handler: async (ctx, params) => {
    const config = resolveMarketSignalsConfig(ctx.config);
    const sourceId = requireSingleMarketSignalReadSource(ctx, config.derived_source_id);
    const store = new BrainMarketSignalStore(ctx.engine, {
      rawSourceId: config.raw_source_id,
      derivedSourceId: sourceId,
    });
    return store.readMarketRates(parseReadMarketRatesInput(params));
  },
};

export const marketSignalsOperations: Operation[] = [readMarketSignals];
