import { hasMonetaryRate } from './discovery.ts';
import type { ForwardedOriginal, MarketSignalType } from './types.ts';
import { validateParsedMarketSignal, type ParsedMarketSignal } from './validation.ts';

const CURRENCY_CODES = 'USD|EUR|GBP|CNY|HKD|JPY|SGD|AUD|CAD|NZD|AED|THB|VND|INR|KRW';
const CURRENCY_FIRST = new RegExp(
  `\\b(${CURRENCY_CODES})\\s*([\\d,]+(?:\\.\\d+)?)\\b`,
  'iu',
);
const AMOUNT_FIRST = new RegExp(
  `\\b([\\d,]+(?:\\.\\d+)?)\\s*(${CURRENCY_CODES})\\b`,
  'iu',
);
const EQUIPMENT = /(?<![A-Z0-9])(?:20GP|20DV|40GP|40DV|40HC|40HQ|45HQ)(?![A-Z0-9])/iu;

function amountAndCurrency(text: string): {
  amount: number;
  currency: string;
  matchEnd: number;
} | undefined {
  const currencyFirst = CURRENCY_FIRST.exec(text);
  if (currencyFirst?.index !== undefined) {
    return {
      amount: Number(currencyFirst[2]!.replaceAll(',', '')),
      currency: currencyFirst[1]!.toUpperCase(),
      matchEnd: currencyFirst.index + currencyFirst[0].length,
    };
  }
  const amountFirst = AMOUNT_FIRST.exec(text);
  if (amountFirst?.index === undefined) return undefined;
  return {
    amount: Number(amountFirst[1]!.replaceAll(',', '')),
    currency: amountFirst[2]!.toUpperCase(),
    matchEnd: amountFirst.index + amountFirst[0].length,
  };
}

function signalType(text: string): MarketSignalType | undefined {
  if (/\b(?:capacity offer|capacity available|space available|available capacity|open space)\b/iu.test(text)) {
    return 'capacity_offer';
  }
  if (/\b(?:rate circular|tariff circular|rate announcement)\b/iu.test(text)) {
    return 'rate_circular';
  }
  if (/\b(?:market update|market report|market outlook|market intelligence)\b/iu.test(text)) {
    return 'market_update';
  }
  if (/\b(?:spot offer|spot rate|spot freight)\b/iu.test(text)) {
    return 'spot_offer';
  }
  return undefined;
}

function amountUnit(text: string, rateEnd: number): string | undefined {
  const match = /^\s*(?:\/|per\s+)([A-Za-z0-9]+)\b/iu.exec(text.slice(rateEnd));
  return match?.[1]?.toUpperCase();
}

function lane(text: string): { origin: string; destination: string } | undefined {
  const fromTo = /\bfrom\s+([A-Za-z][A-Za-z0-9 .'/-]*?)\s+to\s+([A-Za-z][A-Za-z0-9 .'/-]*?)(?=\s+(?:valid|at|for|per)\b|[,;.\n]|$)/iu.exec(text);
  if (fromTo?.[1] !== undefined && fromTo[2] !== undefined) {
    return { origin: fromTo[1].trim(), destination: fromTo[2].trim() };
  }
  const polPod = /\bPOL\s*:\s*([^,;\n]+?)\s*[,;]\s*POD\s*:\s*([^,;\n.]+)/iu.exec(text);
  if (polPod?.[1] !== undefined && polPod[2] !== undefined) {
    return { origin: polPod[1].trim(), destination: polPod[2].trim() };
  }
  return undefined;
}

function validity(text: string): string | undefined {
  const match = /\bvalid(?:ity)?\s+(?:(?:until|to|through)\s+)?([0-9][^,;.\n]*)/iu.exec(text);
  return match?.[0]?.trim();
}

function provider(header: string): string | undefined {
  const match = /^From:\s*(.+)$/iu.exec(header);
  const value = match?.[1]?.trim();
  return value === '' || value === undefined ? undefined : value;
}

function capacity(text: string): string | undefined {
  const named = /\b(?:capacity|space)\s*(?:of|:)?\s*([\d,]+(?:\.\d+)?\s*(?:TEU|FEU|slots?|containers?))\b/iu.exec(text);
  if (named?.[1] !== undefined) return named[1].trim();
  const available = /\b([\d,]+(?:\.\d+)?\s*(?:TEU|FEU|slots?|containers?))\s+(?:available|open)\b/iu.exec(text);
  return available?.[1]?.trim();
}

/**
 * Extracts only literal facts from the isolated newest original. It does not
 * infer a lane, equipment, validity, provider, or capacity from context.
 */
export function parseMarketSignal(original: ForwardedOriginal): ParsedMarketSignal {
  if (!hasMonetaryRate(original.body)) {
    return { decision: 'no_rate', missing: [] };
  }

  const rate = amountAndCurrency(original.body);
  if (rate === undefined || !Number.isFinite(rate.amount) || rate.amount <= 0) {
    return { decision: 'no_rate', missing: [] };
  }

  const equipment = EQUIPMENT.exec(original.body)?.[0]?.toUpperCase();
  return validateParsedMarketSignal({
    signalType: signalType(original.body),
    amount: rate.amount,
    currency: rate.currency,
    amountUnit: amountUnit(original.body, rate.matchEnd),
    lane: lane(original.body),
    ...(equipment === undefined ? {} : { equipment }),
    validity: validity(original.body),
    provider: provider(original.header),
    capacity: capacity(original.body),
  });
}
