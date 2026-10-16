// What changed between two saved versions of a record, STRUCTURALLY — MAIN, pure.
//
// recordDiff.summarize writes the one line a history row shows; this module is
// the compare view behind it (docs/version-diff/00-design.md): every change as a
// structured item, a layout pair per sheet with each tile classified, and the KPI
// cards whose figure may have moved. No sentence is written here — the handler
// words each item through the catalog (versionDiffMessages.ts) — and no figure is
// computed here: `figures` only names which cards to ask the engine about.
//
// Cards are matched by id ACROSS sheets, so a card dragged to another sheet is a
// move. A card without an id (an old or hand-made snapshot; sanitized records
// always have one) is matched by type + title, then by occurrence.

import { canonical, contentOf, type DiffType } from './recordDiff';
import { diffFilters, diffOther, wordDiff, type Change, type Rec } from './versionDiffParts';
import type { CardMetric } from './dashboards';

export type { Change, ChangeKind, WordPiece } from './versionDiffParts';

export type TileStatus = 'same' | 'added' | 'removed' | 'changed' | 'moved';

export interface DiffTile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  type: string;
  status: TileStatus;
}

/** One sheet's layout on each side; null where the sheet is absent. */
export interface SheetPair {
  id: string;
  name: string;
  before: DiffTile[] | null;
  after: DiffTile[] | null;
  changed: boolean;
}

/** A KPI card whose figure may have moved: the engine computes each side. */
export interface FigureAsk {
  cardId: string;
  title: string;
  reason: 'measure' | 'filters' | 'added' | 'removed';
  before: CardMetric | null;
  after: CardMetric | null;
}

export interface Counts {
  changed: number;
  added: number;
  removed: number;
  moved: number;
  filters: number;
  other: number;
}

export interface StructDiff {
  counts: Counts;
  changes: Change[];
  sheets: SheetPair[];
  figures: FigureAsk[];
}

/** Names a card for a sentence (visual names live on the Visual record, so the caller resolves them). */
export type TitleOf = (card: Rec) => string;

const MAX_FIGURES = 12;

const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object') : []);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

interface Placed {
  card: Rec;
  sheet: Rec;
  key: string;
}

/** Every card of every sheet under its matching key. */
function placed(sheets: Rec[], titleOf: TitleOf): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const seen = new Map<string, number>();
  for (const sheet of sheets) {
    for (const card of arr(sheet.cards)) {
      let key: string;
      if (typeof card.id === 'string' && card.id) key = 'id:' + card.id;
      else {
        const base = `t:${String(card.type || '')}\u0000${titleOf(card)}`;
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        key = `${base}\u0000${n}`;
      }
      if (!out.has(key)) out.set(key, { card, sheet, key });
    }
  }
  return out;
}

/** 1-based row: the card's rank among its sheet's distinct tops — what a reader counts. */
function rowOf(card: Rec, sheet: Rec): number {
  const tops = [...new Set(arr(sheet.cards).map((c) => num(c.layout && c.layout.y, 0)))].sort((a, b) => a - b);
  return tops.indexOf(num(card.layout && card.layout.y, 0)) + 1;
}

const layoutOf = (c: Rec): { x: number; y: number; w: number; h: number } => {
  const l: Rec = c.layout || {};
  return { x: num(l.x, 0), y: num(l.y, 0), w: num(l.w, 1), h: num(l.h, 1) };
};

/** The card minus where it sits: what "changed" compares. */
function body(c: Rec): Rec {
  const { layout: _l, parentId: _p, tabId: _t, id: _i, ...rest } = c;
  return rest;
}

const measure = (m: Rec): string => `${String(m.aggregation || '')}(${String(m.column || '')})`;

