'use strict';

// RELATIVE PERIODS in the renderer — the words, and the picker. RENDERER ONLY.
// Classic global-scope <script>: no import/export. Loads after filterValues.js
// and before filterDialog.js / dashControls.js, which both draw this picker.
//
// A period is STORED as its preset ({ preset: 'last_n_days', n: 30 }) and
// turned into dates in MAIN, at query time, by src/analysis/dateIntel.ts — so a
// dashboard saved on "Last 30 days" is current every time it opens. Nothing here
// computes a date range. The one thing the renderer needs synchronously is the
// preset's NAME, for a chip or a step summary, and `periodLabel` below is a
// hand-kept mirror of `dateIntel.describePeriod`, pinned to it by
// scripts/test-periodLabels.ts (which runs this file in a vm). The resolved
// dates shown under the picker come from main (`period:resolve`).

/** The workspace calendar (Settings → General → Formats). Refreshed by hubNotify. */
let wsFormats: any = { weekStart: 1, fiscalYearStart: 1 };

const PP_UNITS: Array<{ preset: string; one: string; many: string }> = [
  { preset: 'last_n_days', one: 'day', many: 'days' },
  { preset: 'last_n_weeks', one: 'week', many: 'weeks' },
  { preset: 'last_n_months', one: 'month', many: 'months' },
  { preset: 'last_n_quarters', one: 'quarter', many: 'quarters' },
  { preset: 'last_n_years', one: 'year', many: 'years' },
];

/** The quick picks, in the order a reader scans them: short to long. */
const PP_GROUPS: Array<{ title: string; items: any[] }> = [
  {
    title: t('periodPicker.days'),
    items: [
      { preset: 'today' }, { preset: 'yesterday' },
      { preset: 'last_n_days', n: 7 }, { preset: 'last_n_days', n: 30 }, { preset: 'last_n_days', n: 90 },
    ],
  },
  {
    title: t('periodPicker.weeks_and_months'),
    items: [
      { preset: 'this_week' }, { preset: 'last_week' },
      { preset: 'this_month' }, { preset: 'last_month' },
      { preset: 'last_n_months', n: 3 }, { preset: 'last_n_months', n: 12 },
    ],
  },
  {
    title: t('periodPicker.quarters_and_years'),
    items: [
      { preset: 'this_quarter' }, { preset: 'last_quarter' }, { preset: 'qtd' },
      { preset: 'this_year' }, { preset: 'last_year' }, { preset: 'ytd' },
    ],
  },
];

/** A week calendar (retail / ISO) — its "months" are periods and a retail year is always fiscal. */
function ppWeekCal(): string {
  const t = wsFormats && wsFormats.calendarType;
  return t && t !== 'gregorian' ? String(t) : '';
}

function ppIsFiscal(): boolean {
  const wc = ppWeekCal();
  return wc ? wc !== 'iso' : Number(wsFormats && wsFormats.fiscalYearStart) > 1;
}

/** "Last 30 days", "This fiscal year" — the mirror of dateIntel.describePeriod. */
function periodLabel(spec: any): string {
  if (!spec || typeof spec !== 'object') return '';
  const fiscal = ppIsFiscal() ? 'fiscal ' : '';
  const month = ppWeekCal() ? 'period' : 'month';
  const n = Math.max(1, Math.floor(Number(spec.n) || 1));
  switch (spec.preset) {
    case 'today': return t('common.today');
    case 'yesterday': return t('common.yesterday');
    case 'this_week': return t('periodPicker.this_week');
    case 'last_week': return t('periodPicker.last_week');
    case 'this_month': return t('periodPicker.this', { month });
    case 'last_month': return t('periodPicker.last_3', { month });
    case 'this_quarter': return t('periodPicker.this_quarter', { fiscal });
    case 'last_quarter': return t('periodPicker.last_quarter', { fiscal });
    case 'this_year': return t('periodPicker.this_year', { fiscal });
    case 'last_year': return t('periodPicker.last_year', { fiscal });
    case 'ytd': return fiscal ? t('periodPicker.fiscal_year_to_date') : t('periodPicker.year_to_date');
    case 'qtd': return fiscal ? t('periodPicker.fiscal_quarter_to_date') : t('periodPicker.quarter_to_date');
    case 'custom': {
      if (spec.from && spec.to) return spec.from + ' to ' + spec.to;
      return spec.from ? t('periodPicker.from', { from: spec.from }) : t('periodPicker.until', { to: spec.to });
    }
    default: {
      const u = PP_UNITS.find((x) => x.preset === spec.preset);
      if (!u) return t('periodPicker.custom_range');
      const word = spec.preset === 'last_n_months' ? month + (n === 1 ? '' : 's') : n === 1 ? u.one : u.many;
      const pre = spec.preset === 'last_n_quarters' || spec.preset === 'last_n_years' ? fiscal : '';
      return t('periodPicker.last', { n, pre, word });
    }
  }
}

