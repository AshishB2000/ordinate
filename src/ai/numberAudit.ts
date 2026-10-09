// Does the answer only cite figures the app computed? — MAIN PROCESS, PURE.
// No fs, no DOM, no model.
//
// ── The contract this enforces ───────────────────────────────────────────────
// "The app does the math. A model only narrates figures the app already
// computed; it NEVER writes a computed number." Every FACTS block in
// `./copilot.ts` opens by saying exactly that. Until now nothing checked it, so
// the contract was a sentence in a prompt — which is to say, a request.
//
// This module turns it into a measurement. `copilot.ts` records every figure it
// hands the model as a LEDGER entry alongside the prompt text; `auditNumbers`
// then reads the answer back and asks, of each numeric token, "is this one of
// ours?". It is app-side arithmetic over app-side records: no model is involved
// in judging a model.
//
// ── Why the ledger is built where the facts are ──────────────────────────────
// One source, not two. Each `*Facts` builder emits its lines and its ledger
// entries from the SAME values in the same pass, so a figure cannot reach the
// prompt without reaching the ledger. `scripts/test-numberAudit.ts` closes the
// loop by auditing each builder's own `text` against its own `ledger` — if a
// future line prints a number the ledger does not carry, that test fails rather
// than a user seeing a false accusation under a perfectly good answer.
//
// ── Which way this errs, and why ─────────────────────────────────────────────
// A violation is shown to the USER, under the answer. So a false positive is
// worse than a false negative: it accuses a correct answer, and a guard that
// cries wolf gets ignored, which costs more than the guard was worth. Every
// judgement call below therefore resolves toward silence, and each one is named
// with the blind spot it buys:
//
//   - A bare four-digit integer in [1900, 2100] is read as a YEAR and never
//     audited. Blind spot: a genuine figure that happens to be 2024 written
//     without separators or units passes unchecked. Unconditional, because
//     "in 2024" is far commoner in narration than a raw figure of 2024, and
//     context cues ("in", "during") are not reliable enough to split them.
//   - A currency symbol is presentational and is stripped. The app stores no
//     currency metadata, so "$3,200" is audited exactly as "3,200".
//   - Ordinals, `#`-prefixed and id-cued numbers, and list positions ("top 5")
//     are exempt: they are references, not figures.
//
// A PERCENTAGE is the one place this is deliberately strict. A `%` token only
// matches a ledger entry whose unit is `percent`, and the app currently computes
// no percentages at all — so any percentage in an answer is a violation, which
// is correct: the model derived it. That is the single highest-value catch here,
// because "revenue grew 12.4%" is the exact shape of a plausible invented
// figure, and it is the one a reader is least likely to question.

/**
 * What kind of quantity a ledger figure is. Not a display format — a `count`
 * and a `number` are both matched the same way; the distinction that MATTERS is
 * `percent`, which a `%` token requires (see the header).
 */
export type LedgerUnit = 'number' | 'count' | 'percent';

/** ONE figure the app computed and handed to the model. App-side, never model output. */
export interface LedgerEntry {
  /** What it is, in the app's own words — never shown to the user in this PR. */
  label: string;
  /** The app-computed value, verbatim and unrounded. */
  value: number;
  unit: LedgerUnit;
  /** Which app-side computation produced it, e.g. 'datasetStats' / 'vizData'. */
  source: string;
}

export interface NumberViolation {
  /** The token exactly as it appeared in the answer, e.g. '12.4%'. */
  token: string;
  /** The closest ledger figure, for debugging. Informational — NOT the match test. */
  nearest: LedgerEntry | null;
  /** token value − nearest.value, or null when the ledger is empty. */
  delta: number | null;
}

export interface NumberAudit {
  ok: boolean;
  violations: NumberViolation[];
}

