// The pieces of a version diff that are not a dashboard's cards — MAIN, pure:
// filters, an inline word diff, and the four other record types a history
// covers (visual, metric, report, dataset pipeline). See ./versionDiff.ts.
// Structured items only; versionDiffMessages.ts words them.

import { canonical } from './recordDiff';
import { describeDefinitionShort, describeFilter } from './metricFormat';
import type { FilterStep } from '../data/transforms';
import type { MetricDefinition } from './metrics';

// ponytail: version records are stored JSON of five shapes, read field by field
export type Rec = Record<string, any>;

export type ChangeKind =
  | 'name' | 'style' | 'description'
  | 'sheet.added' | 'sheet.removed' | 'sheet.renamed' | 'sheet.reordered'
  | 'filter.added' | 'filter.removed' | 'filter.changed'
  | 'card.added' | 'card.removed' | 'card.movedSheet' | 'card.movedRow' | 'card.movedWithin' | 'card.resized'
  | 'card.type' | 'card.renamed' | 'card.visualSwapped' | 'card.chartType' | 'card.encoding' | 'card.visualFilters'
  | 'card.actions' | 'card.measure' | 'card.savedMetric' | 'card.dataset' | 'card.format' | 'card.compare'
  | 'card.calc' | 'card.scenario' | 'card.text' | 'card.control' | 'card.settings'
  | 'visual.chartType' | 'visual.category' | 'visual.series' | 'visual.measureAdded' | 'visual.measureRemoved'
  | 'visual.grain' | 'visual.bins' | 'visual.geo' | 'visual.pivot' | 'visual.styling'
  | 'metric.definition' | 'metric.format' | 'metric.direction'
  | 'report.format' | 'report.dashboard' | 'report.pagesAdded' | 'report.pagesRemoved' | 'report.pagesIncluded'
  | 'report.pagesExcluded' | 'report.pagesEdited' | 'report.pagesReordered' | 'report.cover' | 'report.paper'
  | 'report.schedule' | 'report.includeFilters' | 'report.narrative'
  | 'step.added' | 'step.removed' | 'step.reordered' | 'table.columns' | 'table.rowsAdded' | 'table.rowsRemoved' | 'table.cells';

export interface WordPiece {
  op: 'same' | 'add' | 'del';
  text: string;
}

export interface Change {
  group: 'record' | 'sheets' | 'filters' | 'cards';
  kind: ChangeKind;
  cardId?: string;
  /** Names, labels and finished strings only — never a figure. */
  params: Record<string, string | number>;
  /** A text edit, word by word. */
  words?: WordPiece[];
}

const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object') : []);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
/** What an absent value prints as: a dash reads the same in every language. */
const NONE = '—';

// ── Word diff ────────────────────────────────────────────────────────────────

/** Past this many words a side, the LCS table (n×m) is not worth it: one removed run, one added run. */
const MAX_WORDS = 400;

/** Word-level diff by longest common subsequence; adjacent pieces of one op merged. */
export function wordDiff(a: string, b: string): WordPiece[] {
  const A = a.split(/\s+/).filter(Boolean);
  const B = b.split(/\s+/).filter(Boolean);
  const out: WordPiece[] = [];
  const emit = (op: WordPiece['op'], w: string): void => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += ' ' + w;
    else out.push({ op, text: w });
  };
  if (A.length > MAX_WORDS || B.length > MAX_WORDS) {
    if (A.length) emit('del', A.join(' '));
    if (B.length) emit('add', B.join(' '));
    return out;
  }
  const n = A.length;
  const m = B.length;
  // lcs[i][j] = LCS length of A[i..] and B[j..], flattened.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = A[i] === B[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { emit('same', A[i]); i++; j++; }
    else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) emit('del', A[i++]);
    else emit('add', B[j++]);
  }
  while (i < n) emit('del', A[i++]);
  while (j < m) emit('add', B[j++]);
  return out;
}

// ── Filters ──────────────────────────────────────────────────────────────────

const filterText = (f: Rec): string => describeFilter(f as FilterStep);

/**
 * Filter steps matched by column: one step per column on each side whose step
 * differs is a change; the rest are added or removed. Order is not a change —
 * every filter applies, whatever its position.
 */
