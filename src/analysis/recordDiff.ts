// What changed between two saves of one record, in a sentence. MAIN, pure.
//
// Version history lists every save with a one-line summary — "Added 1 tile,
// renamed page 2, changed 3 filters". The line is APP-GENERATED from a structural
// diff of the two records, never narrated by a model: it is a fact about two
// JSON documents and the app can state it exactly.
//
// Two jobs, one per export:
//
//   contentOf(type, record)  the fields a version is ABOUT. Timestamps, run
//                            bookkeeping and a visual's favourite star are not
//                            content — a save that only moved them is not a new
//                            version, and a restore must not rewrite them.
//   summarize(type, a, b)    the sentence. `a` null means there is nothing
//                            before this one.
//
// Every comparison is over canonical JSON of sanitized records, so key order
// never produces a phantom change.

// ponytail: records arrive as stored/sanitized JSON of five different shapes;
// each branch reads only the fields it names, so a loose type is the honest one.
type Rec = Record<string, any>;

export type DiffType = 'dataset' | 'visual' | 'dashboard' | 'metric' | 'report';

const CONTENT_KEYS: Record<DiffType, string[]> = {
  dashboard: ['name', 'sheets', 'filters', 'style'],
  visual: ['name', 'chartType', 'encoding', 'overrides', 'filters'],
  metric: ['name', 'definition', 'filters', 'format', 'description', 'direction'],
  report: ['name', 'analysisId', 'format', 'pages', 'cover', 'paper', 'includeFilters', 'narrative', 'schedule'],
  // A dataset's version is its PREPARE PIPELINE. The table is data, not a
  // definition — restoring a version never touches the source Parquet.
  dataset: ['steps'],
};

/** The versioned fields of a record, in a fixed key order. Absent keys stay
 *  absent (a cleared description is a change, not a null). */
export function contentOf(type: DiffType, rec: unknown): Rec {
  const src: Rec = rec && typeof rec === 'object' ? (rec as Rec) : {};
  const out: Rec = {};
  for (const k of CONTENT_KEYS[type]) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  if (type === 'dataset' && !Array.isArray(out.steps)) out.steps = [];
  return out;
}

/** JSON with object keys sorted, so two equal records always stringify equal. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
    const sorted: Rec = {};
    for (const k of Object.keys(val).sort()) sorted[k] = (val as Rec)[k];
    return sorted;
  });
}

export function sameContent(type: DiffType, a: unknown, b: unknown): boolean {
  return canonical(contentOf(type, a)) === canonical(contentOf(type, b));
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

/** Multiset difference of canonical strings: what `b` has that `a` lacks. */
function extra(a: unknown[], b: unknown[]): number {
  const pool = new Map<string, number>();
  for (const x of a) { const k = canonical(x); pool.set(k, (pool.get(k) || 0) + 1); }
  let n = 0;
  for (const x of b) {
    const k = canonical(x);
    const left = pool.get(k) || 0;
    if (left > 0) pool.set(k, left - 1);
    else n++;
  }
  return n;
}

/** "added 2 filters" / "removed 1 filter" / "changed 3 filters", or nothing. */
function listChange(a: unknown[], b: unknown[], noun: string, parts: string[]): void {
  const added = extra(a, b);
  const removed = extra(b, a);
  if (!added && !removed) {
    if (!same(a, b)) parts.push(`reordered ${noun}s`);
    return;
  }
  if (added && !removed) parts.push(`added ${plural(added, noun)}`);
  else if (removed && !added) parts.push(`removed ${plural(removed, noun)}`);
  else parts.push(`changed ${plural(Math.max(added, removed), noun)}`);
}

function humanType(t: unknown): string {
  return String(t || '').replace(/^map_/, 'map ').replace(/_/g, ' ');
}

// ── Per type ─────────────────────────────────────────────────────────────────

