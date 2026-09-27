// Sensitive-column detection — MAIN PROCESS, PURE apart from one lazy file read.
//
// Looks at a table's column NAMES and a SAMPLE of its values and PROPOSES a
// sensitivity level for the columns that look like personal or financial data.
// It never decides anything: every proposal is shown to the user (composer,
// column profile, dataset page, Settings → Privacy) and only an accepted one is
// written, through catalog.setColumn. Detection is a hint with a reason attached,
// which is why a false positive costs one "Not sensitive" click and a false
// negative is the user's own sensitivity control, both already shipped.
//
// Two kinds of evidence, combined per column:
//
//   VALUES   strict per-value checks (Luhn for a card, mod-97 for an IBAN, a
//            parseable address for an IP) over up to SAMPLE_VALUES non-empty
//            cells. A column needs most of its sample to match — one email in a
//            notes column is not an email column.
//   NAMES    the header, tokenised (`customerEmail` → customer, email). A header
//            alone is enough for the few kinds whose values have no shape
//            (a passport number, a salary); for the rest it only LOWERS the value
//            threshold, so `email_sent` (a yes/no column) is never proposed.
//
// A person's name is the one soft kind: a value counts when it is two to four
// capitalised words whose given name is in the bundled list
// (assets/privacy/first-names.txt). "Grace Street" passes that per-value check
// too, which is why names need 60% of the column rather than one lucky match.

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { ParsedColumn } from './parse';
import type { Cell } from './transforms';

export type SensitiveKind =
  | 'email' | 'phone' | 'national_id' | 'card_number' | 'iban' | 'ip_address'
  | 'street_address' | 'person_name' | 'birth_date' | 'salary';

export type ProposedLevel = 'personal' | 'financial';

export interface SensitivityProposal {
  column: string;
  level: ProposedLevel;
  kind: SensitiveKind;
  /** One sentence the UI shows as-is: why this column was flagged. */
  reason: string;
}

export const KIND_LABELS: Record<SensitiveKind, string> = {
  email: 'email addresses',
  phone: 'phone numbers',
  national_id: 'national ID numbers',
  card_number: 'card numbers',
  iban: 'bank account numbers (IBAN)',
  ip_address: 'IP addresses',
  street_address: 'street addresses',
  person_name: "people's names",
  birth_date: 'dates of birth',
  salary: 'pay or income',
};

const LEVEL: Record<SensitiveKind, ProposedLevel> = {
  email: 'personal', phone: 'personal', national_id: 'personal', ip_address: 'personal',
  street_address: 'personal', person_name: 'personal', birth_date: 'personal',
  card_number: 'financial', iban: 'financial', salary: 'financial',
};

/** Rows read per column, and how many non-empty values are tested. */
export const SAMPLE_ROWS = 2000;
export const SAMPLE_VALUES = 200;
/** Fewer non-empty values than this and value evidence is not trusted. */
const MIN_VALUES = 3;
/** Share of the sample that must match: strict shapes, soft shapes, and either with a header hint. */
const STRICT = 0.8;
const SOFT = 0.6;
const HINTED = 0.3;

// ── The bundled first-name list ──────────────────────────────────────────────

let firstNames: Set<string> | null = null;

/** Lowercase, accents stripped — the list is stored the same way. */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function firstNameSet(): Set<string> {
  if (firstNames) return firstNames;
  const file = path.join(__dirname, '..', '..', 'assets', 'privacy', 'first-names.txt');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error('[sensitivity] first-name list unreadable; person names will not be detected:', err instanceof Error ? err.message : err);
  }
  firstNames = new Set(text.split(/\r?\n/).map((l) => foldName(l.trim())).filter((l) => l && !l.startsWith('#')));
  return firstNames;
}

// ── Per-value checks (exported for the tests) ────────────────────────────────

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,24}$/i;
export function isEmail(v: string): boolean {
  return EMAIL_RE.test(v);
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** 13–19 digits, optionally grouped by spaces or dashes, passing Luhn. */
export function isCardNumber(v: string): boolean {
  if (!/^\d[\d -]{11,22}\d$/.test(v)) return false;
  const digits = v.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false; // 0000… passes Luhn and is nobody's card
  return luhnValid(digits);
}

/** ISO 13616: two letters, two check digits, up to 30 more; mod-97 of the rearrangement is 1. */
export function isIban(v: string): boolean {
  const s = v.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : ch;
    for (const d of part) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** US SSN (not the never-issued 000/666/9xx areas) or a UK National Insurance number. */
export function isNationalId(v: string): boolean {
  const ssn = /^(\d{3})-(\d{2})-(\d{4})$/.exec(v);
  if (ssn) return ssn[1] !== '000' && ssn[1] !== '666' && ssn[1][0] !== '9' && ssn[2] !== '00' && ssn[3] !== '0000';
  return /^(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]$/i.test(v);
}

export function isIp(v: string): 4 | 6 | 0 {
  const k = net.isIP(v);
  return k === 4 || k === 6 ? k : 0;
}

/**
 * A phone number: 7–15 digits with the punctuation phone numbers carry, either
 * international (+) or visibly grouped. Shapes that are something else first —
 * an ISO date, a year range, a ZIP+4, a decimal — are refused, because a
 * column of them would otherwise be 100% "phone numbers".
 */
export function isPhone(v: string): boolean {
  if (!/^\+?[\d\s().-]{7,22}(\s*(x|ext\.?)\s*\d{1,5})?$/i.test(v)) return false;
  const core = v.replace(/\s*(x|ext\.?)\s*\d{1,5}$/i, '');
  const digits = core.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(core)) return false; // 2024-01-15
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(core)) return false; // 01.15.2024
  if (/^(19|20)\d{2}\s*[-–]\s*(19|20)?\d{2}$/.test(core)) return false; // 2019-2020
  if (/^\d{5}-\d{4}$/.test(core)) return false; // ZIP+4
  if (/^\d+\.\d+$/.test(core)) return false; // a decimal
  if (core.startsWith('+')) return true;
  return core.split(/[\s().-]+/).filter(Boolean).length >= 2;
}

