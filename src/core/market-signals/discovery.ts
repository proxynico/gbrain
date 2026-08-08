const CURRENCY_CODES = 'USD|EUR|GBP|CNY|HKD|JPY|SGD|AUD|CAD|NZD|AED|THB|VND|INR|KRW';

/** An explicit currency-and-amount pair, in either conventional order. */
export const MONETARY_RATE = new RegExp(
  `\\b(?:${CURRENCY_CODES})\\s*[\\d,]+(?:\\.\\d+)?\\b|\\b[\\d,]+(?:\\.\\d+)?\\s*(?:${CURRENCY_CODES})\\b`,
  'iu',
);

/** A candidate needs only a concrete amount and currency in the newest forwarded original. */
export function hasMonetaryRate(text: string): boolean {
  return MONETARY_RATE.test(text);
}

/** A supplied forwarder identifies one exact raw-page sender, never a heuristic match. */
export function matchesForwarder(sender: string | undefined, forwarder: string): boolean {
  return sender !== undefined && forwarder !== '' && sender === forwarder;
}