/** Field-level changes of one matched card, in a fixed order per type. */
function cardChanges(a: Rec, b: Rec, title: string, titleOf: TitleOf, out: Change[]): void {
  const id = String(b.id || a.id || '');
  const push = (kind: Change['kind'], params: Change['params'] = {}, words?: Change['words']): void => {
    out.push({ group: 'cards', kind, cardId: id, params: { title, ...params }, ...(words ? { words } : {}) });
  };
  const ta = titleOf(a);
  const tb = titleOf(b);
  if (a.type !== b.type) { push('card.type', { from: String(a.type || ''), to: String(b.type || '') }); return; }
  if (ta !== tb && b.type !== 'visual') push('card.renamed', { from: ta, to: tb });
  if (b.type === 'visual') {
    if ((a.visualId || '') !== (b.visualId || '')) push('card.visualSwapped', { from: ta, to: tb });
    const va: Rec = a.visual || {};
    const vb: Rec = b.visual || {};
    if (va.chartType !== vb.chartType && (va.chartType || vb.chartType)) push('card.chartType', { from: String(va.chartType || ''), to: String(vb.chartType || '') });
    if (!same(va.encoding, vb.encoding)) push('card.encoding');
    if (!same(va.filters, vb.filters)) push('card.visualFilters');
    if (!same(a.actions, b.actions)) push('card.actions');
  } else if (b.type === 'metric') {
    const ma: Rec = a.metric || {};
    const mb: Rec = b.metric || {};
    if (measure(ma) !== measure(mb)) push('card.measure', { from: measure(ma), to: measure(mb) });
    if ((ma.metricId || '') !== (mb.metricId || '')) push('card.savedMetric');
    if ((ma.datasetId || '') !== (mb.datasetId || '')) push('card.dataset');
    if ((ma.format || 'auto') !== (mb.format || 'auto')) push('card.format');
    if (!same(ma.compare, mb.compare)) push('card.compare');
    if (!same(ma.calc, mb.calc)) push('card.calc');
    if ((ma.scenarioId || '') !== (mb.scenarioId || '')) push('card.scenario');
  } else if (b.type === 'text') {
    const xa = String(a.text || '');
    const xb = String(b.text || '');
    if (xa !== xb) push('card.text', {}, wordDiff(xa, xb));
  } else if (b.type === 'control') {
    if (!same(a.control, b.control)) push('card.control');
  }
  // Anything the branches above did not word (an image, a tab, a stats spec, a new field).
  const worded = new Set(['type', 'visualId', 'visual', 'actions', 'metric', 'text', 'heading', 'control']);
  const rest = (c: Rec): Rec => Object.fromEntries(Object.entries(body(c)).filter(([k]) => !worded.has(k)));
  if (!same(rest(a), rest(b))) push('card.settings');
}

function diffDashboard(a: Rec, b: Rec, titleOf: TitleOf): StructDiff {
  const changes: Change[] = [];
  const counts: Counts = { changed: 0, added: 0, removed: 0, moved: 0, filters: 0, other: 0 };
  const record = (kind: Change['kind'], params: Change['params'] = {}): void => {
    changes.push({ group: 'record', kind, params });
    counts.other++;
  };
  if ((a.name || '') !== (b.name || '')) record('name', { from: String(a.name || ''), to: String(b.name || '') });
  if (!same(a.style, b.style)) record('style');

  // Sheets: added, removed, renamed, reordered.
  const sa = arr(a.sheets);
  const sb = arr(b.sheets);
  const sheetA = new Map(sa.map((s) => [String(s.id), s]));
  const sheetB = new Map(sb.map((s) => [String(s.id), s]));
  for (const s of sb) {
    const prev = sheetA.get(String(s.id));
    if (!prev) { changes.push({ group: 'sheets', kind: 'sheet.added', params: { name: String(s.name || '') } }); counts.other++; }
    else if ((prev.name || '') !== (s.name || '')) { changes.push({ group: 'sheets', kind: 'sheet.renamed', params: { from: String(prev.name || ''), to: String(s.name || '') } }); counts.other++; }
  }
  for (const s of sa) {
    if (!sheetB.has(String(s.id))) { changes.push({ group: 'sheets', kind: 'sheet.removed', params: { name: String(s.name || '') } }); counts.other++; }
  }
  const kept = (list: Rec[], other: Map<string, Rec>): string[] => list.map((s) => String(s.id)).filter((id) => other.has(id));
  if (!same(kept(sa, sheetB), kept(sb, sheetA))) { changes.push({ group: 'sheets', kind: 'sheet.reordered', params: {} }); counts.other++; }

  // Filters: the scope every KPI card is computed under.
  const filterChanges = diffFilters(arr(a.filters), arr(b.filters));
  counts.filters = filterChanges.length;
  changes.push(...filterChanges);

  // Cards.
  const pa = placed(sa, titleOf);
  const pb = placed(sb, titleOf);
  const status = new Map<string, TileStatus>(); // key → status, shared by both sides' tiles
  const figures: FigureAsk[] = [];
  const filtersMoved = filterChanges.length > 0;
  for (const [key, { card, sheet }] of pb) {
    const prev = pa.get(key);
    const title = titleOf(card);
    if (!prev) {
      status.set(key, 'added');
      counts.added++;
      changes.push({ group: 'cards', kind: 'card.added', cardId: String(card.id || ''), params: { title, sheet: String(sheet.name || '') } });
      if (card.type === 'metric' && card.metric) figures.push({ cardId: String(card.id || key), title, reason: 'added', before: null, after: card.metric as CardMetric });
      continue;
    }
    const edits: Change[] = [];
    cardChanges(prev.card, card, title, titleOf, edits);
    const la = layoutOf(prev.card);
    const lb = layoutOf(card);
    const moves: Change[] = [];
    const cid = String(card.id || '');
    if (String(prev.sheet.id) !== String(sheet.id)) {
      moves.push({ group: 'cards', kind: 'card.movedSheet', cardId: cid, params: { title, from: String(prev.sheet.name || ''), to: String(sheet.name || '') } });
    } else {
      const ra = rowOf(prev.card, prev.sheet);
      const rb = rowOf(card, sheet);
      if (ra !== rb) moves.push({ group: 'cards', kind: 'card.movedRow', cardId: cid, params: { title, from: ra, to: rb } });
      else if (la.x !== lb.x) moves.push({ group: 'cards', kind: 'card.movedWithin', cardId: cid, params: { title, row: rb } });
    }
    if (la.w !== lb.w || la.h !== lb.h) moves.push({ group: 'cards', kind: 'card.resized', cardId: cid, params: { title, from: `${la.w}×${la.h}`, to: `${lb.w}×${lb.h}` } });
    if (edits.length) { status.set(key, 'changed'); counts.changed++; }
    else if (moves.length) { status.set(key, 'moved'); counts.moved++; }
    else status.set(key, 'same');
    changes.push(...edits, ...moves);
    if (card.type === 'metric' && card.metric && prev.card.metric) {
      const specMoved = !same(prev.card.metric, card.metric);
      if (specMoved || filtersMoved) {
        figures.push({ cardId: cid || key, title, reason: specMoved ? 'measure' : 'filters', before: prev.card.metric as CardMetric, after: card.metric as CardMetric });
      }
    }
  }
  for (const [key, { card, sheet }] of pa) {
    if (pb.has(key)) continue;
    const title = titleOf(card);
    status.set(key, 'removed');
    counts.removed++;
    changes.push({ group: 'cards', kind: 'card.removed', cardId: String(card.id || ''), params: { title, sheet: String(sheet.name || '') } });
    if (card.type === 'metric' && card.metric) figures.push({ cardId: String(card.id || key), title, reason: 'removed', before: card.metric as CardMetric, after: null });
  }

  return { counts, changes, sheets: sheetPairs(sa, sb, pa, pb, status), figures: figures.slice(0, MAX_FIGURES) };
}

