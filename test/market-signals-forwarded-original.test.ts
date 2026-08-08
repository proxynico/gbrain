import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  buildEvidence,
  MAX_MARKET_SIGNAL_EVIDENCE_EXCERPT_CHARS,
} from '../src/core/market-signals/evidence.ts';
import { extractForwardedOriginal } from '../src/core/market-signals/forwarded-original.ts';

function forwardedMessage(wrapper: string, originalBody: string): string {
  return `${wrapper}

---------- Forwarded message ---------
From: carrier@example.test
Date: Tue, 4 Aug 2026 10:00:00 +0000
Subject: Rate update
To: forwarder@example.test

${originalBody}

From: older@example.test
Date: Mon, 3 Aug 2026 10:00:00 +0000
Subject: Older history

USD 9999 that must not be used`;
}

describe('forwarded market-signal originals', () => {
  test('excludes the forwarding wrapper from the newest original body', () => {
    const original = extractForwardedOriginal(
      forwardedMessage('FYI — worth watching', 'USD 4300 per 40HQ from Port Alpha to Port Beta.'),
    );

    expect(original).toMatchObject({ header: 'From: carrier@example.test' });
    expect(original?.body).toContain('USD 4300 per 40HQ');
    expect(original?.body).not.toContain('FYI — worth watching');
  });

  test('stops before nested older quoted history', () => {
    const original = extractForwardedOriginal(
      forwardedMessage('FYI', 'USD 4300 per 40HQ from Port Alpha to Port Beta.'),
    );

    expect(original?.body).not.toContain('older@example.test');
    expect(original?.body).not.toContain('USD 9999');
  });

  test('excludes ordinary quote-prefixed older history from the body and hash', () => {
    const originalBody = '\nDate: Tue, 4 Aug 2026 10:00:00 +0000\nSubject: Rate update\n\nUSD 4300 per 40HQ\n\n';
    const original = extractForwardedOriginal(
      `FYI\n\n---------- Forwarded message ---------\nFrom: carrier@example.test${originalBody}> From: older@example.test\n> Date: Mon, 3 Aug 2026 10:00:00 +0000\n> Subject: Older history\n>\n> USD 9999`,
    );

    expect(original?.body).toBe(originalBody);
    expect(original?.body).not.toContain('older@example.test');
    expect(original?.body).not.toContain('USD 9999');
    expect(buildEvidence(original!, 'USD 4300 per 40HQ').sha256).toBe(
      createHash('sha256').update(originalBody).digest('hex'),
    );
  });

  test('stops before header-less quoted history while preserving the current original', () => {
    const originalBody = '\nDate: Tue, 4 Aug 2026 10:00:00 +0000\nSubject: Current note\n\nPlease review this market note.\n\n';
    const original = extractForwardedOriginal(
      `FYI\n\n---------- Forwarded message ---------\nFrom: carrier@example.test${originalBody}> Spot offer: USD 9,999 per 40HQ from Port Alpha to Port Beta`,
    );

    expect(original?.body).toBe(originalBody);
    expect(original?.body).not.toContain('USD 9,999');
  });

  test('accepts an archive-normalized original that starts with its From header', () => {
    const original = extractForwardedOriginal(
      'From: carrier@example.test\nSubject: Rate update\n\nUSD 4300 per 40HQ',
    );

    expect(original).toMatchObject({ header: 'From: carrier@example.test' });
    expect(original?.body).toContain('USD 4300 per 40HQ');
  });

  test('accepts an archive-normalized original after wrapper text without a divider', () => {
    const original = extractForwardedOriginal(
      'FYI — worth watching\n\nFrom: carrier@example.test\nSubject: Rate update\n\nUSD 4300 per 40HQ',
    );

    expect(original).toMatchObject({ header: 'From: carrier@example.test' });
    expect(original?.body).toContain('USD 4300 per 40HQ');
    expect(original?.body).not.toContain('FYI — worth watching');
  });

  test('rejects an archive quote-prefixed From header when no divider exists', () => {
    expect(
      extractForwardedOriginal('FYI — worth watching\n\n> From: carrier@example.test\n> USD 4300 per 40HQ'),
    ).toBeUndefined();
  });

  test('preserves the extracted body byte-for-byte for evidence hashing', () => {
    const body = '\r\nDate: Tue, 4 Aug 2026 10:00:00 +0000\r\nSubject: Rate update\r\n\r\nUSD 4300 per 40HQ\r\n\r\n';
    const original = extractForwardedOriginal(
      `FYI\r\n\r\n---------- Forwarded message ---------\r\nFrom: carrier@example.test${body}From: older@example.test\r\n\r\nUSD 9999`,
    );

    expect(original?.body).toBe(body);
    expect(buildEvidence(original!, 'USD 4300 per 40HQ').sha256).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
  });

  test('hashes only the extracted original body and keeps the exact record excerpt', () => {
    const first = extractForwardedOriginal(
      forwardedMessage('FYI', 'USD 4300 per 40HQ from Port Alpha to Port Beta.'),
    );
    const changedWrapper = extractForwardedOriginal(
      forwardedMessage('Different wrapper text', 'USD 4300 per 40HQ from Port Alpha to Port Beta.'),
    );
    const changedOriginal = extractForwardedOriginal(
      forwardedMessage('FYI', 'USD 4500 per 40HQ from Port Alpha to Port Beta.'),
    );

    expect(first).toBeDefined();
    expect(changedWrapper).toBeDefined();
    expect(changedOriginal).toBeDefined();

    const excerpt = 'USD 4300 per 40HQ';
    const firstEvidence = buildEvidence(first!, excerpt);
    const wrapperEvidence = buildEvidence(changedWrapper!, excerpt);
    const changedOriginalEvidence = buildEvidence(changedOriginal!, 'USD 4500 per 40HQ');

    expect(firstEvidence.excerpt).toBe(excerpt);
    expect(wrapperEvidence.sha256).toBe(firstEvidence.sha256);
    expect(changedOriginalEvidence.sha256).not.toBe(firstEvidence.sha256);
  });

  test('rejects an excerpt longer than the record evidence bound', () => {
    const excerpt = 'x'.repeat(MAX_MARKET_SIGNAL_EVIDENCE_EXCERPT_CHARS + 1);
    const original = extractForwardedOriginal(forwardedMessage('FYI', excerpt));

    expect(() => buildEvidence(original!, excerpt)).toThrow(
      'market signal evidence excerpt exceeds the maximum length',
    );
  });
});
