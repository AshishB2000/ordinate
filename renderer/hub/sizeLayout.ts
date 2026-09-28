'use strict';

// LAYOUTS FOR EVERY SIZE — the pure model. No DOM, no IPC.
//
// A dashboard page carries up to three layouts. DESKTOP is the 12-column grid
// every card's own `layout` already describes. TABLET (8 columns) and PHONE (one
// column, KPIs two-up) are DERIVED from desktop on the fly until someone edits
// them; an edit stores only that size, as `page.layouts[size]`, so a record
// without `layouts` — every record written before this — means "both derived".
//
// Shared the cardModel way: main requires it (dashboards.sanitizePage whitelists
// `layouts` with `sanitizeLayouts`; publish lays tiles out with `publishCells`),
// the hub loads it as a <script> that attaches `sizeLayout` to window, and
// scripts/test-sizeLayouts.js requires it. The derivation exists ONCE — the hub
// editor, the hub viewer, Publish and the tests all call `resolve` below.
//
// THE DERIVATION. Tiles (every card but a control, which is a filter-bar chip)
// are read top to bottom, left to right: desktop (y, x). A container or tabs
// card is followed by its own children, in tab order then (y, x) — a group
// becomes a one-row section header with its cards after it. Each tile then
// gets a SPAN CLASS and a HEIGHT from its KIND, never from its desktop h:
//
//   phone   KPI (metric) → pair: consecutive KPIs sit two-up; an odd one out
//           takes the full row. Everything else → full width.
//   tablet  KPI → quarter: up to four to a row (w=2); a trailing partial row is
//           spread across the 8 columns (1 → 8, 2 → 4+4, 3 → 3+3+2).
//           A chart, text or image that was HALF WIDTH OR LESS on desktop
//           (w ≤ 6) → half: two to a row (w=4); an odd one out goes full.
//           Wider ones, dividers, nav bars and group headers → full (w=8).
//
//   heights charts 6 rows, KPIs 2, dividers and group headers 1, images 4,
//           nav 1 (2 on phone, where its buttons wrap), text 2 plus a row per
//           ~90 characters on a narrow card (~200 on a wide one), capped at 8.
//
// Every row is FULL and every card in a row gets the row's tallest height, so
// the packing below is exactly what CSS auto-placement would draw — which is
// what lets the published site switch sizes with media queries alone.
//
// AN EDITED SIZE stores its order, hidden cards and height overrides:
//   { items: [{ id, hidden?: true, h?: number }, …] }   (widths stay derived)
// Card added on desktop → appears in every edited size at its DERIVED position
// (right after the card that precedes it in derived order). Card removed → it
// drops out of every size. Hidden stays hidden.
//
// THE BREAKPOINT is a function of the DASHBOARD CONTAINER's width, never the
// window's, so a split pane counts: < 600px phone, < 900px tablet, else
// desktop. Present mode never goes below tablet.
(function (global: any) {
  const SIZES = ['desktop', 'tablet', 'phone'];
  const SMALL_SIZES = ['tablet', 'phone'];
  const LABELS: Record<string, string> = { desktop: 'Desktop', tablet: 'Tablet', phone: 'Phone' };
  const COLS: Record<string, number> = { desktop: 12, tablet: 8, phone: 2 };
  /** Container width (CSS px) below which a size applies. */
  const BREAKPOINTS = { phone: 600, tablet: 900 };
  /** The width the hub previews a pinned tablet / phone at. */
  const FRAME_WIDTH: Record<string, number> = { tablet: 820, phone: 390 };
  /** The tallest a card may be made on a small size, in grid rows. */
  const MAX_H = 24;
  const GROUPS = ['container', 'tabs'];

  const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const clampH = (v: unknown): number => Math.min(MAX_H, Math.max(1, Math.trunc(num(v, 1))));

  /** Which size a dashboard container of this width shows. 0 (not laid out) is desktop. */
  function pickSize(width: number): string {
    if (!(width > 0)) return 'desktop';
    if (width < BREAKPOINTS.phone) return 'phone';
    if (width < BREAKPOINTS.tablet) return 'tablet';
    return 'desktop';
  }

  /** Present mode on a small window uses tablet — a phone stack is not a presentation. */
  function presentSize(width: number): string {
    const s = pickSize(width);
    return s === 'phone' ? 'tablet' : s;
  }

  const ly = (c: any): any => (c && c.layout) || {};
  const byYX = (a: any, b: any): number => num(ly(a).y, 0) - num(ly(b).y, 0) || num(ly(a).x, 0) - num(ly(b).x, 0);

  /** Every tile in reading order: (y, x), each group followed by its children. */
  function readingOrder(cards: unknown): any[] {
    const list = (Array.isArray(cards) ? cards : [])
      .filter((c: any) => c && typeof c.id === 'string' && c.type !== 'control');
    const groups = new Map<string, any>();
    for (const c of list) if (GROUPS.includes(c.type)) groups.set(c.id, c);
    const nested = (c: any): boolean => !GROUPS.includes(c.type) && typeof c.parentId === 'string' && groups.has(c.parentId);
    const out: any[] = [];
    // Array.prototype.sort is stable, so equal (y, x) keep their record order.
    for (const c of list.filter((x) => !nested(x)).sort(byYX)) {
      out.push(c);
      if (!groups.has(c.id)) continue;
      const tabs: string[] = ((c.tabs && c.tabs.items) || []).map((t: any) => t && t.id);
      const rank = (k: any): number => (tabs.indexOf(k.tabId) < 0 ? tabs.length : tabs.indexOf(k.tabId));
      out.push(...list.filter((k) => nested(k) && k.parentId === c.id).sort((a, b) => rank(a) - rank(b) || byYX(a, b)));
    }
    return out;
  }

  function spanClass(card: any, size: string): string {
    if (size === 'phone') return card.type === 'metric' ? 'pair' : 'full';
    if (card.type === 'metric') return 'quarter';
    if (card.type === 'visual' || card.type === 'text' || card.type === 'image') return num(ly(card).w, 12) <= 6 ? 'half' : 'full';
    return 'full';
  }

  /** A card's height on a small size, from its kind. */
  function kindHeight(card: any, size: string): number {
    switch (card.type) {
      case 'metric': return 2;
      case 'visual': return 6;
      case 'image': return 4;
      case 'divider': case 'container': case 'tabs': return 1;
      case 'nav': return size === 'phone' ? 2 : 1;
      case 'text': {
        const n = String(card.heading || '').length + String(card.text || '').length;
        const narrow = size === 'phone' || spanClass(card, size) === 'half';
        return Math.min(8, 2 + Math.floor(n / (narrow ? 90 : 200)));
      }
      default: return 4;
    }
  }

  const hasItems = (stored: any): boolean => !!stored && Array.isArray(stored.items) && stored.items.length > 0;

  /**
   * An edited size's order, laid over the derived one: stored ids that still
   * exist keep their order; a card the stored layout has never seen goes in
   * right after the card that precedes it in DERIVED order (first, if none).
   */
  function reconcile(derivedIds: string[], stored: any): { order: string[]; hidden: Set<string>; h: Map<string, number> } {
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

  /** Pack visible tiles into full rows (see the header). */
  function place(seq: Array<{ card: any; h: number }>, size: string): { items: any[]; rows: number } {
    const cols = COLS[size];
    const items: any[] = [];
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

  /**
   * THE layout a size shows for one page's cards.
   *   stored     — page.layouts[size] (an edited size) or undefined (derived)
   *   viewHidden — ids the VIEW hides right now (a folded container's cards,
   *                an inactive tab's); not placed, and not "hidden on size"
   * → { size, cols, edited, items: [{id, x, y, w, h}], hidden: [ids], rows }
   */
  function resolve(cards: unknown, stored: any, size: string, viewHidden?: Set<string>): any {
    const tiles = readingOrder(cards);
    if (!SMALL_SIZES.includes(size)) {
      const items = tiles.map((c) => ({
        id: c.id, x: num(ly(c).x, 0), y: num(ly(c).y, 0), w: num(ly(c).w, 1), h: num(ly(c).h, 1),
      }));
      return { size: 'desktop', cols: COLS.desktop, edited: false, items, hidden: [], rows: items.reduce((m, it) => Math.max(m, it.y + it.h), 0) };
    }
    const byId = new Map(tiles.map((c) => [c.id, c]));
    const { order, hidden, h } = reconcile(tiles.map((c) => c.id), stored);
    const seq = order
      .filter((id) => !hidden.has(id) && !(viewHidden && viewHidden.has(id)))
      .map((id) => ({ card: byId.get(id), h: h.has(id) ? (h.get(id) as number) : kindHeight(byId.get(id), size) }));
    const packed = place(seq, size);
    return {
      size, cols: COLS[size], edited: hasItems(stored),
      items: packed.items, hidden: order.filter((id) => hidden.has(id)), rows: packed.rows,
    };
  }

  /** The size's current order as a storable layout — what the first edit writes. */
  function materialize(cards: unknown, stored: any): any {
    const { order, hidden, h } = reconcile(readingOrder(cards).map((c) => c.id), stored);
    return {
      items: order.map((id) => {
        const it: any = { id };
        if (hidden.has(id)) it.hidden = true;
        if (h.has(id)) it.h = h.get(id);
        return it;
      }),
    };
  }

  /** Move `id` to just before (or after) `targetId`. False when nothing moved. */
  function moveItem(layout: any, id: string, targetId: string, after: boolean): boolean {
    const items: any[] = layout.items;
    const from = items.findIndex((i) => i.id === id);
    if (from < 0 || id === targetId || !items.some((i) => i.id === targetId)) return false;
    const [it] = items.splice(from, 1);
    const to = items.findIndex((i) => i.id === targetId);
    items.splice(after ? to + 1 : to, 0, it);
    return items.findIndex((i) => i.id === id) !== from;
  }

  function setHidden(layout: any, id: string, on: boolean): boolean {
    const it = layout.items.find((i: any) => i.id === id);
    if (!it || !!it.hidden === on) return false;
    if (on) it.hidden = true;
    else delete it.hidden;
    return true;
  }

  function setHeight(layout: any, id: string, h: number): boolean {
    const it = layout.items.find((i: any) => i.id === id);
    if (!it) return false;
    const next = clampH(h);
    if (it.h === next) return false;
    it.h = next;
    return true;
  }

  /**
   * Whitelist a page's `layouts` against its SANITIZED cards: known tile ids
   * only, once each; `hidden` only as `true`; heights clamped to 1..MAX_H;
   * every other key dropped. A size with no valid item is absent (= derived);
   * nothing valid at all → undefined, and the page carries no `layouts`.
   */
  function sanitizeLayouts(raw: unknown, cards: unknown): any {
    const o: any = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const ids = new Set(readingOrder(cards).map((c) => c.id));
    const out: any = {};
    for (const size of SMALL_SIZES) {
      const s = o[size];
      if (!s || typeof s !== 'object' || !Array.isArray(s.items)) continue;
      const seen = new Set<string>();
      const items: any[] = [];
      for (const it of s.items) {
        if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !ids.has(it.id) || seen.has(it.id)) continue;
        seen.add(it.id);
        const item: any = { id: it.id };
        if (it.hidden === true) item.hidden = true;
        if (typeof it.h === 'number' && Number.isFinite(it.h)) item.h = clampH(it.h);
        items.push(item);
      }
      if (items.length) out[size] = { items };
    }
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Publish: every tile's cell on tablet and phone — `{x, y, w, h}` or
   * `{hidden: true}` — for the CSS breakpoints of a published page. `cards` is
   * the subset the page draws, so rows pack over exactly what is there.
   */
  function publishCells(cards: unknown, layouts: any): Record<string, any> {
    const out: Record<string, any> = {};
    for (const size of SMALL_SIZES) {
      const r = resolve(cards, layouts && layouts[size], size);
      for (const it of r.items) (out[it.id] = out[it.id] || {})[size] = { x: it.x, y: it.y, w: it.w, h: it.h };
      for (const id of r.hidden) (out[id] = out[id] || {})[size] = { hidden: true };
    }
    return out;
  }

  const api = {
    SIZES, SMALL_SIZES, LABELS, COLS, BREAKPOINTS, FRAME_WIDTH, MAX_H,
    pickSize, presentSize, readingOrder, spanClass, kindHeight, reconcile, resolve,
    materialize, moveItem, setHidden, setHeight, sanitizeLayouts, publishCells,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.sizeLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
