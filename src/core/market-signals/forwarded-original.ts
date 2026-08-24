import type { ForwardedOriginal } from './types.ts';

const FORWARDED_MESSAGE_BOUNDARY = /^(?:-+\s*(?:forwarded|original) message\s*-+|begin forwarded message:)[ \t]*\r?$/imu;
const FROM_HEADER = /^(?:>[ \t]*)?From:[^\r\n]+/imu;
const ARCHIVE_NORMALIZED_FROM_HEADER = /^From:[^\r\n]*\b[^\s<>@]+@[^\s<>@]+\b[^\r\n]*/imu;
const QUOTED_HISTORY_LINE = /^>[ \t]?/imu;

/**
 * Isolates the newest original message from a forwarded email. The Outlook
 * archive can normalize away its forwarding divider while retaining the
 * forwarding wrapper. In that representation, the first unquoted `From:`
 * header with an email address is the original; quote-prefixed history is
 * never accepted as that fallback.
 */
export function extractForwardedOriginal(text: string): ForwardedOriginal | undefined {
  const normalizedHeader = ARCHIVE_NORMALIZED_FROM_HEADER.exec(text);
  const boundary = normalizedHeader === null ? FORWARDED_MESSAGE_BOUNDARY.exec(text) : null;
  if (normalizedHeader === null && (boundary === null || boundary.index === undefined)) return undefined;

  const forwardedText = normalizedHeader === null
    ? text.slice(boundary!.index! + boundary![0].length)
    : text;
  const firstHeader = FROM_HEADER.exec(forwardedText);
  if (firstHeader === null || firstHeader.index === undefined) return undefined;

  const bodyStart = firstHeader.index + firstHeader[0].length;
  const bodyText = forwardedText.slice(bodyStart);
  const nextHeader = FROM_HEADER.exec(bodyText);
  const quotedHistory = QUOTED_HISTORY_LINE.exec(bodyText);
  const bodyEnd = Math.min(
    nextHeader?.index ?? bodyText.length,
    quotedHistory?.index ?? bodyText.length,
  );

  return {
    header: firstHeader[0],
    body: bodyText.slice(0, bodyEnd),
  };
}
