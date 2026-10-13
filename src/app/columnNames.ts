// The names people call a column — PURE: no fs, no model, no imports.
//
// A column has the name it is stored under, the display name the catalog gives
// it, and an "Also called" list (`ColumnDoc.aliases`, ./catalog.ts): the words
// people actually ask with ("sales" for net_amount). This file is the rules for
// those names: what a stored list looks like, when a new name is refused, and
// how a name someone said finds the column it was taught for — the last two
// passes of the answer spec's resolver (src/ai/answerSpec.ts `resolveColumn`).

/**
 * Case, spaces, underscores and punctuation are not part of a name's identity
 * to a reader; its letters and digits are — in ANY script. "売上 (USD)" and
 * "利益 (USD)" are two names, not one "usd". NFKC first, so a full-width or
 * decomposed spelling is the same name; combining marks are kept (in Devanagari
 * or Thai they are the vowels). For an ASCII name this is the old a-z0-9 rule.
 */
export function squash(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

export const MAX_ALIASES = 8;
export const MAX_ALIAS_LEN = 60;

/** A column as its names: the stored one and what people taught for it. */
export interface NamedColumn {
  name: string;
  displayName?: string;
  aliases?: string[];
}

/**
 * An "Also called" list as it is stored: each name trimmed with its inner
 * whitespace collapsed and cut to MAX_ALIAS_LEN, no empties, no repeats
 * (ignoring case), never the column's own name, at most MAX_ALIASES. A comma
 * separates names — the field is typed as one comma-separated line — so a
 * stored name never holds one.
 */
export function sanitizeAliases(raw: unknown, column: string): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const seen = new Set<string>([column.trim().toLowerCase()]);
  const out: string[] = [];
  for (const item of list) {
    for (const part of typeof item === 'string' ? item.split(',') : []) {
      const alias = part.replace(/\s+/g, ' ').trim().slice(0, MAX_ALIAS_LEN).trim();
      const key = alias.toLowerCase();
      if (!alias || seen.has(key)) continue;
      seen.add(key);
      out.push(alias);
      if (out.length >= MAX_ALIASES) return out;
    }
  }
  return out;
}

/** Two names a reader would take for the same one: equal ignoring case, or equal squashed (letters and digits only, in any script). */
function sameName(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const key = squash(a);
  return key !== '' && key === squash(b);
}

/**
 * The first of `aliases` that ANOTHER column of the dataset already answers to
 * — by its name, its display name or one of its own aliases — or null.
 *
 * The one collision rule, enforced where an alias is written
 * (catalog.setColumn): a name that meant two columns would resolve to neither,
 * so teaching it would silently un-teach it. `others` is every column of the
 * dataset except the one being named.
 */
export function aliasCollision(aliases: string[], others: NamedColumn[]): { alias: string; column: NamedColumn } | null {
  for (const alias of aliases) {
    for (const column of others) {
      const taken = [column.name, column.displayName || '', ...(column.aliases || [])].filter(Boolean);
      if (taken.some((name) => sameName(alias, name))) return { alias, column };
    }
  }
  return null;
}

/**
 * The column of `columns` people mean by a TAUGHT name, or null: equal ignoring
 * case first, then squashed. Each pass must be UNAMBIGUOUS — a name two columns
 * answer to resolves to neither, because picking one is a guess. A name filed
 * under something that is not a column of `columns` matches nothing. Run by
 * answerSpec.resolveColumn only after the real column names found no match.
 */
export function taughtColumn<C extends { name: string }>(said: string, columns: C[], names: Record<string, string[]>): C | null {
  const n = said.trim().toLowerCase();
  const key = squash(n);
  const called = (same: (taught: string) => boolean): C[] =>
    columns.filter((c) => Object.prototype.hasOwnProperty.call(names, c.name) && names[c.name].some(same));
  const exact = called((taught) => taught.trim().toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const loose = key ? called((taught) => squash(taught) === key) : [];
  return loose.length === 1 ? loose[0] : null;
}

/**
 * column → the names people taught for it (display name first, then "Also
 * called"), for the columns the dataset HAS NOW. A catalog doc is filed under
 * the column's name when it was written; one left under an old name by a later
 * rename step names nothing here.
 */
export function taughtNames(
  columns: Array<{ name: string }>,
  docs: Record<string, Pick<NamedColumn, 'displayName' | 'aliases'>> | undefined,
): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  if (!docs) return out;
  for (const c of columns) {
    if (!Object.prototype.hasOwnProperty.call(docs, c.name)) continue;
    const said = [docs[c.name].displayName || '', ...(docs[c.name].aliases || [])].filter(Boolean);
    if (said.length) out[c.name] = said;
  }
  return out;
}