/** One pair per sheet, the after side's order first, then sheets only the before side has. */
function sheetPairs(sa: Rec[], sb: Rec[], pa: Map<string, Placed>, pb: Map<string, Placed>, status: Map<string, TileStatus>): SheetPair[] {
  const tiles = (sheet: Rec | undefined, side: Map<string, Placed>): DiffTile[] | null => {
    if (!sheet) return null;
    const out: DiffTile[] = [];
    for (const p of side.values()) {
      if (p.sheet !== sheet) continue;
      out.push({ id: String(p.card.id || p.key), ...layoutOf(p.card), type: String(p.card.type || ''), status: status.get(p.key) || 'same' });
    }
    return out;
  };
  const byIdA = new Map(sa.map((s) => [String(s.id), s]));
  const byIdB = new Map(sb.map((s) => [String(s.id), s]));
  const ids = [...sb.map((s) => String(s.id)), ...sa.map((s) => String(s.id)).filter((id) => !byIdB.has(id))];
  return ids.map((id) => {
    const before = tiles(byIdA.get(id), pa);
    const after = tiles(byIdB.get(id), pb);
    const name = String((byIdB.get(id) || byIdA.get(id) || {}).name || '');
    const changed = !before || !after || (byIdA.get(id)?.name || '') !== (byIdB.get(id)?.name || '')
      || before.some((t) => t.status !== 'same') || after.some((t) => t.status !== 'same');
    return { id, name, before, after, changed };
  });
}

/**
 * The structural diff of version `a` (older, usually) against `b`. `titleOf`
 * names a card; for any type but a dashboard it is never called.
 */
export function diffVersions(type: DiffType, a: unknown, b: unknown, titleOf: TitleOf): StructDiff {
  const ca = contentOf(type, a);
  const cb = contentOf(type, b);
  if (type === 'dashboard') return diffDashboard(ca, cb, titleOf);
  const changes = diffOther(type, ca, cb);
  const filters = changes.filter((c) => c.group === 'filters').length;
  return { counts: { changed: 0, added: 0, removed: 0, moved: 0, filters, other: changes.length - filters }, changes, sheets: [], figures: [] };
}

/** True when the diff found nothing — the view's "these are the same" state. */
export function isEmptyDiff(d: StructDiff): boolean {
  return d.changes.length === 0;
}