/** A stored ISO date in the workspace's date style (OrdFormat). */
function ppFmtDate(iso: string, withYear = true): string {
  return OrdFormat.formatDate(iso, undefined, withYear);
}

/** Two ISO bounds → "Sep 1 – Sep 30, 2026" (one year) or "Jul 1, 2024 – Jun 30, 2025". */
function ppFmtRange(from?: string, to?: string): string {
  return OrdFormat.formatDateRange(from, to);
}

/** Whether a date-range ControlValue is relative (a preset) rather than two dates. */
function ppIsRelative(v: any): boolean {
  return !!(v && typeof v === 'object' && typeof v.preset === 'string' && v.preset !== 'custom');
}

/** A date-range control's closed-state text: the preset's name, the dates, or "All dates". */
function periodValueText(v: any): string {
  if (ppIsRelative(v)) return periodLabel(v);
  if (v && (v.from || v.to)) return ppFmtRange(v.from, v.to);
  return t('periodPicker.all_dates');
}

function ppSame(a: any, b: any): boolean {
  if (!a || !b) return false;
  return a.preset === b.preset && (Number(a.n) || 0) === (Number(b.n) || 0);
}

/**
 * The picker body — a Relative tab of preset pills plus a "Last N units" row,
 * and (unless `relativeOnly`) a Between-dates tab. Reports every change through
 * `onChange(value)`, where value is `{preset, n?}`, `{from?, to?}` or null.
 *
 * Returned rather than mounted, so the filter-bar popover, the control dialog's
 * preview and the filter-step dialog all draw the SAME picker.
 */