// ── Masking ──────────────────────────────────────────────────────────────────
//
// Date-shaped text is removed BEFORE tokenising, replaced by spaces so every
// surviving index still lines up with the original string (the id-cue rule reads
// the characters before a token). These shapes are what a grained date axis
// actually emits (analysis/categoryKey.dateBucketLabel) and what a date column
// stores, so they arrive in answers constantly: '2024-03' tokenised naively is
// "2024" and "3", and that stray 3 would be a violation under every month the
// model names.
const DATE_SHAPES: RegExp[] = [
  /FY\d{2,4}(?: Q[1-4]| P\d{2}(?: W\d)?)?/g, // FY24, FY24 Q1, FY24 P03 W2 (a retail calendar)
  /\d{4}-[PW]\d{2}/g, // 2020-W53, 2020-P12 (the ISO week-year)
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, // 2024-03-05, 2024/3/5
  /\d{1,2}[-/]\d{1,2}[-/]\d{4}/g, // 03/05/2024
  /\d{4}-Q[1-4]/gi, // 2024-Q1
  /Q[1-4][-\s]\d{4}/gi, // Q1 2024
  // A clock time and a month-and-day: the facts state when the data is from
  // ("Data as of: Oct 9, 2026, 1:00 AM UTC", ./answerFacts), and a narration
  // that repeats it must not be accused of inventing a 1 and a 9. Blind spot:
  // a figure written as h:mm, or a day number 1–31 straight after a month name
  // and before a comma, "at", a year or the end of a sentence ("in May 12.")
  // — never a figure in practice. "March 12 orders" is still audited.
  /(?<![\d.])\d{1,2}(?::\d{2}){1,2}(?!\d)(?:\s?[ap]\.?m\b\.?)?/gi, // 1:00, 13:05:59, 1:00 AM, 9:30p.m.
  /(?<![\d.])\d{1,2}\s?[ap]\.?m\b\.?/gi, // 1 AM, 11pm
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?:[12]\d|3[01]|0?[1-9])(?:st|nd|rd|th)?(?=,|\s+at\b|\s+\d{4}\b|\s*[.;:!?)](?!\d)|\s*$)/gi, // Oct 9, 2026 · October 9 at …
  // 2024-03 (month grain). Last, so the full dates above win. The lookahead
  // rejects only a further DIGIT — a trailing '.' is a sentence ending far more
  // often than a decimal, and masking one character too many is harmless while
  // masking one too few leaves a stray '03' under every month the model names.
  /\d{4}-\d{1,2}(?!\d)/g,
];

function maskDates(text: string): string {
  let out = text;
  for (const re of DATE_SHAPES) {
    out = out.replace(re, (m) => ' '.repeat(m.length));
  }
  return out;
}

// ── Tokenising ───────────────────────────────────────────────────────────────
//
// The leading `(?<![\w.])` does two jobs at once. It keeps a number inside a
// word out ('A1', 'COVID19') and — because a digit is a word character — it
// stops a hyphen BETWEEN digits from being read as a minus sign, so the range
// '10-20' is two positive figures rather than 10 and −20. A '-' after a space
// still signs its number.
const TOKEN_RE =
  /(?<![\w.])(?:([$€£¥])\s?)?([-−])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?(?:([KMB])(?![\w]))?\s?(%)?/gi;

const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

interface Token {
  raw: string;
  value: number;
  /** Decimal places SHOWN — half of the last one is the rounding tolerance. */
  decimals: number;
  /** 1 / 1e3 / 1e6 / 1e9, from a K/M/B suffix. */
  scale: number;
  percent: boolean;
  /** No sign, separator, decimal, suffix, currency or percent — just digits. */
  bare: boolean;
  /** Index in the (masked) text, so the exemption rules can read what precedes it. */
  at: number;
  /**
   * Index just past the token's last non-space character. Tracked separately
   * from `at + raw.length` because the optional `\s?` before the K/M/B and `%`
   * groups can consume a trailing space that neither group then uses ('5 rows'
   * matches as '5 '), and the ordinal rule reads the two characters that follow.
   */
  end: number;
}

function tokenise(masked: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(masked); m !== null; m = TOKEN_RE.exec(masked)) {
    const [raw, currency, sign, intPart, frac, suffix, pct] = m;
    const digits = intPart.replace(/,/g, '') + (frac ? '.' + frac : '');
    const scale = suffix ? SCALE[suffix.toLowerCase()] : 1;
    const magnitude = Number(digits) * scale;
    if (!Number.isFinite(magnitude)) continue;
    out.push({
      // Inner spaces collapsed so the note reads '9.4%' and '1.2K' rather than
      // '9.4 %' — the user is being shown this string.
      raw: raw.trim().replace(/\s+/g, ''),
      value: sign ? -magnitude : magnitude,
      decimals: frac ? frac.length : 0,
      scale,
      percent: !!pct,
      bare: !currency && !sign && !frac && !suffix && !pct && !intPart.includes(','),
      at: m.index,
      end: m.index + raw.trimEnd().length,
    });
  }
  return out;
}

/**
 * The figures inside a string the APP wrote — for the ledger, not for judging.
 *
 * ONLY EVER CALL THIS ON APP-AUTHORED TEXT. Every number it returns is entered
 * into the ledger as app-computed, so pointing it at model output would let the
 * model launder its own inventions into the record this module exists to keep.
 *
 * It exists for one real case: `datasetStats.findQualityIssues` hands back a
 * finished sentence ('Column "region" is 60% empty') rather than its parts, so
 * the 60 has no structured field to read. Harvesting it with the SAME tokeniser
 * the audit uses is what keeps the two from disagreeing about what a number in
 * that sentence even is — and it carries the `%` through as a `percent` unit,
 * which matters because that is the app's only source of percentages and
 * without it every answer quoting one would be falsely accused.
 */
