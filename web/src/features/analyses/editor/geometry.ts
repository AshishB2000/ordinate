// Sheet geometry, PURE: placing, snapping, aligning and grouping cards on the
// fixed 12-column grid (legacy renderer/hub/cardModel.ts geometry + dashGrid
// `dashFindSlot`), and the layouts for every size (renderer/hub/sizeLayout.ts:
// tablet and phone derived from desktop until edited). The legacy modules are
// still what the SERVER sanitizes with (src/analysis/dashboards.ts requires
// them); geometry.test.ts runs both on the same inputs and compares with
// Object.is, so the two cannot drift.
//
// Grid units, never pixels; no figures — a layout is coordinates.

import type { Card, Layout, SizeItem } from '../api';

export const COLS = 12;
const GROUPS = ['container', 'tabs'];

const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

/** The first free cell for a w×h card, scanning rows top-down (dashGrid `dashFindSlot`). Controls are chips, not tiles. */
export function findSlot(cards: readonly Card[], w: number, h: number): { x: number; y: number } {
  const width = clampInt(w, 1, COLS, 1);
  const height = Math.max(1, clampInt(h, 1, 100000, 1));
  const placed = cards
    .filter((c) => c && c.type !== 'control' && c.layout)
    .map((c) => ({
      x: clampInt(c.layout.x, 0, COLS - 1, 0),
      y: Math.max(0, clampInt(c.layout.y, 0, 100000, 0)),
      w: clampInt(c.layout.w, 1, COLS, 1),
      h: Math.max(1, clampInt(c.layout.h, 1, 100000, 1)),
    }));
  const hits = (x: number, y: number) => placed.some((p) => x < p.x + p.w && p.x < x + width && y < p.y + p.h && p.y < y + height);
  const limit = placed.reduce((m, p) => Math.max(m, p.y + p.h), 0);
  for (let y = 0; y <= limit; y += 1) {
    for (let x = 0; x + width <= COLS; x += 1) if (!hits(x, y)) return { x, y };
  }
  return { x: 0, y: limit };
}

// ── Groups (container / tabs) ───────────────────────────────────────────

export const isGroup = (c: Card | undefined): boolean => !!c && GROUPS.includes(c.type);

export function childrenOf(cards: readonly Card[], id: string): Card[] {
  return cards.filter((c) => c && c.parentId === id);
}

/** A group's content box: everything under its first row. */
export function contentRect(g: Card): Layout {
  const l = g.layout;
  return { x: l.x, y: l.y + 1, w: l.w, h: Math.max(0, l.h - 1) };
}

function inside(r: Layout, box: Layout): boolean {
  return r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h;
}

export function overlaps(a: Layout, b: Layout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The group moved by (dx, dy): its children move with it (mutates). */
export function moveChildren(cards: Card[], id: string, dx: number, dy: number): string[] {
  if (!dx && !dy) return [];
  const moved: string[] = [];
  for (const c of childrenOf(cards, id)) {
    const l = c.layout;
    l.x = Math.max(0, Math.min(COLS - l.w, l.x + dx));
    l.y = Math.max(0, l.y + dy);
    moved.push(c.id);
  }
  return moved;
}

/** Grow a group until every child fits under its first row; never shrinks (mutates). */
export function fitGroup(cards: Card[], id: string): boolean {
  const g = cards.find((c) => c && c.id === id);
  if (!g) return false;
  const l = g.layout;
  const before = JSON.stringify(l);
  for (const c of childrenOf(cards, id)) {
    const k = c.layout;
    if (k.y < l.y + 1) k.y = l.y + 1;
    if (k.x < l.x) {
      l.w += l.x - k.x;
      l.x = k.x;
    }
    if (k.x + k.w > l.x + l.w) l.w = Math.min(COLS - l.x, k.x + k.w - l.x);
    if (k.y + k.h > l.y + l.h) l.h = k.y + k.h - l.y;
  }
  return JSON.stringify(l) !== before;
}

/** The group whose content box holds the card entirely (the topmost wins), or none. */
export function dropParent(cards: readonly Card[], card: Card): string | null {
  if (!card || isGroup(card)) return null;
  let hit: string | null = null;
  for (const g of cards) if (g && g.id !== card.id && isGroup(g) && inside(card.layout, contentRect(g))) hit = g.id;
  return hit;
}

/** Put `ids` into the new group `g`: it takes their box plus a first row, and everything below shifts down one (mutates). */
export function wrapGroup(cards: Card[], ids: readonly string[], g: Card): void {
  const members = cards.filter((c) => c && ids.includes(c.id) && !isGroup(c));
  if (!members.length) return;
  const x0 = Math.min(...members.map((c) => c.layout.x));
  const y0 = Math.min(...members.map((c) => c.layout.y));
  const x1 = Math.max(...members.map((c) => c.layout.x + c.layout.w));
  const y1 = Math.max(...members.map((c) => c.layout.y + c.layout.h));
  for (const c of cards) {
    if (!c || !c.layout || c.type === 'control' || members.includes(c)) continue;
    if (c.layout.y >= y0 && c.layout.x < x1 && x0 < c.layout.x + c.layout.w) c.layout.y += 1;
  }
  for (const c of members) {
    c.layout.y += 1;
    c.parentId = g.id;
    if (g.type === 'tabs' && g.tabs) c.tabId = g.tabs.items[0]?.id;
    else delete c.tabId;
  }
  g.layout = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 + 1 };
}

