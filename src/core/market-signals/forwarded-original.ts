import type { ForwardedOriginal } from './types.ts';

const FORWARDED_MESSAGE_BOUNDARY = /^(?:-+\s*(?:forwarded|original) message\s*-+|begin forwarded message:)[ \t]*\r?$/imu;

function firstFromHeader(text: string): RegExpExecArray | null {
  return /^(?:>[ \t]*)?From:[^\r\n]+/gimu.exec(text);
}

function archiveNormalizedFromHeader(text: string): RegExpExecArray | null {
  return /^From:[^\r\n]*\b[^\s<>@]+@[^\s<>@]+\b[^\r\n]*/gimu.exec(text);
}

function firstQuotedHistoryLine(text: string): RegExpExecArray | null {
  return /^>[ \t]?/gimu.exec(text);
}

function firstForwardedMessageBoundary(text: string): RegExpExecArray | null {
  return FORWARDED_MESSAGE_BOUNDARY.exec(text);
}

/**
 * Isolates the newest original message from a forwarded email. The Outlook
 * archive can normalize away its forwarding divider while retaining the
 * forwarding wrapper. In that representation, the first unquoted `From:`
 * header with an email address is the original; quote-prefixed history is
 * never accepted as that fallback.
 */
export function extractForwardedOriginal(text: string): ForwardedOriginal | undefined {
  const normalizedHeader = archiveNormalizedFromHeader(text);
  const boundary = normalizedHeader === null ? firstForwardedMessageBoundary(text) : null;
  if (normalizedHeader === null && (boundary === null || boundary.index === undefined)) return undefined;

  const forwardedText = normalizedHeader === null
    ? text.slice(boundary!.index! + boundary![0].length)
    : text;
  const firstHeader = firstFromHeader(forwardedText);
  if (firstHeader === null || firstHeader.index === undefined) return undefined;

  const bodyStart = firstHeader.index + firstHeader[0].length;
  const bodyText = forwardedText.slice(bodyStart);
  const nextHeader = firstFromHeader(bodyText);
  const quotedHistory = firstQuotedHistoryLine(bodyText);
  const bodyEnd = Math.min(
    nextHeader?.index ?? bodyText.length,
    quotedHistory?.index ?? bodyText.length,
  );

  return {
    header: firstHeader[0],
    body: bodyText.slice(0, bodyEnd),
  };
}