function diffDashboard(a: Rec, b: Rec, parts: string[]): void {
  if (a.name !== b.name) parts.push('renamed the dashboard');

  const pa = arr(a.sheets);
  const pb = arr(b.sheets);
  const idsA = new Map(pa.map((p, i) => [p && p.id, i]));
  const idsB = new Map(pb.map((p, i) => [p && p.id, i]));
  const addedPages = pb.map((p, i) => ({ p, i })).filter(({ p }) => !idsA.has(p && p.id));
  const removedPages = pa.map((p, i) => ({ p, i })).filter(({ p }) => !idsB.has(p && p.id));
  const renamedPages = pb.map((p, i) => ({ p, i }))
    .filter(({ p }) => idsA.has(p && p.id) && pa[idsA.get(p.id) as number].name !== p.name);
  const pageWord = (list: { i: number }[], verb: string): void => {
    if (list.length === 1) parts.push(`${verb} page ${list[0].i + 1}`);
    else if (list.length > 1) parts.push(`${verb} ${list.length} pages`);
  };

  // Tiles are matched by card id ACROSS pages, so dragging one to another page
  // is a move, not a remove plus an add.
  const cards = (pages: any[]): Map<string, { c: Rec; page: string }> => {
    const m = new Map<string, { c: Rec; page: string }>();
    for (const p of pages) for (const c of arr(p && p.cards)) if (c && c.id) m.set(c.id, { c, page: p.id });
    return m;
  };
  const ca = cards(pa);
  const cb = cards(pb);
  let added = 0; let removed = 0; let moved = 0; let resized = 0; let edited = 0;
  for (const [id, { c, page }] of cb) {
    const prev = ca.get(id);
    if (!prev) { added++; continue; }
    const la = prev.c.layout || {};
    const lb = c.layout || {};
    if (prev.page !== page || la.x !== lb.x || la.y !== lb.y) moved++;
    else if (la.w !== lb.w || la.h !== lb.h) resized++;
    const { layout: _la, ...restA } = prev.c;
    const { layout: _lb, ...restB } = c;
    if (!same(restA, restB)) edited++;
  }
  for (const id of ca.keys()) if (!cb.has(id)) removed++;
  if (added) parts.push(`added ${plural(added, 'tile')}`);
  if (removed) parts.push(`removed ${plural(removed, 'tile')}`);
  if (edited) parts.push(`edited ${plural(edited, 'tile')}`);
  if (moved) parts.push(`moved ${plural(moved, 'tile')}`);
  if (resized) parts.push(`resized ${plural(resized, 'tile')}`);
  // Tiles first, then pages: a tile is what a reader scans the list for.
  pageWord(addedPages, 'added');
  pageWord(removedPages, 'removed');
  pageWord(renamedPages, 'renamed');
  if (!addedPages.length && !removedPages.length && pa.length === pb.length
      && pa.some((p, i) => pb[i] && p && p.id !== pb[i].id)) parts.push('reordered pages');

  listChange(arr(a.filters), arr(b.filters), 'filter', parts);
  if (!same(a.style, b.style)) parts.push('changed the style');
}

function diffVisual(a: Rec, b: Rec, parts: string[]): void {
  if (a.name !== b.name) parts.push('renamed the visual');
  if (a.chartType !== b.chartType) parts.push(`changed to a ${humanType(b.chartType)} chart`);
  const ea: Rec = a.encoding || {};
  const eb: Rec = b.encoding || {};
  if (ea.category !== eb.category) parts.push(eb.category ? `changed the category to ${eb.category}` : 'removed the category');
  listChange(arr(ea.values), arr(eb.values), 'measure', parts);
  if ((ea.series || '') !== (eb.series || '')) parts.push(eb.series ? `split by ${eb.series}` : 'removed the split');
  if (ea.grain !== eb.grain) parts.push('changed the date grain');
  if (ea.bins !== eb.bins) parts.push('changed the bins');
  if (!same(ea.geo, eb.geo)) parts.push('changed the map level');
  if (!same(ea.pivot, eb.pivot)) parts.push('changed the pivot layout');
  listChange(arr(a.filters), arr(b.filters), 'filter', parts);
  if (!same(a.overrides, b.overrides)) parts.push('changed the styling');
}

function diffMetric(a: Rec, b: Rec, parts: string[]): void {
  if (a.name !== b.name) parts.push('renamed the metric');
  if (!same(a.definition, b.definition)) parts.push('changed the definition');
  listChange(arr(a.filters), arr(b.filters), 'filter', parts);
  if (!same(a.format, b.format)) parts.push('changed the format');
  if ((a.description || '') !== (b.description || '')) parts.push('edited the description');
  if ((a.direction || '') !== (b.direction || '')) parts.push('changed which way is good');
}