/** A group removed: its children stay, as ordinary cards (mutates). */
export function releaseChildren(cards: Card[], id: string): void {
  for (const c of childrenOf(cards, id)) {
    delete c.parentId;
    delete c.tabId;
  }
}

/** A tab removed: its cards move to the first remaining tab rather than vanish (mutates). */
export function removeTab(cards: Card[], g: Card, tabId: string): void {
  const rest = (g.tabs?.items ?? []).filter((t) => t.id !== tabId);
  if (!rest.length || !g.tabs) return;
  g.tabs.items = rest;
  for (const c of childrenOf(cards, g.id)) if (c.tabId === tabId || !rest.some((t) => t.id === c.tabId)) c.tabId = rest[0].id;
}

/** The tab on screen: the remembered one if it still exists, else the first. */
export function activeTab(g: Card, remembered: string | undefined): string {
  const items = g.tabs?.items ?? [];
  return items.some((t) => t.id === remembered) ? (remembered as string) : items.length ? items[0].id : '';
}

// ── Snap, align, distribute ─────────────────────────────────────────────

export interface Guide {
  axis: 'x' | 'y';
  at: number;
}

/** Snap a moving rect to its neighbours' edges and centres within `within` units; whole units only. */
export function snapRect(r: Layout, others: readonly Layout[], within = 1): { x: number; y: number; guides: Guide[] } {
  const best = (axis: 'x' | 'y') => {
    const size = axis === 'x' ? r.w : r.h;
    const pos = r[axis];
    let found: { d: number; at: number } | null = null;
    for (const o of others) {
      const os = axis === 'x' ? o.w : o.h;
      for (const line of [o[axis], o[axis] + os, o[axis] + os / 2]) {
        for (const off of [0, size, size / 2]) {
          const d = line - off - pos;
          if (!Number.isInteger(pos + d) || Math.abs(d) > within) continue;
          if (!found || Math.abs(d) < Math.abs(found.d)) found = { d, at: line };
        }
      }
    }
    return found;
  };
  const bx = best('x');
  const by = best('y');
  const x = Math.max(0, Math.min(COLS - r.w, r.x + (bx ? bx.d : 0)));
  const y = Math.max(0, r.y + (by ? by.d : 0));
  const guides: Guide[] = [];
  if (bx) guides.push({ axis: 'x', at: bx.at });
  if (by) guides.push({ axis: 'y', at: by.at });
  return { x, y, guides };
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/** Align layouts (mutated) to one edge or centre of their bounding box. */
export function alignLayouts(ls: Layout[], mode: AlignMode): void {
  if (ls.length < 2) return;
  const x0 = Math.min(...ls.map((l) => l.x));
  const x1 = Math.max(...ls.map((l) => l.x + l.w));
  const y0 = Math.min(...ls.map((l) => l.y));
  const y1 = Math.max(...ls.map((l) => l.y + l.h));
  for (const l of ls) {
    if (mode === 'left') l.x = x0;
    else if (mode === 'right') l.x = x1 - l.w;
    else if (mode === 'center') l.x = Math.round((x0 + x1 - l.w) / 2);
    else if (mode === 'top') l.y = y0;
    else if (mode === 'bottom') l.y = y1 - l.h;
    else if (mode === 'middle') l.y = Math.round((y0 + y1 - l.h) / 2);
    l.x = Math.max(0, Math.min(COLS - l.w, l.x));
  }
}

/** Equal whole-unit gaps along one axis, first and last staying put (mutated). */
export function distributeLayouts(ls: Layout[], axis: 'x' | 'y'): void {
  if (ls.length < 3) return;
  const size = axis === 'x' ? 'w' : 'h';
  const sorted = ls.slice().sort((a, b) => a[axis] - b[axis]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last[axis] + last[size] - first[axis];
  const used = sorted.reduce((s, l) => s + l[size], 0);
  const free = Math.max(0, span - used);
  const gaps = sorted.length - 1;
  let at = first[axis] + first[size];
  for (let i = 1; i < sorted.length - 1; i++) {
    at += Math.floor(free / gaps) + (i - 1 < free % gaps ? 1 : 0);
    sorted[i][axis] = at;
    at += sorted[i][size];
  }
}

// ── Layouts for every size (sizeLayout.ts) ──────────────────────────────

export type Size = 'desktop' | 'tablet' | 'phone';
export const SIZES: Size[] = ['desktop', 'tablet', 'phone'];
export const SIZE_COLS: Record<Size, number> = { desktop: 12, tablet: 8, phone: 2 };
export const BREAKPOINTS = { phone: 600, tablet: 900 };
/** The width a pinned tablet / phone previews at. */
export const FRAME_WIDTH: Record<Size, number> = { desktop: 0, tablet: 820, phone: 390 };
export const MAX_H = 24;
export const SIZE_LABEL: Record<Size, string> = { desktop: 'Desktop', tablet: 'Tablet', phone: 'Phone' };

const clampH = (v: unknown): number => Math.min(MAX_H, Math.max(1, Math.trunc(num(v, 1))));

/** Which size a dashboard container of this width shows; 0 (not laid out) is desktop. */
export function pickSize(width: number): Size {
  if (!(width > 0)) return 'desktop';
  if (width < BREAKPOINTS.phone) return 'phone';
  if (width < BREAKPOINTS.tablet) return 'tablet';
  return 'desktop';
}

const byYX = (a: Card, b: Card): number => num(a.layout?.y, 0) - num(b.layout?.y, 0) || num(a.layout?.x, 0) - num(b.layout?.x, 0);

/** Every tile in reading order: (y, x), each group followed by its children in tab order. */
export function readingOrder(cards: readonly Card[]): Card[] {
  const list = cards.filter((c) => c && typeof c.id === 'string' && c.type !== 'control');
  const groups = new Map<string, Card>();
  for (const c of list) if (isGroup(c)) groups.set(c.id, c);
  const nested = (c: Card) => !isGroup(c) && typeof c.parentId === 'string' && groups.has(c.parentId);
  const out: Card[] = [];
  for (const c of list.filter((x) => !nested(x)).sort(byYX)) {
    out.push(c);
    if (!groups.has(c.id)) continue;
    const tabs = (c.tabs?.items ?? []).map((t) => t && t.id);
    const rank = (k: Card) => (tabs.indexOf(k.tabId as string) < 0 ? tabs.length : tabs.indexOf(k.tabId as string));
    out.push(...list.filter((k) => nested(k) && k.parentId === c.id).sort((a, b) => rank(a) - rank(b) || byYX(a, b)));
  }
  return out;
}

export function spanClass(card: Card, size: Size): 'pair' | 'full' | 'quarter' | 'half' {
  if (size === 'phone') return card.type === 'metric' ? 'pair' : 'full';
  if (card.type === 'metric') return 'quarter';
  if (['visual', 'stats', 'text', 'image'].includes(card.type)) return num(card.layout?.w, 12) <= 6 ? 'half' : 'full';
  return 'full';
}

export function kindHeight(card: Card, size: Size): number {
  switch (card.type) {
    case 'metric':
      return 2;
    case 'visual':
    case 'stats':
      return 6;
    case 'image':
      return 4;
    case 'divider':
    case 'container':
    case 'tabs':
      return 1;
    case 'nav':
      return size === 'phone' ? 2 : 1;
    case 'text': {
      const n = String(card.heading || '').length + String(card.text || '').length;
      const narrow = size === 'phone' || spanClass(card, size) === 'half';
      return Math.min(8, 2 + Math.floor(n / (narrow ? 90 : 200)));
    }
    default:
      return 4;
  }
}

type Stored = { items: SizeItem[] } | undefined;
const hasItems = (s: Stored): s is { items: SizeItem[] } => !!s && Array.isArray(s.items) && s.items.length > 0;

export function reconcile(derivedIds: string[], stored: Stored): { order: string[]; hidden: Set<string>; h: Map<string, number> } {
  const known = new Set(derivedIds);
  const order: string[] = [];
  const present = new Set<string>();
  const hidden = new Set<string>();
  const h = new Map<string, number>();
  for (const it of hasItems(stored) ? stored.items : []) {
    if (!it || !known.has(it.id) || present.has(it.id)) continue;
    order.push(it.id);
    present.add(it.id);
    if (it.hidden === true) hidden.add(it.id);
    if (typeof it.h === 'number' && Number.isFinite(it.h)) h.set(it.id, clampH(it.h));
  }
  derivedIds.forEach((id, i) => {
    if (present.has(id)) return;
    let j = i - 1;
    while (j >= 0 && !present.has(derivedIds[j])) j--;
    order.splice(j < 0 ? 0 : order.indexOf(derivedIds[j]) + 1, 0, id);
    present.add(id);
  });
  return { order, hidden, h };
}

function place(seq: { card: Card; h: number }[], size: Size): { items: (Layout & { id: string })[]; rows: number } {
  const cols = SIZE_COLS[size];
  const items: (Layout & { id: string })[] = [];
  let y = 0;
  let i = 0;
  while (i < seq.length) {
    const cls = spanClass(seq[i].card, size);
    const per = cls === 'quarter' ? 4 : cls === 'pair' || cls === 'half' ? 2 : 1;
    let n = 1;
    while (n < per && i + n < seq.length && spanClass(seq[i + n].card, size) === cls) n++;
    const row = seq.slice(i, i + n);
    const base = Math.floor(cols / n);
    let extra = cols - base * n;
    const rh = Math.max(...row.map((r) => r.h));
    let x = 0;
    for (const r of row) {
      const w = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      items.push({ id: r.card.id, x, y, w, h: rh });
      x += w;
    }
    y += rh;
    i += n;
  }
  return { items, rows: y };
}

export interface Resolved {
  size: Size;
  cols: number;
  edited: boolean;
  items: (Layout & { id: string })[];
  hidden: string[];
  rows: number;
}

/** THE layout a size shows for one sheet's cards. */
export function resolve(cards: readonly Card[], stored: Stored, size: Size, viewHidden?: Set<string>): Resolved {
  const tiles = readingOrder(cards);
  if (size === 'desktop') {
    const items = tiles.map((c) => ({ id: c.id, x: num(c.layout?.x, 0), y: num(c.layout?.y, 0), w: num(c.layout?.w, 1), h: num(c.layout?.h, 1) }));
    return { size, cols: COLS, edited: false, items, hidden: [], rows: items.reduce((m, it) => Math.max(m, it.y + it.h), 0) };
  }
  const byId = new Map(tiles.map((c) => [c.id, c]));
  const { order, hidden, h } = reconcile(
    tiles.map((c) => c.id),
    stored,
  );
  const seq = order
    .filter((id) => !hidden.has(id) && !(viewHidden && viewHidden.has(id)))
    .map((id) => ({ card: byId.get(id) as Card, h: h.has(id) ? (h.get(id) as number) : kindHeight(byId.get(id) as Card, size) }));
  const packed = place(seq, size);
  return { size, cols: SIZE_COLS[size], edited: hasItems(stored), items: packed.items, hidden: order.filter((id) => hidden.has(id)), rows: packed.rows };
}

/** The size's current order as a storable layout — what the first edit writes. */
export function materialize(cards: readonly Card[], stored: Stored): { items: SizeItem[] } {
  const { order, hidden, h } = reconcile(
    readingOrder(cards).map((c) => c.id),
    stored,
  );
  return {
    items: order.map((id) => {
      const it: SizeItem = { id };
      if (hidden.has(id)) it.hidden = true;
      if (h.has(id)) it.h = h.get(id);
      return it;
    }),
  };
}

/** Move `id` to just before (or after) `targetId`; false when nothing moved (mutates). */
export function moveItem(layout: { items: SizeItem[] }, id: string, targetId: string, after: boolean): boolean {
  const items = layout.items;
  const from = items.findIndex((i) => i.id === id);
  if (from < 0 || id === targetId || !items.some((i) => i.id === targetId)) return false;
  const [it] = items.splice(from, 1);
  const to = items.findIndex((i) => i.id === targetId);
  items.splice(after ? to + 1 : to, 0, it);
  return items.findIndex((i) => i.id === id) !== from;
}

export function setHidden(layout: { items: SizeItem[] }, id: string, on: boolean): boolean {
  const it = layout.items.find((i) => i.id === id);
  if (!it || !!it.hidden === on) return false;
  if (on) it.hidden = true;
  else delete it.hidden;
  return true;
}

export function setHeight(layout: { items: SizeItem[] }, id: string, h: number): boolean {
  const it = layout.items.find((i) => i.id === id);
  if (!it) return false;
  const next = clampH(h);
  if (it.h === next) return false;
  it.h = next;
  return true;
}