function buildPeriodPanel(opts: { value: any; relativeOnly?: boolean; onChange: (v: any) => void }): HTMLElement {
  let value: any = opts.value && typeof opts.value === 'object' ? { ...opts.value } : null;
  let tab: 'rel' | 'abs' = opts.relativeOnly || !value || ppIsRelative(value) ? 'rel' : 'abs';

  const root = document.createElement('div');
  root.className = 'pp';

  const tabs = document.createElement('div');
  tabs.className = 'fd-tabs pp-tabs';
  tabs.setAttribute('role', 'tablist');
  const tabBtns: Record<string, HTMLButtonElement> = {};
  if (!opts.relativeOnly) {
    ([['rel', t('common.relative')], ['abs', t('periodPicker.between_dates')]] as Array<[string, string]>).forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fd-tab';
      b.setAttribute('role', 'tab');
      b.textContent = label;
      b.addEventListener('click', () => { tab = id as 'rel' | 'abs'; paint(); });
      tabBtns[id] = b;
      tabs.appendChild(b);
    });
    root.appendChild(tabs);
  }

  const body = document.createElement('div');
  body.className = 'pp-body';
  root.appendChild(body);

  const resolved = document.createElement('div');
  resolved.className = 'pp-resolved';
  root.appendChild(resolved);

  let seq = 0;
  async function paintResolved(): Promise<void> {
    const mine = ++seq;
    resolved.innerHTML = '';
    if (!value) {
      resolved.appendChild(icon('calendar', 14));
      resolved.appendChild(document.createTextNode(t('periodPicker.no_date_filter_every_date_is')));
      return;
    }
    if (!ppIsRelative(value)) {
      resolved.appendChild(icon('calendar', 14));
      resolved.appendChild(document.createTextNode(' ' + (ppFmtRange(value.from, value.to) || t('periodPicker.pick_a_start_or_an_end'))));
      return;
    }
    let res: any = null;
    try { res = await window.hub.resolvePeriod(value); } catch (_) { res = null; }
    if (mine !== seq) return;
    resolved.innerHTML = '';
    resolved.appendChild(icon('calendar', 14));
    const txt = res && res.ok ? ppFmtRange(res.from, res.to) : '';
    const strong = document.createElement('strong');
    strong.textContent = ' ' + periodLabel(value);
    resolved.appendChild(strong);
    if (txt) resolved.appendChild(document.createTextNode(' · ' + txt));
  }

  function set(v: any): void {
    value = v;
    opts.onChange(value ? { ...value } : null);
    paint();
  }

  function paintRelative(): void {
    PP_GROUPS.forEach((g) => {
      const group = document.createElement('div');
      group.className = 'pp-group';
      const h = document.createElement('div');
      h.className = 'pp-group-title';
      h.textContent = g.title;
      group.appendChild(h);
      const pills = document.createElement('div');
      pills.className = 'pp-pills';
      g.items.forEach((spec) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pp-pill';
        b.textContent = periodLabel(spec);
        const on = ppIsRelative(value) && ppSame(value, spec);
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.addEventListener('click', () => set({ ...spec }));
        pills.appendChild(b);
      });
      group.appendChild(pills);
      body.appendChild(group);
    });

    // "Last N units" — every length the pills don't carry.
    const custom = document.createElement('div');
    custom.className = 'pp-custom';
    const lead = document.createElement('span');
    lead.className = 'pp-custom-lead';
    lead.textContent = t('periodPicker.last_2');
    const n = document.createElement('input');
    n.type = 'number';
    n.min = '1';
    n.max = '3660';
    n.className = 'ws-modal-input pp-n';
    n.setAttribute('aria-label', t('common.how_many'));
    const unit = document.createElement('select');
    unit.className = 'ws-modal-input pp-unit';
    unit.setAttribute('aria-label', t('periodPicker.unit'));
    PP_UNITS.forEach((u) => {
      const o = document.createElement('option');
      o.value = u.preset;
      o.textContent = u.many;
      unit.appendChild(o);
    });
    const isN = ppIsRelative(value) && PP_UNITS.some((u) => u.preset === value.preset);
    n.value = String(isN ? value.n || 1 : 6);
    unit.value = isN ? value.preset : 'last_n_months';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-sm';
    go.textContent = t('common.use');
    const useCustom = (): void => {
      const k = Math.max(1, Math.min(3660, Math.floor(Number(n.value) || 1)));
      set({ preset: unit.value, n: k });
    };
    go.addEventListener('click', useCustom);
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useCustom(); } });
    unit.addEventListener('change', useCustom);
    custom.appendChild(lead);
    custom.appendChild(n);
    custom.appendChild(unit);
    custom.appendChild(go);
    body.appendChild(custom);

    const hint = document.createElement('p');
    hint.className = 'pp-hint';
    hint.textContent = t('periodPicker.last_periods_are_complete_ones_last', { p0: !!(ppIsFiscal()) });
    body.appendChild(hint);
  }

  function paintAbsolute(): void {
    const cur = value && !ppIsRelative(value) ? value : {};
    const row = document.createElement('div');
    row.className = 'pp-abs';
    const mk = (label: string, key: 'from' | 'to'): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'fd-field';
      const span = document.createElement('span');
      span.className = 'fd-field-label';
      span.textContent = label;
      const input = document.createElement('input');
      input.type = 'date';
      input.className = 'ws-modal-input';
      input.value = cur[key] || '';
      input.setAttribute('aria-label', label);
      input.addEventListener('change', () => {
        const next: any = value && !ppIsRelative(value) ? { ...value } : {};
        if (input.value) next[key] = input.value;
        else delete next[key];
        value = next.from || next.to ? next : null;
        opts.onChange(value ? { ...value } : null);
        void paintResolved();
      });
      wrap.appendChild(span);
      wrap.appendChild(input);
      return wrap;
    };
    row.appendChild(mk(t('common.from'), 'from'));
    row.appendChild(mk(t('common.to'), 'to'));
    body.appendChild(row);
    const hint = document.createElement('p');
    hint.className = 'pp-hint';
    hint.textContent = t('periodPicker.both_dates_are_inclusive_leave_one');
    body.appendChild(hint);
  }

  function paint(): void {
    Object.keys(tabBtns).forEach((id) => {
      tabBtns[id].classList.toggle('is-on', id === tab);
      tabBtns[id].setAttribute('aria-selected', id === tab ? 'true' : 'false');
    });
    body.innerHTML = '';
    if (tab === 'rel') paintRelative();
    else paintAbsolute();
    void paintResolved();
  }
  paint();
  return root;
}

