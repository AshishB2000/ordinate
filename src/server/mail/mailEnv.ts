// The SMTP relay's settings (docs/email/00-design.md §4) — PURE. env.ts passes
// each `src.SMTP_*` here, so the variables are read in one place and a typo stops
// the pod (and the Helm migration Job) at startup with one line naming it.
//
// The relay is OPERATOR configuration: nothing a member, a record or a request
// says ever reaches a field here. The password is held as a KeyObject, as
// ORDINATE_MASTER_KEY is, so it never reaches JSON, util.inspect or a log line.
//
// Also here, because startup and every connect must agree on them: the strict
// address pattern and the ranges a plaintext relay may sit in.

import { createSecretKey, type KeyObject } from 'crypto';
import { BlockList, isIP } from 'net';
import { EnvError } from '../envError';

export type SmtpSecurity = 'starttls' | 'tls' | 'plaintext';

export interface MailEnv {
  /** Canonical bare host (lower case, no brackets): a name or an IP literal. */
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  /** AUTH user, or null for an IP-trusted relay. */
  readonly user: string | null;
  readonly password: KeyObject | null;
  /** The envelope sender and From: address, and its display name (null = none). */
  readonly from: { readonly address: string; readonly name: string | null };
  /** RATE_LIMIT_EMAIL_ORG_PER_HOUR: recipients per org per hour, per bucket, per pod. */
  readonly orgPerHour: number;
  /** Lines to log at startup (app.ts logs them). Never holds the password. */
  readonly warnings: readonly string[];
}

export type MailSrc = Readonly<Record<
  'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURITY' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'SMTP_FROM' | 'RATE_LIMIT_EMAIL_ORG_PER_HOUR',
  string | undefined
>>;

const SECURITY: readonly SmtpSecurity[] = ['starttls', 'tls', 'plaintext'];
const DEFAULT_PORT: Record<SmtpSecurity, number> = { starttls: 587, tls: 465, plaintext: 25 };
export const DEFAULT_ORG_PER_HOUR = 1000;

/**
 * A mail address we will send to or from: ASCII, ≤ 254, a dot-atom local part
 * without `%`, `!`, quotes or backslash (no source routes, no quoted strings),
 * and a domain of letter-digit-hyphen labels whose last label has a letter — so
 * no `[ip]` literal and no bare IPv4.
 */
const LOCAL = "[A-Za-z0-9#$&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9#$&'*+/=?^_`{|}~-]+)*";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const ADDRESS_RE = new RegExp(`^${LOCAL}@(?:${LABEL}\\.)+(?=[A-Za-z0-9-]*[A-Za-z])${LABEL}$`);

export function isMailAddress(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 254 && s.split('@')[0].length <= 64 && ADDRESS_RE.test(s);
}

/** Where a plaintext relay may be: loopback, RFC 1918, IPv6 unique-local. Startup and every connect ask this. */
const PLAINTEXT_OK = new BlockList();
for (const [a, p] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) PLAINTEXT_OK.addSubnet(a, p, 'ipv4');
PLAINTEXT_OK.addAddress('::1', 'ipv6');
PLAINTEXT_OK.addSubnet('fc00::', 7, 'ipv6');

