// NOTEBOOKS — view names, the dependency graph, staleness and cache keys.
// MAIN PROCESS, PURE: no fs, no engine call. scripts/test-notebooks.ts
// asserts every rule here directly.
//
// ── VIEW NAMES ───────────────────────────────────────────────────────────────
// Every SQL cell is a table the cells BELOW it can query. Its name is its
// title, slugged exactly as a dataset's slug is (sqlNames.slugify: lower-case
// [a-z0-9_], a leading digit gets `_`, a reserved word gets a trailing `_`),
// or `cell_<1-based position>` when it has no title. Names are claimed top to
// bottom; a name already taken — by a dataset's exposed name or slug, or by an
// earlier cell — takes `_2`, `_3`… So a cell can never shadow a dataset, and
// a dataset can never be shadowed by a cell.
//
// ── THE GRAPH ────────────────────────────────────────────────────────────────
// Built from what the cells SAY, never from what last ran:
//   sql      the earlier SQL cells whose view names its tokens name (sqlLex —
//            strings and comments do not count), and the parameter cells whose
//            `[[name]]` it binds (params.bindSqlParams — the binder itself)
//   formula  the nearest SQL or formula cell above it, and the parameters it reads
//   chart    the cell it charts (an earlier SQL or formula cell)
// A reference can only point UP, so the graph is acyclic by construction.
//
// ── STALENESS ────────────────────────────────────────────────────────────────
// Each cell's `sig` hashes its own content with the sigs of everything it
// reads. Editing a cell changes its sig, which changes the sig of every cell
// downstream of it — and a result remembers the sig it was computed under, so
// "stale" is just `result.sig !== graph.sig`. No walk, no flags to clear.
//
// ── CACHE KEYS ───────────────────────────────────────────────────────────────
// sha256 of what a RESULT depends on: the resolved SQL (with every inlined
// upstream view) and its bound parameter values, each input cell's result key,
// and each dataset it reads with its `updatedAt`. Sorted-key JSON, so the same
// inputs in another order are the same key.

import { createHash } from 'crypto';
import { lexSql } from '../../engine/sqlLex';
import { slugify } from '../../engine/sqlNames';
import { stableStringify } from '../../engine/queryCache';
import { bindSqlParams, paramRefs } from '../params';
import type { SqlParam } from '../params';
import type { NbCell, ParamCell } from './model';
import { ctx } from '../../server/context';

export interface CellInfo {
  id: string;
  kind: NbCell['kind'];
  /** 1-based, as the gutter shows it. */
  position: number;
  /** SQL cells only: the name later cells query it by. */
  view: string | null;
  /** Cell ids this one reads, top to bottom (parameters included). */
  deps: string[];
  sig: string;
  /** A problem visible without running anything — the cell will not run until it is fixed. */
  error: string | null;
}

export interface NotebookGraph {
  cells: CellInfo[];
}

const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const short = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 16);

/**
 * Each SQL cell's view name. `reserved` holds every name a DATASET is exposed
 * under (exact name and slug); nothing here may take one.
 */
export function assignCellViews(cells: readonly NbCell[], reserved: Iterable<string>): Map<string, string> {
  const taken = new Set<string>();
  for (const r of reserved) taken.add(fold(String(r)));
  const out = new Map<string, string>();
  cells.forEach((c, i) => {
    if (c.kind !== 'sql') return;
    const t = (c.title || '').trim();
    const base = /[A-Za-z0-9]/.test(t) ? slugify(t) : `cell_${i + 1}`;
    let name = base;
    for (let k = 2; taken.has(name); k += 1) name = `${base}_${k}`;
    taken.add(name);
    out.set(c.id, name);
  });
  return out;
}

/** The parameter list `bindSqlParams` takes, from the parameter cells above: names only matter here. */
function probeParams(above: Map<string, ParamCell>): SqlParam[] {
  const dummy = { number: 0, text: '', date: '2000-01-01' } as const;
  return [...above.values()].map((p) => ({ name: p.name, kind: p.type, value: dummy[p.type] }));
}

