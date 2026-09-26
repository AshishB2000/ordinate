// The dashboard CARD MODEL beyond the four original kinds — tile actions and
// the Navigation card. PURE: no DOM, no IPC.
//
// Shared the geoMatch way: main requires it (src/analysis/dashboards.ts runs
// `sanitizeExtras` inside `sanitizeCard`, so what the renderer may store is
// decided in main), the renderer loads it as a <script> that attaches
// `cardModel` to window, and scripts/test-tileActions.js requires it too. One
// implementation of carry, URL building and validation, not three.
(function (global: any) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isId = (x: unknown): x is string => typeof x === 'string' && UUID_RE.test(x);
  const newId = (): string => (globalThis as any).crypto.randomUUID();
  const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '');

  // ── Tile actions ───────────────────────────────────────────────────────────

  const ACTION_KINDS = ['navigate', 'url', 'filter_target', 'tooltip_visual'];
  const TRIGGERS = ['click', 'menu'];
  const CARRIES = ['clicked_value', 'all_selection', 'none'];
  const MAX_ACTIONS = 8;
  const MAX_TILES = 50;

  function sanitizeTarget(raw: any): any {
    if (!raw || typeof raw !== 'object' || !isId(raw.analysisId)) return undefined;
    const t: any = { analysisId: raw.analysisId };
    if (isId(raw.page)) t.page = raw.page;
    return t;
  }

  /**
   * One action, whitelisted. An INCOMPLETE action (a navigate with no target
   * yet) is kept — the Interactions editor saves on every change, and dropping
   * it here would delete the row the author is still filling in. What it lacks
   * is reported by `validateActions`, not repaired.
   */
  function sanitizeAction(raw: any): any {
    if (!raw || typeof raw !== 'object' || !ACTION_KINDS.includes(raw.kind)) return null;
    const a: any = {
      id: isId(raw.id) ? raw.id : newId(),
      kind: raw.kind,
      trigger: TRIGGERS.includes(raw.trigger) ? raw.trigger : 'click',
      carry: CARRIES.includes(raw.carry) ? raw.carry : 'clicked_value',
    };
    const label = str(raw.label, 80).trim();
    if (label) a.label = label;
    const target = sanitizeTarget(raw.target);
    if (target) a.target = target;
    const url = str(raw.url, 2000).trim();
    if (url) a.url = url;
    if (isId(raw.tooltipVisualId)) a.tooltipVisualId = raw.tooltipVisualId;
    if (Array.isArray(raw.tiles)) {
      const tiles = [...new Set(raw.tiles.filter(isId))].slice(0, MAX_TILES);
      if (tiles.length) a.tiles = tiles;
    }
    return a;
  }

  function sanitizeActions(raw: unknown): any[] {
    const out: any[] = [];
    for (const r of Array.isArray(raw) ? raw : []) {
      const a = sanitizeAction(r);
      if (a && !out.some((x) => x.id === a.id)) out.push(a);
      if (out.length >= MAX_ACTIONS) break;
    }
    return out;
  }

  /**
   * An action's URL with `{{value}}` substituted, URL-ENCODED, and https only.
   * Encoding happens BEFORE parsing, so a clicked value can never supply a
   * scheme, a host or a path of its own: `javascript:…` arrives as
   * `javascript%3A…` inside whatever the author wrote.
   */
  function actionUrl(template: unknown, value: unknown): { ok: true; url: string } | { ok: false; error: string } {
    const t = typeof template === 'string' ? template.trim() : '';
    if (!t) return { ok: false, error: 'Enter an https:// address.' };
    const enc = encodeURIComponent(value == null ? '' : String(value));
    const filled = t.replace(/\{\{\s*value\s*\}\}/g, enc);
    let u: URL;
    try {
      u = new URL(filled);
    } catch (_) {
      return { ok: false, error: 'That is not a web address.' };
    }
    if (u.protocol !== 'https:' || !u.hostname) return { ok: false, error: 'Only https:// links can open from a dashboard.' };
    return { ok: true, url: u.href };
  }

  function stepKey(s: any): string {
    return JSON.stringify([s.column, s.op, s.value === undefined ? null : s.value, Array.isArray(s.values) ? s.values : null]);
  }

  /**
   * What an action carries to its destination, as filter steps:
   *   none           — nothing;
   *   clicked_value  — `column = value` for the mark that was clicked (nothing
   *                    from a menu, where no mark was);
   *   all_selection  — the sheet's filters and selection, then the click. A
   *                    click on a column the sheet already filters by equality
   *                    REPLACES that filter rather than stacking an impossible
   *                    `region = East AND region = West`.
   */
  function carrySteps(action: any, ctx: any): any[] {
    const c = ctx && ctx.clicked;
    const clicked = c && typeof c.column === 'string' && c.column && c.value !== undefined
      ? [{ type: 'filter', column: c.column, op: '=', value: c.value }]
      : [];
    const mode = action && CARRIES.includes(action.carry) ? action.carry : 'clicked_value';
    if (mode === 'none') return [];
    if (mode === 'clicked_value') return clicked;
    const replaced = new Set(clicked.map((s) => s.column));
    const seen = new Set<string>();
    const out: any[] = [];
    for (const s of [...((ctx && ctx.filters) || []), ...((ctx && ctx.selection) || [])]) {
      if (!s || s.type !== 'filter' || typeof s.column !== 'string') continue;
      if (replaced.has(s.column) && s.op === '=') continue;
      const k = stepKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out.concat(clicked);
  }

  /**
   * Per action, what is wrong with it — a DANGLING reference (a dashboard,
   * page, tile or visual that no longer exists) or a missing choice. Warnings,
   * never refusals: the record keeps the action, and the Interactions tab says
   * why it will not fire.
   *
   * ctx: { analyses: [{id, name, pages: [{id, name}]}], visualIds: string[], tileIds: string[] }
   */
  function validateActions(actions: any[], ctx: any): string[][] {
    const analyses: any[] = (ctx && ctx.analyses) || [];
    const visualIds = new Set<string>((ctx && ctx.visualIds) || []);
    const tileIds = new Set<string>((ctx && ctx.tileIds) || []);
    return (actions || []).map((a) => {
      const w: string[] = [];
      if (a.kind === 'navigate') w.push(...targetWarnings(a.target, analyses));
      else if (a.kind === 'url') {
        const r = actionUrl(a.url, 'x');
        if (!r.ok) w.push((r as { error: string }).error);
      } else if (a.kind === 'filter_target') {
        const tiles: string[] = a.tiles || [];
        if (!tiles.length) w.push('Choose the tiles this narrows.');
        const gone = tiles.filter((t) => !tileIds.has(t)).length;
        if (gone) w.push(gone === 1 ? 'One target tile no longer exists.' : `${gone} target tiles no longer exist.`);
      } else if (a.kind === 'tooltip_visual') {
        if (!a.tooltipVisualId) w.push('Choose a visual to show in the tooltip.');
        else if (!visualIds.has(a.tooltipVisualId)) w.push('The tooltip visual no longer exists.');
      }
      return w;
    });
  }

  function targetWarnings(target: any, analyses: any[]): string[] {
    if (!target || !target.analysisId) return ['Choose a dashboard to open.'];
    const an = analyses.find((x) => x.id === target.analysisId);
    if (!an) return ['The target dashboard no longer exists.'];
    if (target.page && !(an.pages || []).some((p: any) => p.id === target.page)) {
      return ['The target page no longer exists — it will open on its first page.'];
    }
    return [];
  }

  // ── The Navigation card ────────────────────────────────────────────────────

  const NAV_STYLES = ['buttons', 'tabs', 'back'];
  const NAV_ICONS = [
    'layout-dashboard', 'chart-bar', 'chart-line', 'chart-pie', 'map', 'table', 'home', 'arrow-left',
    'arrow-right', 'star', 'filter', 'layers', 'grid', 'list', 'user', 'calendar', 'database', 'sparkles',
  ];
  const MAX_NAV_ITEMS = 12;

  /** An optional carried filter: one `column = value`, the only step a nav button needs. */
  function sanitizeCarry(raw: any): any {
    if (!raw || typeof raw !== 'object') return undefined;
    const column = str(raw.column, 200);
    const v = raw.value;
    if (!column || !(typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) return undefined;
    return { column, value: typeof v === 'string' ? v.slice(0, 500) : v };
  }

  function sanitizeNav(raw: any): any {
    const o = raw && typeof raw === 'object' ? raw : {};
    const style = NAV_STYLES.includes(o.style) ? o.style : 'buttons';
    const items: any[] = [];
    for (const it of Array.isArray(o.items) ? o.items : []) {
      if (!it || typeof it !== 'object') continue;
      const item: any = { id: isId(it.id) ? it.id : newId(), label: str(it.label, 60).trim() || 'Open' };
      if (NAV_ICONS.includes(it.icon)) item.icon = it.icon;
      const target = sanitizeTarget(it.target);
      if (target) item.target = target;
      const carry = sanitizeCarry(it.carry);
      if (carry) item.carry = carry;
      items.push(item);
      if (items.length >= MAX_NAV_ITEMS) break;
    }
    return { style, items };
  }

  function validateNav(nav: any, ctx: any): string[][] {
    const analyses: any[] = (ctx && ctx.analyses) || [];
    return ((nav && nav.items) || []).map((it: any) => (nav.style === 'back' && !it.target ? [] : targetWarnings(it.target, analyses)));
  }

  // ── Layout kinds: image, divider, container, tabs ──────────────────────────

  const IMAGE_EXTS = ['png', 'jpg', 'svg'];
  const IMAGE_FITS = ['contain', 'cover', 'fill'];
  const DIVIDER_STYLES = ['line', 'spacer'];
  const CONTAINER_BGS = ['none', 'subtle', 'surface', 'accent'];
  const PADDINGS = ['none', 'sm', 'md', 'lg'];
  const MAX_TABS = 8;
  /** Kinds that HOLD other cards. A group cannot sit inside a group. */
  const GROUP_TYPES = ['container', 'tabs'];

  function pick(list: string[], v: unknown, dflt: string): string {
    return typeof v === 'string' && list.includes(v) ? v : dflt;
  }

  function sanitizeImage(raw: any): any {
    if (!raw || typeof raw !== 'object' || !isId(raw.assetId)) return null;
    const img: any = {
      assetId: raw.assetId,
      ext: pick(IMAGE_EXTS, raw.ext, 'png'),
      fit: pick(IMAGE_FITS, raw.fit, 'contain'),
      alt: str(raw.alt, 300),
      lockAspect: raw.lockAspect !== false,
    };
    if (typeof raw.aspect === 'number' && raw.aspect > 0.01 && raw.aspect < 100) img.aspect = raw.aspect;
    return img;
  }

  function sanitizeTabs(raw: any): any {
    const items: any[] = [];
    for (const t of Array.isArray(raw && raw.items) ? raw.items : []) {
      if (!t || typeof t !== 'object') continue;
      items.push({ id: isId(t.id) ? t.id : newId(), name: str(t.name, 40).trim() || `Tab ${items.length + 1}` });
      if (items.length >= MAX_TABS) break;
    }
    if (!items.length) items.push({ id: newId(), name: 'Tab 1' });
    return { items };
  }

  // ── Geometry (grid units, the page's 12 columns) ───────────────────────────
  // A group's first row is its title (container) or its tab strip (tabs); its
  // children sit in the rows under it, positioned on the SAME page grid as
  // every other card. Cards stay a flat list — `parentId`/`tabId` is the whole
  // of the nesting — so every reader of `page.cards` keeps working.

  const COLS = 12;
  const cid = (c: any): any => c && c.layout;

  function childrenOf(cards: any[], id: string): any[] {
    return (cards || []).filter((c) => c && c.parentId === id);
  }

  /** The group's content box: everything under its first row. */
  function contentRect(g: any): any {
    const l = g.layout;
    return { x: l.x, y: l.y + 1, w: l.w, h: Math.max(0, l.h - 1) };
  }

  function inside(r: any, box: any): boolean {
    return r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h;
  }

  /** The group moved by (dx, dy): its children move with it. Returns the ids moved. */
  function moveChildren(cards: any[], id: string, dx: number, dy: number): string[] {
    if (!dx && !dy) return [];
    const moved: string[] = [];
    for (const c of childrenOf(cards, id)) {
      const l = cid(c);
      l.x = Math.max(0, Math.min(COLS - l.w, l.x + dx));
      l.y = Math.max(0, l.y + dy);
      moved.push(c.id);
    }
    return moved;
  }

  /**
   * Grow a group until every child fits under its first row — the answer to
   * "a child moved past the edge". Never shrinks; clamps to the page width.
   * A child dragged up into the title row is pushed back down under it.
   * True when the group's layout changed.
   */
  function fitGroup(cards: any[], id: string): boolean {
    const g = (cards || []).find((c) => c && c.id === id);
    if (!g) return false;
    const l = g.layout;
    const before = JSON.stringify(l);
    for (const c of childrenOf(cards, id)) {
      const k = cid(c);
      if (k.y < l.y + 1) k.y = l.y + 1;
      if (k.x < l.x) { l.w += l.x - k.x; l.x = k.x; }
      if (k.x + k.w > l.x + l.w) l.w = Math.min(COLS - l.x, k.x + k.w - l.x);
      if (k.y + k.h > l.y + l.h) l.h = k.y + k.h - l.y;
    }
    return JSON.stringify(l) !== before;
  }

  /**
   * Where a card dropped at its current layout belongs: the group whose content
   * box holds it entirely (the last-drawn, i.e. topmost, wins), or none.
   */
  function dropParent(cards: any[], card: any): string | null {
    if (!card || GROUP_TYPES.includes(card.type)) return null;
    let hit: string | null = null;
    for (const g of cards || []) {
      if (g && g.id !== card.id && GROUP_TYPES.includes(g.type) && inside(card.layout, contentRect(g))) hit = g.id;
    }
    return hit;
  }

  /**
   * Put `ids` into a new group card `g`: the group takes their bounding box plus
   * a first row, the members move down one row under it, and every other card
   * in the rows below that shares a column moves down one too, so nothing is
   * covered. Tabs members land in the first tab.
   */
  function wrapGroup(cards: any[], ids: string[], g: any): void {
    const members = (cards || []).filter((c) => c && ids.includes(c.id) && !GROUP_TYPES.includes(c.type));
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
      if (g.type === 'tabs') c.tabId = g.tabs.items[0].id;
      else delete c.tabId;
    }
    g.layout = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 + 1 };
  }

  /** A group removed: its children stay, as ordinary cards. */
  function releaseChildren(cards: any[], id: string): void {
    for (const c of childrenOf(cards, id)) {
      delete c.parentId;
      delete c.tabId;
    }
  }

  /** A tab removed: its cards move to the first remaining tab rather than vanish. */
  function removeTab(cards: any[], g: any, tabId: string): void {
    const rest = (g.tabs.items || []).filter((t: any) => t.id !== tabId);
    if (!rest.length) return;
    g.tabs.items = rest;
    for (const c of childrenOf(cards, g.id)) if (c.tabId === tabId || !rest.some((t: any) => t.id === c.tabId)) c.tabId = rest[0].id;
  }

  /** The tab on screen: the remembered one if it still exists, else the first. */
  function activeTab(g: any, remembered: string | undefined): string {
    const items = (g && g.tabs && g.tabs.items) || [];
    return items.some((t: any) => t.id === remembered) ? (remembered as string) : items.length ? items[0].id : '';
  }

  /**
   * Snap a moving rect to its neighbours: when an edge or centre of `r` is
   * within `within` columns/rows of a neighbour's edge or centre, it moves to
   * line up exactly, and the line it lined up on is returned as a guide.
   * Positions stay whole grid units — a centre that would need a half unit
   * is not a snap.
   */
  function snapRect(r: any, others: any[], within = 1): { x: number; y: number; guides: any[] } {
    const best = (axis: 'x' | 'y'): { d: number; at: number } | null => {
      const size = axis === 'x' ? r.w : r.h;
      const pos = r[axis];
      let found: { d: number; at: number } | null = null;
      for (const o of others) {
        const os = axis === 'x' ? o.w : o.h;
        const lines = [o[axis], o[axis] + os, o[axis] + os / 2];
        for (const line of lines) {
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
    const guides: any[] = [];
    if (bx) guides.push({ axis: 'x', at: bx.at });
    if (by) guides.push({ axis: 'y', at: by.at });
    return { x, y, guides };
  }

  /** Align a multi-selection's layouts (mutated) to one edge or centre of their bounding box. */
  function alignLayouts(ls: any[], mode: string): void {
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

  /**
   * Spread three or more layouts so the gaps between them are equal along one
   * axis, first and last staying put. Gaps are whole units; the remainder goes
   * to the first gaps, so the result is deterministic.
   */
  function distributeLayouts(ls: any[], axis: 'x' | 'y'): void {
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

  // ── main's sanitizeCard hook ───────────────────────────────────────────────

  /** Card types beyond visual/text/metric/control. */
  const EXTRA_TYPES = ['nav', 'image', 'divider', 'container', 'tabs'];

  /**
   * Copy the fields this module owns from an untrusted card `o` onto the
   * sanitized `card`. False drops the card (a kind missing its payload).
   */
  function sanitizeExtras(o: any, card: any): boolean {
    if (card.type === 'visual') {
      const actions = sanitizeActions(o.actions);
      if (actions.length) card.actions = actions;
    }
    // Membership: any card but a group (and a control, which is a chip) may sit in one.
    if (!GROUP_TYPES.includes(card.type) && card.type !== 'control' && isId(o.parentId)) {
      card.parentId = o.parentId;
      if (isId(o.tabId)) card.tabId = o.tabId;
    }
    if (card.type === 'nav') card.nav = sanitizeNav(o.nav);
    if (card.type === 'image') {
      const img = sanitizeImage(o.image);
      if (!img) return false;
      card.image = img;
    }
    if (card.type === 'divider') card.divider = { style: pick(DIVIDER_STYLES, o.divider && o.divider.style, 'line') };
    if (card.type === 'container') {
      const c = o.container && typeof o.container === 'object' ? o.container : {};
      card.container = {
        title: str(c.title, 80),
        background: pick(CONTAINER_BGS, c.background, 'subtle'),
        padding: pick(PADDINGS, c.padding, 'md'),
        collapsible: c.collapsible === true,
      };
    }
    if (card.type === 'tabs') card.tabs = sanitizeTabs(o.tabs);
    return true;
  }

  const api = {
    ACTION_KINDS, TRIGGERS, CARRIES, NAV_STYLES, NAV_ICONS, EXTRA_TYPES, GROUP_TYPES,
    IMAGE_FITS, DIVIDER_STYLES, CONTAINER_BGS, PADDINGS,
    sanitizeAction, sanitizeActions, actionUrl, carrySteps, validateActions,
    sanitizeNav, validateNav, sanitizeExtras, sanitizeTabs,
    childrenOf, contentRect, moveChildren, fitGroup, dropParent, wrapGroup, releaseChildren,
    removeTab, activeTab, snapRect, alignLayouts, distributeLayouts,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.cardModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