export function harvestAppNumbers(appText: string): { value: number; unit: LedgerUnit }[] {
  const masked = maskDates(typeof appText === 'string' ? appText : '');
  return tokenise(masked)
    .filter((t) => !isReference(t, masked))
    .map((t) => ({ value: t.value, unit: t.percent ? ('percent' as const) : ('number' as const) }));
}

// ── Exemptions: what is a reference rather than a figure ─────────────────────

/** `order 10493`, `#4471`, `invoice 22`. The cue PRECEDES the number. */
const ID_CUE =
  /(?:#\s?|\b(?:order|invoice|ticket|sku|id|ids|ref|code|account|customer|transaction|txn)\b\s*[:#]?\s*)$/i;

/** `top 5`, `first 3`, `step 2` — a position in a list, not a measurement. */
const LIST_CUE = /\b(?:top|first|last|next|step|page|row)\b\s*$/i;

const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

/**
 * True when this token is not a figure at all. Checked BEFORE any ledger match:
 * an exempt token is never a violation regardless of what the ledger holds, and
 * reporting a "nearest" for a purchase-order number would be noise.
 */
function isReference(t: Token, masked: string): boolean {
  // A year, unconditionally. See the header for the blind spot this buys.
  if (t.bare && Number.isInteger(t.value) && t.value >= YEAR_MIN && t.value <= YEAR_MAX) return true;
  // An ordinal is a position: '1st', '2nd', '3rd', '4th'.
  if (t.bare && /^(?:st|nd|rd|th)\b/i.test(masked.slice(t.end, t.end + 3))) return true;
  const before = masked.slice(Math.max(0, t.at - 24), t.at);
  return ID_CUE.test(before) || LIST_CUE.test(before);
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * How far a ledger value may sit from a token and still BE that token.
 *
 * Exactly "rounding to the precision shown, and nothing looser": a figure
 * written to one decimal at thousands scale ('1.2K') covers a half-step of
 * 0.5 × 1000 × 10⁻¹ = 50, so 1,180 is legitimately 1.2K and 1,300 is not. A
 * bare integer covers ±0.5. The epsilon is float slack on the boundary itself,
 * not extra latitude.
 */
function halfWidth(t: Token): number {
  const step = t.scale * Math.pow(10, -t.decimals);
  return step / 2 + Math.abs(step) * 1e-9;
}

/**
 * A `%` token needs a `percent` figure; anything else may cite a `percent` one
 * too (the same figure without its sign is still that figure). This asymmetry
 * is what catches a percentage the model worked out for itself.
 */
function unitFits(t: Token, e: LedgerEntry): boolean {
  return t.percent ? e.unit === 'percent' : true;
}

function nearestTo(value: number, ledger: LedgerEntry[]): LedgerEntry | null {
  let best: LedgerEntry | null = null;
  let bestDelta = Infinity;
  for (const e of ledger) {
    const d = Math.abs(e.value - value);
    if (d < bestDelta) {
      bestDelta = d;
      best = e;
    }
  }
  return best;
}

/**
 * Every numeric token in `answerText` that the app did not compute.
 *
 * PURE and total: never throws, never calls a model, and does not care where the
 * text came from — the same function audits a model's answer and the app's own
 * FACTS block (which is how the ledger is kept honest, see the header).
 *
 * An empty ledger is not a free pass: with no app-computed figures to cite, ANY
 * figure in the answer is one the model produced, which is exactly the finding.
 * Duplicate tokens are reported once — the note under the answer names what is
 * wrong, and saying '12.4%' three times does not make it wronger.
 */
export function auditNumbers(answerText: string, ledger: LedgerEntry[]): NumberAudit {
  const text = typeof answerText === 'string' ? answerText : '';
  const entries = Array.isArray(ledger) ? ledger.filter((e) => e && Number.isFinite(e.value)) : [];
  const masked = maskDates(text);
  const violations: NumberViolation[] = [];
  const seen = new Set<string>();

  for (const t of tokenise(masked)) {
    if (isReference(t, masked)) continue;
    const tol = halfWidth(t);
    if (entries.some((e) => unitFits(t, e) && Math.abs(e.value - t.value) <= tol)) continue;
    if (seen.has(t.raw)) continue;
    seen.add(t.raw);
    const nearest = nearestTo(t.value, entries);
    violations.push({
      token: t.raw,
      nearest,
      delta: nearest ? t.value - nearest.value : null,
    });
  }
  return { ok: violations.length === 0, violations };
}