/**
 * The filter bar's date control, opened from its chip: the picker plus Clear /
 * Cancel / Apply. `onApply(null)` means "All dates".
 */
function openPeriodPopover(anchor: HTMLElement, current: any, label: string, onApply: (v: any) => void): void {
  if (openControlPopover) openControlPopover();
  let pending: any = current && (ppIsRelative(current) || current.from || current.to) ? { ...current } : null;

  const pop = document.createElement('div');
  pop.className = 'dash-ctrl-popover pp-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label + t('periodPicker.dates'));
  pop.appendChild(buildPeriodPanel({ value: pending, onChange: (v) => { pending = v; } }));

  const actions = document.createElement('div');
  actions.className = 'dash-ctrl-popover-actions pp-actions';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'fd-link pp-clear';
  clear.textContent = t('periodPicker.all_dates');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm';
  cancel.textContent = t('common.cancel');
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-primary btn-sm';
  apply.textContent = t('common.apply');
  actions.appendChild(clear);
  actions.appendChild(cancel);
  actions.appendChild(apply);
  pop.appendChild(actions);

  function position(): void {
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const w = pop.offsetWidth || 380;
    pop.style.left = Math.max(margin, Math.min(r.left, window.innerWidth - margin - w)) + 'px';
    const below = window.innerHeight - r.bottom;
    if (below >= 360 || below >= r.top) {
      pop.style.top = (r.bottom + 4) + 'px';
      pop.style.bottom = 'auto';
    } else {
      pop.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      pop.style.top = 'auto';
    }
  }
  function close(): void {
    if (openControlPopover === close) openControlPopover = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', position, true);
    if (pop.parentNode) pop.parentNode.removeChild(pop);
  }
  function onDocDown(e: MouseEvent): void {
    const t = e.target as Node;
    if (pop.contains(t) || anchor.contains(t)) return;
    close();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
  }
  clear.addEventListener('click', () => { close(); onApply(null); });
  cancel.addEventListener('click', () => close());
  apply.addEventListener('click', () => { close(); onApply(pending); });

  document.body.appendChild(pop);
  openControlPopover = close;
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', position, true);
  position();
}

/**
 * The overlay's sentence under a chart — "Revenue is up 18% vs the same months
 * last year" — written by MAIN (periodScope.overlayCaption) from the two series
 * it computed. Placed right after `area`; any earlier one is replaced, and a
 * chart type that drops the overlay series drops its sentence too.
 */
function paintOverlayCaption(area: HTMLElement, res: any, type: string): void {
  const parent = area.parentElement;
  if (!parent) return;
  parent.querySelectorAll(':scope > .viz-overlay-caption').forEach((n) => n.remove());
  const ov = res && res.overlay;
  if (!ov || !ov.caption || !CHART_OVERLAY_TYPES.has(type)) return;
  const p = document.createElement('p');
  p.className = 'viz-overlay-caption';
  const pct = Number(ov.pct);
  if (Number.isFinite(pct) && Math.round(pct) !== 0) p.classList.add(pct > 0 ? 'is-up' : 'is-down');
  const key = document.createElement('span');
  key.className = 'viz-overlay-key';
  key.setAttribute('aria-hidden', 'true');
  p.appendChild(key);
  const txt = document.createElement('span');
  txt.textContent = ov.caption;
  p.appendChild(txt);
  area.insertAdjacentElement('afterend', p);
}
