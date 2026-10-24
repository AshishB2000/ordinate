// @mentions in a comment's Markdown (docs/notifications/00-design.md §5.1) — the
// ONE parser: the server (the reader check, the notices, every plain-text
// surface) and the web (the chip) both import this file. Pure: no I/O, no Node
// or DOM API, no catalog (a caller passes the words it shows).
//
// A mention is `@(` + an address + `)`: `@(ann.lee@acme.com)`. An address never
// holds `(`, `)`, `<`, `>`, `[`, `]`, `\` or whitespace, and the pattern refuses
// them inside the token, so a token is never a Markdown link, an autolink or a
// tag, and never ends early. `\@(…)` is an escaped, literal `@(…)` on both sides.

const MENTION = /(?<!\\)@\(([^\s()<>[\]@\\]{1,64}@[^\s()<>[\]@\\]{1,190})\)/g;
const ESCAPED = /\\@\(/g;
/** The web's placeholder brackets (U+E000, U+E001): a body can never hold them. */
const PUA = /[\uE000\uE001]/g;

/**
 * A body with the placeholder brackets REPLACED (by U+FFFD), never deleted:
 * deleting a character can join `@` and `(` into a token, or split a `\` from
 * its `@`. Applied on write (app/commentModel.ts cleanBody) and again, for a
 * body stored before that, by every function here — so the server and the web
 * always read the same mentions.
 */
export function scrubPua(body: string): string {
  return String(body ?? '').replace(PUA, '\uFFFD');
}

/** Distinct people one comment or reply may mention. */
export const MAX_MENTIONS = 10;

/** The ONE normaliser: what the server checks and stores, and what the web looks a name up by. */
export function normalize(address: string): string {
  return address.toLowerCase();
}

/** The token the picker inserts. */
export function mentionToken(address: string): string {
  return `@(${address})`;
}

/** Every mentioned address, normalised, once each, in order. */
export function mentionsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of scrubPua(body).matchAll(MENTION)) {
    const a = normalize(m[1]);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** Can a token carry this address whole? The picker offers no one it cannot. */
export function tokenizable(address: string): boolean {
  const found = mentionsIn(mentionToken(address));
  return found.length === 1 && found[0] === normalize(address);
}

/** `body` with every mention as `label(address)` and every escape as the literal `@(` — plain text. */
export function withMentionLabels(body: string, label: (address: string) => string): string {
  return scrubPua(body).replace(MENTION, (_m, a: string) => label(normalize(a))).replace(ESCAPED, '@(');
}

/**
 * A comment as one line of plain words, cut to `max`: mentions become their
 * labels FIRST (so a cut never leaves half an address), then the Markdown marks
 * go (a link keeps its text, `snake_case` keeps its underscore).
 */
export function commentSnippet(body: string, label: (address: string) => string, max: number): string {
  return withMentionLabels(body, label)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * The web's first step before Markdown: each mention becomes U+E000 <n> U+E001 —
 * characters Markdown neither reads nor escapes — and each escape its literal
 * `@(`, so the parser never sees an address (an underscore in one cannot pair
 * with another). `addresses[n]` is the n-th mention, normalised.
 */
export function protectMentions(body: string): { text: string; addresses: string[] } {
  const addresses: string[] = [];
  const text = scrubPua(body)
    .replace(MENTION, (_m, a: string) => `\uE000${addresses.push(normalize(a)) - 1}\uE001`)
    .replace(ESCAPED, '@(');
  return { text, addresses };
}

/** The placeholders `protectMentions` left in a piece of parsed text. */
export const PLACEHOLDER = /\uE000(\d+)\uE001/g;

/** A person's name as the server shows it: the address's local part, in words ("ann.lee@acme.com" → "Ann Lee"). */
export function personName(address: string): string {
  const words = normalize(address).split('@')[0].split(/[._+-]+/).filter(Boolean);
  return words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : address;
}