function diffReport(a: Rec, b: Rec, parts: string[]): void {
  if (a.name !== b.name) parts.push('renamed the report');
  if (a.analysisId !== b.analysisId) parts.push('pointed it at another dashboard');
  if (a.format !== b.format) parts.push(`changed the format to ${String(b.format || '').toUpperCase()}`);
  const pa = arr(a.pages);
  const pb = arr(b.pages);
  const byId = new Map(pa.map((p) => [p && p.id, p]));
  const ids = new Set(pb.map((p) => p && p.id));
  const added = pb.filter((p) => !byId.has(p && p.id)).length;
  const removed = pa.filter((p) => !ids.has(p && p.id)).length;
  let included = 0; let excluded = 0; let edited = 0;
  for (const p of pb) {
    const prev = byId.get(p && p.id);
    if (!prev) continue;
    if (prev.include !== p.include) { if (p.include) included++; else excluded++; }
    const { include: _ia, ...ra } = prev;
    const { include: _ib, ...rb } = p;
    if (!same(ra, rb)) edited++;
  }
  if (added) parts.push(`added ${plural(added, 'page')}`);
  if (removed) parts.push(`removed ${plural(removed, 'page')}`);
  if (included) parts.push(`included ${plural(included, 'page')}`);
  if (excluded) parts.push(`excluded ${plural(excluded, 'page')}`);
  if (edited) parts.push(`edited ${plural(edited, 'page')}`);
  if (!added && !removed && pa.length === pb.length && pa.some((p, i) => p && pb[i] && p.id !== pb[i].id)) {
    parts.push('reordered pages');
  }
  if (!same(a.cover, b.cover)) parts.push('edited the cover');
  if (!same(a.paper, b.paper)) parts.push('changed the paper');
  if (!same(a.schedule, b.schedule)) parts.push(b.schedule && b.schedule.cadence !== 'off' ? 'changed the schedule' : 'turned off the schedule');
  if (!!a.includeFilters !== !!b.includeFilters) parts.push(b.includeFilters ? 'printed the filters' : 'stopped printing the filters');
  if (!!a.narrative !== !!b.narrative) parts.push(b.narrative ? 'added the narrative page' : 'removed the narrative page');
}

function diffDataset(a: Rec, b: Rec, parts: string[]): void {
  const sa = arr(a.steps);
  const sb = arr(b.steps);
  const calc = (s: Rec): boolean => !!s && s.type === 'calculated_field';
  const addedSteps = sb.filter((s) => extra(sa, [s]) > 0);
  const removedSteps = sa.filter((s) => extra(sb, [s]) > 0);
  // A calculated field keeps its NAME across an edit of its expression, so a
  // same-named add+remove pair is one edit, and says which field.
  const editedCalc = addedSteps.filter((s) => calc(s) && removedSteps.some((r) => calc(r) && r.name === s.name));
  const isEdited = (s: Rec): boolean => editedCalc.some((e) => e.name === s.name);
  const addCalc = addedSteps.filter((s) => calc(s) && !isEdited(s));
  const remCalc = removedSteps.filter((s) => calc(s) && !isEdited(s));
  const addOther = addedSteps.filter((s) => !calc(s));
  const remOther = removedSteps.filter((s) => !calc(s));
  const named = (list: Rec[], verb: string): void => {
    if (list.length === 1) parts.push(`${verb} calculated field ${list[0].name}`);
    else if (list.length > 1) parts.push(`${verb} ${list.length} calculated fields`);
  };
  named(addCalc, 'added');
  named(remCalc, 'removed');
  named(editedCalc, 'edited');
  if (addOther.length && remOther.length) parts.push(`changed ${plural(Math.max(addOther.length, remOther.length), 'step')}`);
  else if (addOther.length) parts.push(`added ${plural(addOther.length, 'step')}`);
  else if (remOther.length) parts.push(`removed ${plural(remOther.length, 'step')}`);
  if (!addedSteps.length && !removedSteps.length && !same(sa, sb)) parts.push('reordered steps');
}

const DIFFERS: Record<DiffType, (a: Rec, b: Rec, parts: string[]) => void> = {
  dashboard: diffDashboard,
  visual: diffVisual,
  metric: diffMetric,
  report: diffReport,
  dataset: diffDataset,
};

/** How many clauses a line carries before the rest become "and N more". */
const MAX_PARTS = 3;

/**
 * The one-line summary of what `next` changed against `prev`.
 * "Added 1 tile, renamed page 2, changed 3 filters".
 */
export function summarize(type: DiffType, prev: unknown, next: unknown): string {
  if (prev === null || prev === undefined) {
    return type === 'dataset' ? 'First saved pipeline' : 'First saved version';
  }
  const parts: string[] = [];
  DIFFERS[type](contentOf(type, prev), contentOf(type, next), parts);
  if (!parts.length) return 'No changes';
  const shown = parts.length > MAX_PARTS + 1 ? parts.slice(0, MAX_PARTS) : parts;
  let line = shown.join(', ');
  if (shown.length < parts.length) line += ` and ${plural(parts.length - shown.length, 'more change')}`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}