export function diffFilters(a: Rec[], b: Rec[]): Change[] {
  const out: Change[] = [];
  const left = a.filter((f) => !b.some((g) => same(f, g)));
  const right = b.filter((f) => !a.some((g) => same(f, g)));
  const used = new Set<Rec>();
  for (const f of right) {
    const col = String(f.column || '');
    const prev = left.find((g) => !used.has(g) && String(g.column || '') === col);
    if (prev && left.filter((g) => String(g.column || '') === col).length === 1 && right.filter((g) => String(g.column || '') === col).length === 1) {
      used.add(prev);
      out.push({ group: 'filters', kind: 'filter.changed', params: { column: col, from: filterText(prev), to: filterText(f) } });
    } else {
      out.push({ group: 'filters', kind: 'filter.added', params: { filter: filterText(f) } });
    }
  }
  for (const f of left) if (!used.has(f)) out.push({ group: 'filters', kind: 'filter.removed', params: { filter: filterText(f) } });
  return out;
}

// ── The other four record types ──────────────────────────────────────────────

function diffVisual(a: Rec, b: Rec, out: Change[]): void {
  const rec = (kind: ChangeKind, params: Change['params'] = {}): void => { out.push({ group: 'record', kind, params }); };
  if ((a.name || '') !== (b.name || '')) rec('name', { from: String(a.name || ''), to: String(b.name || '') });
  if (a.chartType !== b.chartType) rec('visual.chartType', { from: String(a.chartType || ''), to: String(b.chartType || '') });
  const ea: Rec = a.encoding || {};
  const eb: Rec = b.encoding || {};
  if ((ea.category || '') !== (eb.category || '')) rec('visual.category', { from: String(ea.category || NONE), to: String(eb.category || NONE) });
  const m = (v: Rec): string => `${String(v.aggregation || 'sum')}(${String(v.column || '')})`;
  const va = arr(ea.values).map(m);
  const vb = arr(eb.values).map(m);
  for (const x of vb) if (!va.includes(x)) rec('visual.measureAdded', { measure: x });
  for (const x of va) if (!vb.includes(x)) rec('visual.measureRemoved', { measure: x });
  if ((ea.series || '') !== (eb.series || '')) rec('visual.series', { from: String(ea.series || NONE), to: String(eb.series || NONE) });
  if (ea.grain !== eb.grain) rec('visual.grain');
  if (ea.bins !== eb.bins) rec('visual.bins');
  if (!same(ea.geo, eb.geo)) rec('visual.geo');
  if (!same(ea.pivot, eb.pivot)) rec('visual.pivot');
  out.push(...diffFilters(arr(a.filters), arr(b.filters)));
  if (!same(a.overrides, b.overrides)) rec('visual.styling');
}

function diffMetric(a: Rec, b: Rec, out: Change[]): void {
  const rec = (kind: ChangeKind, params: Change['params'] = {}, words?: WordPiece[]): void => {
    out.push({ group: 'record', kind, params, ...(words ? { words } : {}) });
  };
  if ((a.name || '') !== (b.name || '')) rec('name', { from: String(a.name || ''), to: String(b.name || '') });
  if (!same(a.definition, b.definition)) {
    const d = (x: unknown): string => (x && typeof x === 'object' ? describeDefinitionShort(x as MetricDefinition) : NONE);
    rec('metric.definition', { from: d(a.definition), to: d(b.definition) });
  }
  out.push(...diffFilters(arr(a.filters), arr(b.filters)));
  if (!same(a.format, b.format)) rec('metric.format');
  const da = String(a.description || '');
  const db = String(b.description || '');
  if (da !== db) rec('description', {}, wordDiff(da, db));
  if ((a.direction || '') !== (b.direction || '')) rec('metric.direction');
}

