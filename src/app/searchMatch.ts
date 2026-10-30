// What a ⌘K name search MATCHES and in what ORDER — pure, no I/O. Both answers use it: the
// index (src/server/searchIndex.ts, a GIN index over the words below) and the reference
// that reads every list (src/ipc/search.ts searchNames); scripts/test-searchIndex.ts holds
// them equal.
//
//   words   a name's lower-cased runs of letters, digits and marks: "INV-2041" is inv · 2041,
//           "Sales – West" is sales · west. Computed HERE, never by Postgres's parser, so
//           the index holds exactly these (array_to_tsvector) and both paths agree.
//   match   every word typed is the start of some word in the name: "sal" finds "Sales",
//           "west sales" finds "Sales – West". Not mid-word: "ales" does not.
//   rank    0 the whole name, 1 the name starts with what was typed, 2 the rest.
//   order   rank, then newest first, then the sidebar's section order, then the record,
//           then its place in the record (a dashboard before its saved views).

/** Code points per word, and words per name: bounded so a tsvector lexeme can never be refused. */
const MAX_WORD = 64;
const MAX_WORDS = 64;

/** Postgres text holds no NUL and no lone surrogate (the driver would write U+FFFD): both paths see the same string. */
export function clean(s: string): string {
  return s.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

export function wordsOf(text: string): string[] {
  return clean(text).toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean).slice(0, MAX_WORDS)
    .map((w) => Array.from(w).slice(0, MAX_WORD).join(''));
}

/** What was typed, as the rank compares it: cleaned, trimmed, lower-cased. */
export function needleOf(query: string): string {
  return clean(query).trim().toLowerCase();
}

export function matches(nameWords: readonly string[], typed: readonly string[]): boolean {
  return typed.length > 0 && typed.every((t) => nameWords.some((w) => w.startsWith(t)));
}

export function rankOf(nameLc: string, needle: string): 0 | 1 | 2 {
  return nameLc === needle ? 0 : nameLc.startsWith(needle) ? 1 : 2;
}

/** The words as a tsquery of prefixes. A word is letters, digits and marks only, so it cannot close its quotes. */
export function tsqueryOf(typed: readonly string[]): string {
  return typed.map((t) => `'${t}':*`).join(' & ');
}

/** The keys an answer is ordered by — the SQL's ORDER BY, written once more here. */
export interface OrderKeys {
  rank: number;
  updated: string;
  srcOrd: number;
  rec: string;
  ord: number;
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareKeys(a: OrderKeys, b: OrderKeys): number {
  return a.rank - b.rank || byCode(b.updated, a.updated) || a.srcOrd - b.srcOrd || byCode(a.rec, b.rec) || a.ord - b.ord;
}
