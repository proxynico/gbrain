import type { ExtractedMarketRateRow, ForwardedOriginal } from './types.ts';

const HEADER_LENGTH = 5;
const CURRENCY = '(USD|EUR|GBP|CNY|HKD|JPY|SGD|AUD|CAD|NZD|AED|THB|VND|INR|KRW)';
const AMOUNT_VALUE = '[\\d,]+(?:\\.\\d+)?';
const AMOUNT = `(${AMOUNT_VALUE})`;
const EQUIPMENT = '(20GP|20DV|40GP|40DV|40HC|40HQ|45HQ)';
const EQUIPMENT_VALUE = '(?:20GP|20DV|40GP|40DV|40HC|40HQ|45HQ)';
const DIRECT_PAIR_SOURCE = String.raw`${CURRENCY}\s*${AMOUNT}\s*\/\s*${EQUIPMENT}`;
const DIRECT_PAIR = new RegExp(DIRECT_PAIR_SOURCE, 'giu');
const DIRECT_RATE = new RegExp(String.raw`^\s*(?:${DIRECT_PAIR_SOURCE}\s*)+(?:\([^\r\n()]+\)\s*)?$`, 'iu');
const SHARED_RATE = new RegExp(
  String.raw`^\s*${CURRENCY}\s*(${AMOUNT_VALUE}(?:\s*\/\s*${AMOUNT_VALUE})+)\s+PER\s+(${EQUIPMENT_VALUE}(?:\s*\/\s*${EQUIPMENT_VALUE})+)\s*(?:\([^\r\n()]+\)\s*)?$`,
  'iu',
);
interface BodyLine {
  text: string;
  start: number;
  end: number;
}

/** Splits an original body into lines while retaining excerpt offsets. */
function bodyLines(body: string): BodyLine[] {
  const lines: BodyLine[] = [];
  let start = 0;

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\n' && body[index] !== '\r') continue;

    lines.push({ text: body.slice(start, index), start, end: index });
    if (body[index] === '\r' && body[index + 1] === '\n') index += 1;
    start = index + 1;
  }

  if (start < body.length) lines.push({ text: body.slice(start), start, end: body.length });
  return lines;
}

/** Reads the external provider from the isolated original's From header. */
function externalProvider(header: string): string {
  const provider = /^From:\s*(.+)$/iu.exec(header)?.[1]?.trim();
  if (!provider) throw new Error('recognized rate table lacks external provider');
  return provider;
}

/** Recognizes the exact five-line flattened rate-table header. */
function hasHeaders(lines: BodyLine[], index: number): boolean {
  return lines[index]?.text === 'POL'
    && lines[index + 1]?.text === 'POD'
    && (lines[index + 2]?.text === 'ETD' || lines[index + 2]?.text === 'ETD(validity)')
    && lines[index + 3]?.text === 'RATE'
    && lines[index + 4]?.text === 'SSL';
}

/** Treats whitespace-only flattened cells as empty. */
function isBlank(value: string): boolean {
  return value.trim() === '';
}

/** Parses direct or shared-currency equipment prices from one rate cell. */
function parseRateCell(rate: string): Array<{ amount: number; currency: string; equipment: string }> | undefined {
  if (DIRECT_RATE.test(rate)) {
    return [...rate.matchAll(DIRECT_PAIR)].map(([, currency, amount, equipment]) => ({
      amount: Number(amount.replaceAll(',', '')),
      currency: currency.toUpperCase(),
      equipment: equipment.toUpperCase(),
    }));
  }

  const shared = SHARED_RATE.exec(rate);
  if (shared === null) return undefined;

  const [, currency, amountList, equipmentList] = shared;
  const amounts = amountList.split('/').map(value => Number(value.trim().replaceAll(',', '')));
  const equipment = equipmentList.split('/').map(value => value.trim().toUpperCase());
  if (amounts.length !== equipment.length) return undefined;

  return amounts.map((amount, index) => ({
    amount,
    currency: currency.toUpperCase(),
    equipment: equipment[index]!,
  }));
}

/** Converts one five-cell table row into equipment-specific candidates. */
function parseRow(
  original: ForwardedOriginal,
  cells: BodyLine[],
  provider: string,
): ExtractedMarketRateRow[] | undefined {
  const [origin, destination, validity, rate, carrier] = cells;
  if (
    isBlank(origin.text)
    || isBlank(destination.text)
    || isBlank(rate.text)
    || isBlank(carrier.text)
  ) return undefined;

  const prices = parseRateCell(rate.text);
  if (prices === undefined) return undefined;

  const evidenceStart = cells.find(cell => !isBlank(cell.text))?.start;
  if (evidenceStart === undefined) return undefined;
  const evidenceExcerpt = original.body.slice(evidenceStart, carrier.end);

  return prices.map(({ amount, currency, equipment }) => ({
    amount,
    currency,
    origin: origin.text,
    destination: destination.text,
    equipment,
    ...(isBlank(validity.text) ? {} : { validity: validity.text }),
    carrier: carrier.text,
    provider,
    evidenceExcerpt,
  }));
}

/**
 * Extracts equipment-price pairs only from an exact flattened rate table.
 * It deliberately never scans wrapper text or prose for rates.
 */
export function extractMarketRateRows(original: ForwardedOriginal): ExtractedMarketRateRow[] {
  const lines = bodyLines(original.body);
  const rows: ExtractedMarketRateRow[] = [];
  for (let headerIndex = 0; headerIndex <= lines.length - HEADER_LENGTH; headerIndex += 1) {
    if (!hasHeaders(lines, headerIndex)) continue;
    const provider = externalProvider(original.header);
    for (let rowIndex = headerIndex + HEADER_LENGTH; rowIndex + HEADER_LENGTH <= lines.length; rowIndex += HEADER_LENGTH) {
      if (hasHeaders(lines, rowIndex)) break;
      const parsed = parseRow(original, lines.slice(rowIndex, rowIndex + HEADER_LENGTH), provider);
      if (parsed === undefined) break;
      rows.push(...parsed);
    }
  }
  return rows;
}