function diffReport(a: Rec, b: Rec, out: Change[]): void {
  const rec = (kind: ChangeKind, params: Change['params'] = {}): void => { out.push({ group: 'record', kind, params }); };
  if ((a.name || '') !== (b.name || '')) rec('name', { from: String(a.name || ''), to: String(b.name || '') });
  if ((a.analysisId || '') !== (b.analysisId || '')) rec('report.dashboard');
  if ((a.format || '') !== (b.format || '')) rec('report.format', { from: String(a.format || NONE).toUpperCase(), to: String(b.format || NONE).toUpperCase() });
  const pa = arr(a.pages);
  const pb = arr(b.pages);
  const byId = new Map(pa.map((p) => [p.id, p]));
  const ids = new Set(pb.map((p) => p.id));
  const count = { added: 0, removed: pa.filter((p) => !ids.has(p.id)).length, included: 0, excluded: 0, edited: 0 };
  for (const p of pb) {
    const prev = byId.get(p.id);
    if (!prev) { count.added++; continue; }
    if (!!prev.include !== !!p.include) { if (p.include) count.included++; else count.excluded++; }
    const { include: _ia, ...ra } = prev;
    const { include: _ib, ...rb } = p;
    if (!same(ra, rb)) count.edited++;
  }
  if (count.added) rec('report.pagesAdded', { n: count.added });
  if (count.removed) rec('report.pagesRemoved', { n: count.removed });
  if (count.included) rec('report.pagesIncluded', { n: count.included });
  if (count.excluded) rec('report.pagesExcluded', { n: count.excluded });
  if (count.edited) rec('report.pagesEdited', { n: count.edited });
  const order = (list: Rec[], keep: Set<unknown>): unknown[] => list.map((p) => p.id).filter((id) => keep.has(id));
  if (!same(order(pa, ids), order(pb, new Set(byId.keys())))) rec('report.pagesReordered');
  if (!same(a.cover, b.cover)) rec('report.cover');
  if (!same(a.paper, b.paper)) rec('report.paper');
  if (!same(a.schedule, b.schedule)) rec('report.schedule');
  if (!!a.includeFilters !== !!b.includeFilters) rec('report.includeFilters');
  if (!!a.narrative !== !!b.narrative) rec('report.narrative');
}

/** A prepare step in a few words: the field it makes, the filter it applies, else its kind. */
function stepText(s: Rec): string {
  if (s.type === 'calculated_field') return String(s.name || '');
  if (s.type === 'filter') return filterText(s);
  return String(s.type || '').replace(/_/g, ' ');
}

function diffDataset(a: Rec, b: Rec, out: Change[]): void {
  const rec = (kind: ChangeKind, params: Change['params'] = {}): void => { out.push({ group: 'record', kind, params }); };
  const sa = arr(a.steps);
  const sb = arr(b.steps);
  const added = sb.filter((s) => !sa.some((x) => same(x, s)));
  const removed = sa.filter((s) => !sb.some((x) => same(x, s)));
  for (const s of added) rec('step.added', { step: stepText(s) });
  for (const s of removed) rec('step.removed', { step: stepText(s) });
  if (!added.length && !removed.length && !same(sa, sb)) rec('step.reordered');
  const ta: Rec | undefined = a.table;
  const tb: Rec | undefined = b.table;
  if (!ta || !tb) return;
  if (!same(arr(ta.columns).map((c) => c.name), arr(tb.columns).map((c) => c.name))) { rec('table.columns'); return; }
  const ra = Array.isArray(ta.rows) ? ta.rows : [];
  const rb = Array.isArray(tb.rows) ? tb.rows : [];
  if (rb.length > ra.length) rec('table.rowsAdded', { n: rb.length - ra.length });
  else if (rb.length < ra.length) rec('table.rowsRemoved', { n: ra.length - rb.length });
  else {
    let cells = 0;
    ra.forEach((row: unknown, r: number) => {
      const x = Array.isArray(row) ? row : [];
      const y = Array.isArray(rb[r]) ? rb[r] : [];
      for (let c = 0; c < Math.max(x.length, y.length); c++) if (!same(x[c] ?? null, y[c] ?? null)) cells++;
    });
    if (cells) rec('table.cells', { n: cells });
  }
}

/** Every change between two contents of a non-dashboard record, in a fixed order. */
export function diffOther(type: 'visual' | 'metric' | 'report' | 'dataset', a: Rec, b: Rec): Change[] {
  const out: Change[] = [];
  if (type === 'visual') diffVisual(a, b, out);
  else if (type === 'metric') diffMetric(a, b, out);
  else if (type === 'report') diffReport(a, b, out);
  else diffDataset(a, b, out);
  return out;
}