export function plaintextAllowedAt(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && PLAINTEXT_OK.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The bare host `raw` names, or null when it is anything else. Checked HERE, character by character — a name of
 * letters, digits, `.`, `-` and `_`, an IPv4, or an IPv6 (bracketed or not) — because the URL parser drops a
 * scheme's default port, so `relay.example.com:80` would pass a `URL.port` check. The URL parser then only
 * canonicalizes (lower case; decimal / octal / hex IPv4 forms decoded, as the SSRF guard does).
 */
export function bareHost(raw: string): string | null {
  const t = raw.trim();
  const v6 = /^\[[0-9A-Fa-f:.]+\]$/.test(t) ? t.slice(1, -1) : t;
  const host = isIP(v6) === 6 ? `[${v6}]` : /^[A-Za-z0-9._-]{1,253}$/.test(t) ? t : null;
  if (!host) return null;
  try {
    return new URL(`http://${host}/`).hostname.replace(/^\[(.*)\]$/, '$1') || null;
  } catch {
    return null;
  }
}

/** `addr@x` or `Name <addr@x>` (the name may be double-quoted). */
function parseFrom(raw: string): MailEnv['from'] {
  const m = /^\s*(?:(.*?)\s*<([^<>]*)>|([^<>\s]+))\s*$/s.exec(raw);
  const address = m ? (m[2] ?? m[3] ?? '').trim() : '';
  if (!isMailAddress(address)) throw new EnvError(`SMTP_FROM must be an address (bi@example.com) or Name <address>, got ${JSON.stringify(raw)}`);
  let name = m && m[1] !== undefined ? m[1].trim() : '';
  if (/^".*"$/s.test(name)) name = name.slice(1, -1);
  if (/[\u0000-\u001f\u007f"\\<>]/.test(name) || name.length > 100) {
    throw new EnvError('SMTP_FROM: the display name may not hold quotes, backslashes, angle brackets or control characters (100 characters at most)');
  }
  return Object.freeze({ address, name: name || null });
}

/** One field that must be printable: CR, LF and NUL would break AUTH PLAIN or a header. */
function printable(name: string, v: string): string {
  if (/[\u0000\r\n]/.test(v)) throw new EnvError(`${name} may not hold a line break or NUL`);
  return v;
}

/**
 * The relay, or null when SMTP_HOST is unset (email off). `hasDatabase`: email
 * needs the user directory, so without it the settings stand but a warning says
 * email is off.
 */
export function parseMail(src: MailSrc, hasDatabase: boolean): MailEnv | null {
  const raw = src.SMTP_HOST ?? '';
  if (raw === '') {
    const stray = (Object.keys(src) as Array<keyof MailSrc>).find((k) => k.startsWith('SMTP_') && (src[k] ?? '') !== '');
    if (stray) throw new EnvError(`${stray} is set but SMTP_HOST is not: set SMTP_HOST to the relay, or remove ${stray}`);
    return null;
  }
  const host = bareHost(raw);
  // Never echo a value with '@' or ':' in it: it may be a URL carrying a password.
  if (!host) throw new EnvError(`SMTP_HOST must be a bare host name or IP address (no scheme, port, user or path)${/[@:]/.test(raw) ? '' : `, got ${JSON.stringify(raw)}`}`);

  const security = ((): SmtpSecurity => {
    const v = src.SMTP_SECURITY ?? '';
    if (v === '') return 'starttls';
    if ((SECURITY as readonly string[]).includes(v)) return v as SmtpSecurity;
    throw new EnvError(`SMTP_SECURITY must be one of ${SECURITY.join('|')}, got ${JSON.stringify(v)}`);
  })();
  const rawPort = src.SMTP_PORT ?? '';
  const port = rawPort === '' ? DEFAULT_PORT[security] : Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort || '1') || !(port >= 1 && port <= 65535)) throw new EnvError(`SMTP_PORT must be a port number 1-65535, got ${JSON.stringify(rawPort)}`);

  const user = src.SMTP_USER ? printable('SMTP_USER', src.SMTP_USER) : null;
  const pass = src.SMTP_PASSWORD ? printable('SMTP_PASSWORD', src.SMTP_PASSWORD) : null;
  if (user && !pass) throw new EnvError('SMTP_PASSWORD is required when SMTP_USER is set');
  if (pass && !user) throw new EnvError('SMTP_USER is required when SMTP_PASSWORD is set');
  if (user && security === 'plaintext') throw new EnvError('SMTP_USER cannot be used with SMTP_SECURITY=plaintext: the password would cross the network unencrypted');
  if (security === 'plaintext' && isIP(host) && !plaintextAllowedAt(host)) {
    throw new EnvError('SMTP_SECURITY=plaintext needs a relay on a loopback, private (RFC 1918) or unique-local IPv6 address');
  }

  if (!src.SMTP_FROM) throw new EnvError('SMTP_FROM is required when SMTP_HOST is set');
  const from = parseFrom(src.SMTP_FROM);

  const rawRate = src.RATE_LIMIT_EMAIL_ORG_PER_HOUR ?? '';
  const orgPerHour = rawRate === '' ? DEFAULT_ORG_PER_HOUR : Number(rawRate);
  if (rawRate !== '' && (!/^\d{1,7}$/.test(rawRate) || orgPerHour === 0)) {
    throw new EnvError(`RATE_LIMIT_EMAIL_ORG_PER_HOUR must be a positive whole number, got ${JSON.stringify(rawRate)}`);
  }

  const warnings: string[] = [];
  if (security === 'plaintext') warnings.push('SMTP_SECURITY=plaintext: emails, and the figures in them, cross the network to SMTP_HOST unencrypted. Use it only for a relay on a network you trust end to end.');
  if (security === 'starttls' && port === 465) warnings.push('SMTP_SECURITY=starttls with SMTP_PORT=465: port 465 normally speaks TLS from the first byte (SMTP_SECURITY=tls), so sends will likely fail.');
  if (security === 'tls' && (port === 25 || port === 587)) warnings.push(`SMTP_SECURITY=tls with SMTP_PORT=${port}: that port normally upgrades with STARTTLS (SMTP_SECURITY=starttls), so sends will likely fail.`);
  if (!hasDatabase) warnings.push('SMTP_HOST is set but DATABASE_URL is not: email needs the user directory, so it is off.');

  return Object.freeze({
    host, port, security, user,
    password: pass ? createSecretKey(Buffer.from(pass, 'utf8')) : null,
    from, orgPerHour, warnings: Object.freeze(warnings),
  });
}