const STREET_WORDS = 'street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|ter|parkway|pkwy|highway|hwy|circle|cir|square|sq|crescent|close|row|walk';
const STREET_EN = new RegExp(`^\\d{1,6}[a-z]?,?\\s+(?:[\\p{L}0-9.'-]+\\s+){1,5}(?:${STREET_WORDS})\\b\\.?`, 'iu');
const STREET_EU_SUFFIX = /^[\p{L}.' -]*(?:straße|strasse|str\.|weg|gasse|platz|allee|laan|straat|gracht|plein|vej|gatan|gata|veien)\s*\d{1,5}[a-z]?\b/iu;
const STREET_EU_PREFIX = /^(?:\d{1,5},?\s+)?(?:rue|avenue|av\.|boulevard|bd|chemin|allée|impasse|calle|c\/|avenida|avda\.?|paseo|plaza|via|viale|piazza|corso|rua|travessa|largo|ulica|ul\.)\s+[\p{L}0-9 .'-]{2,60}?(?:,?\s*\d{1,5}[a-z]?)?$/iu;
export function isStreetAddress(v: string): boolean {
  if (v.length > 120) return false;
  if (STREET_EN.test(v) || STREET_EU_SUFFIX.test(v)) return true;
  return STREET_EU_PREFIX.test(v) && /\d/.test(v);
}

const NAME_TOKEN = /^\p{Lu}[\p{L}'’-]*\.?$/u;
/** "Grace Hopper", "Hopper, Grace", "María José García" — the given name vouched for by the list. */
export function isPersonName(v: string): boolean {
  if (v.length > 60) return false;
  let given = '';
  let tokens: string[];
  const comma = /^([^,]+),\s*([^,]+)$/.exec(v);
  if (comma) {
    tokens = [...comma[1].trim().split(/\s+/), ...comma[2].trim().split(/\s+/)];
    given = comma[2].trim().split(/\s+/)[0];
  } else {
    tokens = v.split(/\s+/);
    given = tokens[0];
  }
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (!tokens.every((t) => NAME_TOKEN.test(t))) return false;
  return firstNameSet().has(foldName(given.replace(/[.'’-].*$/, '')));
}

// ── Header hints ─────────────────────────────────────────────────────────────

/** `customerEmail`, `e-mail_addr`, `Card No.` → lowercase word tokens. */
export function headerTokens(name: string): string[] {
  return String(name || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const PERSON_WORDS = new Set(['first', 'last', 'full', 'given', 'family', 'sur', 'surname', 'middle', 'customer', 'client',
  'employee', 'person', 'contact', 'patient', 'member', 'owner', 'author', 'student', 'user', 'buyer', 'recipient', 'sender']);

/**
 * What the header alone suggests. `strong` hints propose on the name alone —
 * the kinds whose values have no reliable shape. Weak ones only lower the value
 * threshold.
 */
export function headerHint(name: string): { kind: SensitiveKind; strong: boolean } | null {
  const t = headerTokens(name);
  const has = (w: string): boolean => t.includes(w);
  const joined = t.join('');
  if (has('version') || has('ver') || has('build') || has('release')) return null;
  if (has('ssn') || joined.includes('socialsecurity') || joined.includes('nationalid') || has('passport')
    || has('nino') || has('taxid') || (has('tax') && has('id')) || has('aadhaar')) {
    return { kind: 'national_id', strong: true };
  }
  if (joined.includes('creditcard') || joined.includes('cardnumber') || joined.includes('cardno') || (has('cc') && (has('num') || has('number') || has('no')))
    || (has('card') && (has('number') || has('num') || has('no') || has('pan')))) {
    return { kind: 'card_number', strong: true };
  }
  if (has('iban') || joined.includes('accountnumber') || joined.includes('bankaccount') || joined.includes('acctno') || joined.includes('acctnum')
    || has('bic') || has('swift') || joined.includes('routingnumber') || joined.includes('sortcode')) {
    return { kind: 'iban', strong: true };
  }
  if (joined.includes('dateofbirth') || has('dob') || has('birthday') || has('birthdate') || (has('birth') && has('date'))) {
    return { kind: 'birth_date', strong: true };
  }
  if (has('salary') || has('salaries') || has('wage') || has('wages') || has('payroll') || has('income') || has('compensation')) {
    return { kind: 'salary', strong: true };
  }
  if (has('email') || has('mail') || joined.includes('email')) return { kind: 'email', strong: false };
  if (has('phone') || has('mobile') || has('cell') || has('tel') || has('telephone') || has('fax') || joined.includes('phone')) {
    return { kind: 'phone', strong: false };
  }
  if (has('ip') || has('ipv4') || has('ipv6') || joined.includes('ipaddress') || joined.includes('remoteaddr')) {
    return { kind: 'ip_address', strong: false };
  }
  if (has('address') || has('street') || has('addr')) return { kind: 'street_address', strong: false };
  if ((has('name') || has('surname') || has('forename')) && t.some((w) => PERSON_WORDS.has(w))) {
    return { kind: 'person_name', strong: true };
  }
  if (has('name') && t.length === 1) return { kind: 'person_name', strong: false };
  return null;
}

// ── The column verdict ───────────────────────────────────────────────────────

interface ValueRule {
  kind: SensitiveKind;
  test: (v: string) => boolean;
  threshold: number;
  noun: string;
}

// Most specific first: an SSN is also a grouped digit string, a card number
// also a long one — the first rule a column clears wins.
const RULES: ValueRule[] = [
  { kind: 'card_number', test: isCardNumber, threshold: STRICT, noun: 'card numbers (they pass the Luhn check)' },
  { kind: 'iban', test: isIban, threshold: STRICT, noun: 'IBANs (they pass the mod-97 check)' },
  { kind: 'national_id', test: isNationalId, threshold: STRICT, noun: 'national ID numbers' },
  { kind: 'email', test: isEmail, threshold: STRICT, noun: 'email addresses' },
  { kind: 'ip_address', test: (v) => isIp(v) !== 0, threshold: STRICT, noun: 'IP addresses' },
  { kind: 'phone', test: isPhone, threshold: STRICT, noun: 'phone numbers' },
  { kind: 'street_address', test: isStreetAddress, threshold: SOFT, noun: 'street addresses' },
  { kind: 'person_name', test: isPersonName, threshold: SOFT, noun: "people's names" },
];

/**
 * A column of dotted quads whose every part is small is a column of version
 * numbers ("1.2.3.4"), not addresses. Real address columns carry at least one
 * octet past 31 somewhere in a sample of any size.
 */
function looksLikeVersions(values: string[]): boolean {
  const quads = values.filter((v) => isIp(v) === 4);
  return quads.length > 0 && quads.every((v) => v.split('.').every((p) => Number(p) <= 31));
}

/** The non-empty string values the checks run over. */
function sampleValues(rows: Cell[][], c: number): string[] {
  const out: string[] = [];
  const n = Math.min(rows.length, SAMPLE_ROWS);
  for (let r = 0; r < n && out.length < SAMPLE_VALUES; r += 1) {
    const cell = rows[r] ? rows[r][c] : null;
    if (cell == null) continue;
    const s = String(cell).trim();
    if (s) out.push(s);
  }
  return out;
}

/** The proposal for ONE column, or null. */
export function detectColumn(column: ParsedColumn, values: string[]): SensitivityProposal | null {
  const name = String(column.name);
  const hint = headerHint(name);
  if (values.length >= MIN_VALUES) {
    for (const rule of RULES) {
      if (rule.kind === 'ip_address' && hint === null && looksLikeVersions(values)) continue;
      const hits = values.reduce((n, v) => n + (rule.test(v) ? 1 : 0), 0);
      const need = hint && hint.kind === rule.kind ? HINTED : rule.threshold;
      if (hits / values.length >= need) {
        return {
          column: name,
          level: LEVEL[rule.kind],
          kind: rule.kind,
          reason: `${hits} of ${values.length} sampled values look like ${rule.noun}.`,
        };
      }
    }
  }
  if (hint && hint.strong) {
    return {
      column: name,
      level: LEVEL[hint.kind],
      kind: hint.kind,
      reason: `The column name suggests ${KIND_LABELS[hint.kind]}.`,
    };
  }
  return null;
}

/**
 * Every proposal for a table, in column order. `rows` may be the whole table:
 * only the first SAMPLE_ROWS are read.
 */
export function detectSensitive(columns: ParsedColumn[], rows: Cell[][]): SensitivityProposal[] {
  const out: SensitivityProposal[] = [];
  const list = Array.isArray(columns) ? columns : [];
  const body = Array.isArray(rows) ? rows : [];
  list.forEach((col, c) => {
    const p = detectColumn(col, sampleValues(body, c));
    if (p) out.push(p);
  });
  return out;
}
