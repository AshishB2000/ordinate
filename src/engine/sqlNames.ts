// Which identifiers a dataset is exposed under, and which datasets a query
// names — MAIN PROCESS, pure. Split out of sqlDatasets.ts (file-size.md); that
// file runs queries, this one only decides names.
//
// Identifier equality is DuckDB's: ASCII-case-insensitive, even quoted
// (`datasetView.foldKey`, measured there), so "Sales" and "sales" are one name.

import { foldKey } from './datasetView';
import { lexSql } from './sqlLex';

// ── Names ────────────────────────────────────────────────────────────────────

// DuckDB's reserved words (duckdb_keywords(), 'reserved' + 'type_function'),
// so a dataset called "Order" gets the slug `order_`, which works unquoted.
const RESERVED: ReadonlySet<string> = new Set((
  'all analyse analyze and anti any array as asc asof asymmetric authorization binary both case cast check '
  + 'collate collation column concurrently constraint create cross default deferrable desc describe distinct do '
  + 'else end except false fetch for foreign freeze from full glob grant group having ilike in initially inner '
  + 'intersect into is isnull join lateral leading left like limit natural not notnull null offset on only or '
  + 'order outer overlaps pivot pivot_longer pivot_wider placing positional primary qualify references returning '
  + 'right select semi show similar some summarize symmetric table tablesample then to trailing true union unique '
  + 'unpivot using variadic verbose when where window with'
).split(' '));

/** `Retail orders 2024` → `retail_orders_2024`; `2024 sales` → `_2024_sales`. */
export function slugify(name: string): string {
  let s = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60).replace(/^_+|_+$/g, '');
  if (!s) s = 'dataset';
  if (/^[0-9]/.test(s)) s = '_' + s;
  if (RESERVED.has(s)) s += '_';
  return s;
}

/**
 * Each dataset's exposed names: its exact name as `alias` (null when an OLDER
 * dataset already holds it — DuckDB compares identifiers ASCII-case-
 * insensitively, so "Sales" and "sales" are one name) and a unique `slug`.
 * Exact names are claimed first, oldest first, then slugs take `_2`, `_3`… so
 * a new import never renames an existing dataset's table.
 * ponytail: deleting an OLDER namesake can shift a younger one's suffix; a
 * saved query naming `sales_2` would then fail loudly, never read the wrong table.
 */
export function assignViewNames(
  list: Array<{ id: string; name: string; createdAt?: string }>,
): Map<string, { alias: string | null; slug: string }> {
  const order = list.slice().sort((a, b) => {
    const ca = a.createdAt || '';
    const cb = b.createdAt || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const taken = new Set<string>();
  const alias = new Map<string, string | null>();
  for (const d of order) {
    const name = typeof d.name === 'string' ? d.name : '';
    const key = foldKey(name);
    if (!name || name.includes('\0') || taken.has(key)) {
      alias.set(d.id, null);
      continue;
    }
    taken.add(key);
    alias.set(d.id, name);
  }
  const out = new Map<string, { alias: string | null; slug: string }>();
  for (const d of order) {
    const a = alias.get(d.id) ?? null;
    const base = slugify(d.name);
    let slug = base;
    // A slug equal to the dataset's OWN exact name is the same identifier.
    if (a === null || foldKey(a) !== slug) {
      for (let k = 2; taken.has(slug); k += 1) slug = `${base}_${k}`;
      taken.add(slug);
    }
    out.set(d.id, { alias: a, slug });
  }
  return out;
}

/**
 * The datasets `sql` names, as ids, in first-reference order. Every bare word
 * and quoted identifier outside strings and comments is matched, ASCII-case-
 * insensitively, against the exposed names. A user CTE or a column that happens
 * to share a dataset's name counts too — the cost is one unused CTE.
 */
export function extractDeps(
  sql: string,
  entries: ReadonlyArray<{ id: string; alias: string | null; slug: string }>,
): string[] {
  const byKey = new Map<string, string>();
  for (const e of entries) {
    if (e.alias) byKey.set(foldKey(e.alias), e.id);
    byKey.set(foldKey(e.slug), e.id);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of lexSql(sql)) {
    if (t.kind !== 'word' && t.kind !== 'qid') continue;
    const id = byKey.get(foldKey(t.text));
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
