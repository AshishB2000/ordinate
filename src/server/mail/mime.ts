// One email as bytes — PURE (docs/email/00-design.md §6–7). The message is
// multipart/alternative: a text part and an HTML part, both base64, under
// headers built here from values that were checked here.
//
// The input walls, before any socket opens (a failure is MailError 'input'):
//   headers    a CR, LF or NUL in any header value throws — the subject has
//              already passed `clean` upstream; this is the second wall
//   addresses  the strict pattern (./mailEnv.isMailAddress)
//   DATA       no bare CR or LF anywhere and no line over 998 octets (the
//              SMTP-smuggling family), THEN dot-stuffing. Base64 bodies make it
//              true by construction; the check makes it enforced.

import { randomBytes, randomUUID } from 'crypto';
import { isMailAddress } from './mailEnv';

/** Why a send stopped. `afterDot`: the final `.` had been written, so a retry could deliver twice. */
export type MailErrorKind = 'unreachable' | 'timeout' | 'tls' | 'auth' | 'rejected' | 'temporary' | 'protocol' | 'input' | 'refused';
export class MailError extends Error {
  constructor(
    readonly kind: MailErrorKind,
    /** For the LOG only: the relay's reply or the check that failed, already scrubbed of the password. */
    readonly detail: string,
    readonly code = 0,
    readonly afterDot = false,
  ) {
    super(`smtp ${kind}${code ? ' ' + code : ''}`);
    this.name = 'MailError';
  }
}

export function assertHeaderSafe(name: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw new MailError('input', `a line break or NUL in the ${name} header`);
  return value;
}

export function assertAddress(a: string): string {
  if (!isMailAddress(a)) throw new MailError('input', 'an address that is not a plain mailbox');
  return a;
}

/**
 * RFC 2047 B-encoded words of at most 30 UTF-8 bytes each (52 characters),
 * split on code points and folded, so no line passes 76 characters.
 */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 30) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk || !words.length) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** A header's text: as typed when it is short printable ASCII with no `=?` (which a reader would decode), else encoded. */
export function headerText(name: string, text: string, room = 76 - name.length - 2): string {
  assertHeaderSafe(name, text);
  return /^[\x20-\x7e]*$/.test(text) && !text.includes('=?') && text.length <= room ? text : encodeWords(text);
}

/** `"Name" <addr>`, `=?…?= <addr>` or `<addr>`. The name was checked at startup (no quote, backslash or bracket). */
export function mailbox(address: string, name: string | null): string {
  assertAddress(address);
  if (!name) return `<${address}>`;
  return /^[\x20-\x7e]*$/.test(assertHeaderSafe('From', name)) && name.length <= 60 ? `"${name}" <${address}>` : `${encodeWords(name)}\r\n <${address}>`;
}

/** RFC 5322 date-time in UTC: `Tue, 20 Oct 2026 08:00:00 +0000`. */
export function mailDate(d: Date): string {
  return d.toUTCString().replace(/ GMT$/, ' +0000');
}

const base64Lines = (s: string): string => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');

export interface Composed {
  from: { address: string; name: string | null };
  subject: string;
  text: string;
  html: string;
  /** For tests: a fixed clock and id. */
  date?: Date;
  messageId?: string;
}

/** The whole message, CRLF throughout, ready for DATA (not yet dot-stuffed). */
export function buildMime(m: Composed): string {
  const domain = m.from.address.slice(m.from.address.lastIndexOf('@') + 1);
  const boundary = `=_ord_${randomBytes(12).toString('hex')}`; // '=' and '_' never occur in a base64 line
  const lines = [
    `From: ${mailbox(m.from.address, m.from.name)}`,
    'To: undisclosed-recipients:;',
    `Subject: ${headerText('Subject', m.subject)}`,
    `Date: ${mailDate(m.date ?? new Date())}`,
    `Message-ID: <${assertHeaderSafe('Message-ID', m.messageId ?? randomUUID())}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
    'Content-Type: multipart/alternative;',
    ` boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(m.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(m.html),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

/**
 * The DATA payload as it goes on the wire: checked (no bare CR or LF, no line
 * over 998 octets), dot-stuffed, and terminated by `CRLF.CRLF`.
 */
export function dataBlock(payload: string): string {
  const body = payload.endsWith('\r\n') ? payload : payload + '\r\n';
  if (/\r(?!\n)|(?<!\r)\n/.test(body)) throw new MailError('input', 'a bare CR or LF in the message');
  if (body.split('\r\n').some((l) => Buffer.byteLength(l, 'utf8') > 998)) throw new MailError('input', 'a message line over 998 octets');
  return body.replace(/^\./gm, '..') + '.\r\n';
}