/** The graph over `cells`, given the names the project's datasets hold. */
export function analyzeNotebook(cells: readonly NbCell[], reserved: Iterable<string> = []): NotebookGraph {
  const views = assignCellViews(cells, reserved);
  const allViews = new Map<string, string>(); // view → cell id, every SQL cell
  for (const [id, v] of views) allViews.set(v, id);
  const above = new Map<string, string>(); // view → cell id, the SQL cells ABOVE the current one
  const params = new Map<string, ParamCell>(); // lower-cased name → the cell that defines it
  const sig = new Map<string, string>();
  const out: CellInfo[] = [];

  cells.forEach((c, i) => {
    const info: CellInfo = { id: c.id, kind: c.kind, position: i + 1, view: views.get(c.id) ?? null, deps: [], sig: '', error: null };
    const fail = (msg: string): void => { if (!info.error) info.error = msg; };
    const dep = (id: string): void => { if (!info.deps.includes(id)) info.deps.push(id); };
    const readParams = (names: string[]): void => {
      for (const n of names) {
        const p = params.get(n.toLowerCase());
        if (p) dep(p.id);
        else fail(`[[${n}]] has no parameter cell above it.`);
      }
    };

    switch (c.kind) {
      case 'param': {
        const key = c.name.toLowerCase();
        if (!c.name) fail('Name the parameter — later cells read it as [[name]].');
        else if (params.has(key)) fail(`[[${c.name}]] is already defined above; this one is ignored.`);
        else params.set(key, c);
        info.sig = short({ k: 'param', name: c.name, type: c.type, value: c.value });
        break;
      }
      case 'markdown':
        info.sig = short({ k: 'md', text: c.text });
        break;
      case 'sql': {
        if (!c.sql.trim()) fail('Write a query first.');
        for (const t of lexSql(c.sql)) {
          if (t.kind !== 'word' && t.kind !== 'qid') continue;
          const f = fold(t.text);
          if (f === info.view) fail(`A cell cannot read its own view (${info.view}).`);
          else if (above.has(f)) dep(above.get(f) as string);
          else if (allViews.has(f)) fail(`${f} is a cell below this one — move this cell under it.`);
          // A titled cell is queried by its title: `cell_2` then names nothing.
          else if (/^cell_\d+$/.test(f)) fail(`No cell above is called ${f} — a cell with a title is queried by its title.`);
        }
        const bound = bindSqlParams(c.sql, probeParams(params));
        if ('error' in bound) {
          const m = /^\[\[([A-Za-z_][A-Za-z0-9_]*)\]\] is not defined/.exec(bound.error);
          fail(m ? `[[${m[1]}]] has no parameter cell above it.` : bound.error);
        } else readParams(bound.used);
        info.sig = short({ k: 'sql', sql: c.sql, in: info.deps.map((d) => sig.get(d)) });
        break;
      }
      case 'formula': {
        let input: NbCell | undefined;
        for (let j = i - 1; j >= 0 && !input; j -= 1) if (cells[j].kind === 'sql' || cells[j].kind === 'formula') input = cells[j];
        if (input) dep(input.id);
        else fail('A formula reads the result of the cell above it — add a SQL cell first.');
        if (!c.expression.trim()) fail('Write a formula first.');
        readParams(paramRefs(c.expression));
        info.sig = short({ k: 'formula', expression: c.expression, column: c.column, in: info.deps.map((d) => sig.get(d)) });
        break;
      }
      case 'chart': {
        const j = cells.findIndex((x) => x.id === c.sourceCellId);
        if (j < 0 || j >= i || (cells[j].kind !== 'sql' && cells[j].kind !== 'formula')) {
          fail('Choose a SQL or formula cell above this one to chart.');
        } else dep(c.sourceCellId);
        if (!info.error && (!c.encoding.category || !c.encoding.values.length)) fail('Choose a category and a measure to chart first.');
        info.sig = short({ k: 'chart', type: c.chartType, enc: c.encoding, in: info.deps.map((d) => sig.get(d)) });
        break;
      }
    }
    sig.set(c.id, info.sig);
    if (info.view) above.set(info.view, c.id);
    out.push(info);
  });
  return { cells: out };
}

/** The cells whose last result was computed under a different sig — stale. */
export function staleIds(graph: NotebookGraph, lastSigs: Record<string, string>): string[] {
  return graph.cells.filter((c) => typeof lastSigs[c.id] === 'string' && lastSigs[c.id] !== c.sig).map((c) => c.id);
}

/** Every cell `id` reads, transitively, top to bottom. */
export function upstreamOf(graph: NotebookGraph, id: string): string[] {
  const byId = new Map(graph.cells.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const visit = (x: string): void => {
    for (const d of byId.get(x)?.deps || []) {
      if (!seen.has(d)) { seen.add(d); visit(d); }
    }
  };
  visit(id);
  return graph.cells.filter((c) => seen.has(c.id)).map((c) => c.id);
}

/** Every cell downstream of `id` (what an edit to it makes stale). */
export function downstreamOf(graph: NotebookGraph, id: string): string[] {
  return graph.cells.filter((c) => c.id !== id && upstreamOf(graph, c.id).includes(id)).map((c) => c.id);
}

export interface CacheKeyParts {
  kind: NbCell['kind'];
  /** The resolved text: every inlined view's SQL then the cell's own, or the formula, or the chart spec. */
  text: unknown;
  /** The parameter values it bound, by name. */
  params?: Record<string, unknown>;
  /** Each input cell's result key. */
  inputs?: string[];
  /** Each dataset it reads, with the version stamp that moves on every write. */
  datasets?: Array<{ id: string; updatedAt: string }>;
}

/** The result cache's key — sha256 hex. */
export function cellCacheKey(p: CacheKeyParts): string {
  const datasets = (p.datasets || []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256')
    .update(stableStringify({ org: ctx().org.id, kind: p.kind, text: p.text, params: p.params || {}, inputs: p.inputs || [], datasets }))
    .digest('hex');
}
