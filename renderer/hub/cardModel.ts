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

  // ── main's sanitizeCard hook ───────────────────────────────────────────────

  /** Card types beyond visual/text/metric/control. */
  const EXTRA_TYPES = ['nav'];

  /**
   * Copy the fields this module owns from an untrusted card `o` onto the
   * sanitized `card`. False drops the card (a kind missing its payload).
   */
  function sanitizeExtras(o: any, card: any): boolean {
    if (card.type === 'visual') {
      const actions = sanitizeActions(o.actions);
      if (actions.length) card.actions = actions;
    }
    if (card.type === 'nav') card.nav = sanitizeNav(o.nav);
    return true;
  }

  const api = {
    ACTION_KINDS, TRIGGERS, CARRIES, NAV_STYLES, NAV_ICONS, EXTRA_TYPES,
    sanitizeAction, sanitizeActions, actionUrl, carrySteps, validateActions,
    sanitizeNav, validateNav, sanitizeExtras,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.cardModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
