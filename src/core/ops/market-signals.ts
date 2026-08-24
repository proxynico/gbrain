/**
 * Manual market-rate read operation. Kept rows live in one configured,
 * non-federated derived source; raw email inspection and selection stay on
 * the attended local CLI.
 */

import { loadConfigWithEngine, resolveMarketSignalsConfig } from '../config.ts';
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
  requestedSourceId: unknown,
): string {
  const scope = sourceScopeOpts(ctx);
  let requested: string | undefined;
  if (requestedSourceId !== undefined) {
    if (typeof requestedSourceId !== 'string' || requestedSourceId.trim() === '') {
      throw new OperationError('invalid_params', 'source_id must be a non-empty string');
    }
    requested = requireExpectedMarketSignalSource(requestedSourceId.trim(), expectedSourceId);
  }
  if (scope.sourceIds !== undefined) {
    if (requested !== undefined) {
      if (!scope.sourceIds.includes(requested)) {
        throw new OperationError(
          'permission_denied',
          `Market rate source '${requested}' is outside the caller's granted sources.`,
        );
      }
      return requested;
    }
    if (scope.sourceIds.length !== 1) {
      throw new OperationError(
        'permission_denied',
        'Market rate rows require exactly one granted source; federated reads are not allowed.',
      );
    }
    return requireExpectedMarketSignalSource(scope.sourceIds[0], expectedSourceId);
  }
  if (requested !== undefined) {
    if (scope.sourceId !== undefined) {
      requireExpectedMarketSignalSource(scope.sourceId, expectedSourceId);
    } else if (ctx.remote !== false) {
      throw new OperationError(
        'permission_denied',
        'Market rate rows require an explicit granted source.',
      );
    }
    return requested;
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
    origin: { type: 'string', required: false, description: 'Exact origin name.' },
    destination: { type: 'string', required: false, description: 'Exact destination name.' },
    equipment: { type: 'string', required: false, description: 'Exact equipment code.' },
    currency: { type: 'string', required: false, description: 'Exact currency code.' },
    carrier: { type: 'string', required: false, description: 'Exact carrier name.' },
    provider: { type: 'string', required: false, description: 'Exact provider identity.' },
    limit: { type: 'number', required: false, description: 'Maximum rows to return, from 1 to 100.' },
    source_id: {
      type: 'string',
      required: false,
      description: 'Select the configured derived source from a multi-source caller grant.',
    },
  },
  handler: async (ctx, params) => {
    const config = resolveMarketSignalsConfig(
      await loadConfigWithEngine(ctx.engine, ctx.config) ?? ctx.config,
    );
    const sourceId = requireSingleMarketSignalReadSource(
      ctx,
      config.derived_source_id,
      params.source_id,
    );
    const store = new BrainMarketSignalStore(ctx.engine, {
      rawSourceId: config.raw_source_id,
      derivedSourceId: sourceId,
    });
    return store.readMarketRates(parseReadMarketRatesInput(params));
  },
};

export const marketSignalsOperations: Operation[] = [readMarketSignals];
