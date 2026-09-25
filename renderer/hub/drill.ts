'use strict';

// The drill-down panel — "show me the rows behind this number". RENDERER ONLY,
// classic global-scope script (no import/export); its globals are declared in
// globals.d.ts.
//
// ONE panel, cloned from #drill-tpl on first open and reused by every surface:
// the Visuals builder, analysis authoring, dashboard cards and published
// snapshots. It is a READ — it never writes a filter, never touches a card, and
// works identically on a read-only snapshot.
//
// ── What this file is NOT allowed to do ─────────────────────────────────────
// Search, sort and paging all run in MAIN, against the stored .parquet, through
// `visual:rows`. Fetching the row set and filtering it here is the exact pattern
// that capped datasets at 50k before `datasetPage.ts` existed — and it would
// also mean the panel deciding for itself which rows belong to a mark, which is
// the one thing this feature must never do. Main composes the filters, main
// selects the rows; this file draws what it is given.
//
// When main says the row set cannot be derived faithfully
// (`available: false`), the body shows the reason SENTENCE and no grid. An
// approximate row set would quietly contradict the figure it claims to explain.

/** Rows per page. The grid draws a window; it never holds the set. */
const DRILL_PAGE_ROWS = 100;
/** Debounce on the search box, matching the Explore grid's. */
const DRILL_SEARCH_MS = 250;

interface DrillOpts {
  /** The visual's name, for the panel header. */
  name?: string;
  projectId: string;
  datasetId: string;
  encoding: any;
  /** The SAME filter list that produced the figure (visual + sheet, merged). */
  filters?: any[];
  /** The clicked mark, or omitted to drill the whole visual. */
  mark?: { category?: any; series?: any } | null;
  /** The control that opened the panel; gets aria-expanded and the focus back. */
  trigger?: HTMLElement | null;
}

/**
 * A plain click on a chart opens the panel for the clicked mark.
 *
 * Drilling is a READ and needs no override flag — it is available wherever a
 * visual renders, including a published, read-only dashboard. Cross-filtering
 * WRITES a sheet filter, stays opt-in (`overrides.crossFilter`, default off),
 * and when it is on it owns the plain click: one gesture never gets two side
 * effects, so the ⋯ menu is the drill route on those cards.
 *
 * The hit-test is `chartMarkAt` (chartControls.ts) — the same one
 * cross-filtering uses, because two answers to "which bar was clicked" is two
 * answers to what the rows behind it are.
 */
function wireDrillClick(area: HTMLElement, ctx: DrillOpts): void {
  if (!area || !ctx) return;
  // The builder re-renders into the SAME element on every chart-type switch, so
  // bind once and read the context at click time — otherwise one click would
  // open the panel once per render since the area was created.
  (area as any)._drillCtx = ctx;
  if (area.classList.contains('is-drillable')) return;
  area.classList.add('is-drillable');
  area.addEventListener('click', (e) => {
    const live: DrillOpts = (area as any)._drillCtx || ctx;
    const mark = chartMarkAt(area, e);
    if (!mark) return; // empty canvas, or a map/table: the ⋯ menu handles those
    // `series` is only a split value when the encoding actually splits — on a
    // multi-measure chart the dataset label is a legend entry ("sum of price").
    const hasSplit = Boolean(live.encoding && typeof live.encoding.series === 'string' && live.encoding.series);
    openDrillPanel({
      name: live.name,
      projectId: live.projectId,
      datasetId: live.datasetId,
      encoding: live.encoding,
      filters: live.filters,
      mark: { category: mark.category, series: hasSplit ? mark.series : undefined },
      trigger: area,
    });
  });
}

let drillRoot: HTMLElement | null = null; // the cloned #drill-tpl instance
let drillOpts: DrillOpts | null = null;
let drillTrigger: HTMLElement | null = null;
let drillPrevFocus: HTMLElement | null = null;

// Page state. Reset on every open — a panel that remembers page 4 of the last
// mark is showing the wrong rows for the new one.
let drillOffset = 0;
let drillSearch = '';
let drillSortCol = '';
let drillSortDir: 'asc' | 'desc' = 'asc';

let drillColumns: { name: string; type: string }[] = [];
let drillRows: any[][] = [];
let drillTotal = 0;
let drillFilters: any[] = [];
let drillReason = '';
let drillSeq = 0; // request generation — a late reply for an older query is dropped
let drillSearchTimer = 0;

function drillQ(sel: string): HTMLElement | null {
  return drillRoot ? (drillRoot.querySelector(sel) as HTMLElement | null) : null;
}

/** Clone the template once and wire the controls that never change. */
function drillEnsureRoot(): HTMLElement | null {
  if (drillRoot) return drillRoot;
  const tpl = document.getElementById('drill-tpl') as HTMLTemplateElement | null;
  if (!tpl || !tpl.content) return null;
  const frag = tpl.content.cloneNode(true) as DocumentFragment;
  drillRoot = frag.firstElementChild as HTMLElement;
  document.body.appendChild(drillRoot);

  const close = (): void => closeDrillPanel();
  drillQ('.js-drill-x')?.addEventListener('click', close);
  drillQ('.js-drill-close')?.addEventListener('click', close);
  // Backdrop click, but only the backdrop itself — a click that started inside
  // the panel and ended on it (a drag-select over the grid) must not close.
  drillRoot.addEventListener('click', (e) => {
    if (e.target === drillRoot) close();
  });

  const search = drillQ('.js-drill-search') as HTMLInputElement | null;
  search?.addEventListener('input', () => {
    if (drillSearchTimer) window.clearTimeout(drillSearchTimer);
    drillSearchTimer = window.setTimeout(() => {
      drillSearchTimer = 0;
      drillSearch = search.value;
      drillOffset = 0; // a new query starts at the top, not wherever page 7 was
      void drillFetch();
    }, DRILL_SEARCH_MS);
  });

  drillQ('.js-drill-export')?.addEventListener('click', () => {
    void exportDrillRows();
  });

  // Escape closes; Tab cycles WITHIN the panel. Bound on the panel rather than
  // the document so it cannot swallow keys meant for anything else.
  drillRoot.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = drillFocusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !drillRoot!.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  return drillRoot;
}

/** Every focusable control currently inside the panel, in DOM order. */
function drillFocusables(): HTMLElement[] {
  if (!drillRoot) return [];
  const sel = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(drillRoot.querySelectorAll(sel)).filter(
    (el) => (el as HTMLElement).offsetParent !== null,
  ) as HTMLElement[];
}

/**
 * Open the panel for a visual, optionally for ONE clicked mark.
 *
 * `filters` must be the same list that was passed to `visual:data` for the
 * figure being explained — that is what makes the rows and the number agree,
 * and it is why the CALLER resolves it (a published card resolves its frozen
 * `card.visual`, not a possibly-edited source visual).
 */
function openDrillPanel(opts: DrillOpts): void {
  const root = drillEnsureRoot();
  if (!root || !opts || !opts.projectId || !opts.datasetId) return;

  drillOpts = opts;
  drillOffset = 0;
  drillSearch = '';
  drillSortCol = '';
  drillSortDir = 'asc';
  drillColumns = [];
  drillRows = [];
  drillTotal = 0;
  drillFilters = [];
  drillReason = '';
  if (drillSearchTimer) {
    window.clearTimeout(drillSearchTimer);
    drillSearchTimer = 0;
  }

  const search = drillQ('.js-drill-search') as HTMLInputElement | null;
  if (search) search.value = '';

  const title = drillQ('#drill-title');
  if (title) title.textContent = opts.name && opts.name.trim() ? opts.name : 'Underlying rows';
  const sub = drillQ('.js-drill-sub');
  if (sub) sub.textContent = opts.mark ? 'The rows behind the selected mark' : 'The rows behind this visual';

  drillTrigger = opts.trigger || null;
  drillPrevFocus = document.activeElement as HTMLElement | null;
  if (drillTrigger) drillTrigger.setAttribute('aria-expanded', 'true');

  root.hidden = false;
  document.body.classList.add('drill-open');
  drillRender();
  void drillFetch();

  // Focus lands on the panel's first control, so the keyboard is inside it.
  const first = drillFocusables()[0];
  if (first) first.focus();
}

function closeDrillPanel(): void {
  if (!drillRoot || drillRoot.hidden) return;
  drillRoot.hidden = true;
  document.body.classList.remove('drill-open');
  if (drillSearchTimer) {
    window.clearTimeout(drillSearchTimer);
    drillSearchTimer = 0;
  }
  drillSeq += 1; // any reply still in flight is now stale
  if (drillTrigger) drillTrigger.setAttribute('aria-expanded', 'false');
  const back = drillTrigger || drillPrevFocus;
  if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
  drillTrigger = null;
  drillPrevFocus = null;
  drillOpts = null;
}

/** One round-trip to main for the window the grid is about to draw. */
async function drillFetch(): Promise<void> {
  if (!drillOpts) return;
  const seq = ++drillSeq;
  const o = drillOpts;
  const bridge = (window.hub as any).visualRows;
  let res: any = null;
  if (typeof bridge === 'function') {
    try {
      res = await bridge(o.projectId, o.datasetId, o.encoding, o.filters || [], o.mark || null, {
        offset: drillOffset,
        limit: DRILL_PAGE_ROWS,
        search: drillSearch.trim(),
        sortColumn: drillSortCol,
        sortDir: drillSortDir,
      });
    } catch (_) {
      res = null;
    }
  }
  if (seq !== drillSeq) return; // a newer request already won

  if (!res || res.ok !== true) {
    drillReason = (res && res.error) || 'Could not read the underlying rows.';
    drillRows = [];
    drillTotal = 0;
  } else if (res.available === false) {
    // The honest answer. No grid, no approximate set — just why.
    drillReason = String(res.reason || 'These rows cannot be identified exactly.');
    drillRows = [];
    drillTotal = 0;
    drillFilters = [];
  } else {
    drillReason = '';
    drillColumns = Array.isArray(res.columns) ? res.columns : [];
    drillRows = Array.isArray(res.rows) ? res.rows : [];
    drillTotal = typeof res.total === 'number' ? res.total : drillRows.length;
    drillOffset = typeof res.offset === 'number' ? res.offset : drillOffset;
    drillFilters = Array.isArray(res.filters) ? res.filters : [];
  }
  drillRender();
}

// ── Painting ────────────────────────────────────────────────────────────────

function drillRender(): void {
  drillRenderChips();
  drillRenderCount();

  const note = drillQ('.js-drill-note');
  const scroll = drillQ('.js-drill-scroll');
  const tools = drillQ('.drill-tools');
  const exportBtn = drillQ('.js-drill-export') as HTMLButtonElement | null;
  const refused = drillReason !== '';

  if (note) {
    note.hidden = !refused;
    note.textContent = drillReason;
  }
  if (tools) tools.hidden = refused;
  if (exportBtn) exportBtn.disabled = refused || drillTotal === 0;
  if (scroll) {
    scroll.hidden = refused;
    if (!refused) drillPaintTable(scroll);
  }
  drillPaintPager();
}

function drillRenderChips(): void {
  const wrap = drillQ('.js-drill-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.hidden = drillFilters.length === 0;
  drillFilters.forEach((f) => {
    const chip = document.createElement('span');
    chip.className = 'drill-chip';
    // textContent ONLY — a chip is a label, never markup, and these strings are
    // user data straight out of the dataset.
    chip.textContent = drillChipText(f);
    wrap.appendChild(chip);
  });
}

/** A filter step as a short human label: `Region = North`. */
function drillChipText(f: any): string {
  if (!f || typeof f !== 'object') return '';
  const col = String(f.column ?? '');
  const op = String(f.op ?? '');
  if (op === 'period') return col + ': ' + periodLabel(f.period);
  if (op === 'is_empty') return col + ' is empty';
  if (op === 'not_empty') return col + ' is not empty';
  if (op === 'in' || op === 'not in') {
    const vals = Array.isArray(f.values) ? f.values : [];
    const shown = vals.slice(0, 3).map((v: any) => (v == null ? '' : String(v)));
    const more = vals.length > shown.length ? ` +${vals.length - shown.length}` : '';
    return `${col} ${op} (${shown.join(', ')}${more})`;
  }
  const v = f.value == null ? '' : String(f.value);
  return `${col} ${op} ${v}`;
}

function drillRenderCount(): void {
  const el = drillQ('.js-drill-count');
  if (!el) return;
  if (drillReason !== '') {
    el.textContent = '';
    return;
  }
  el.textContent = drillTotal === 1 ? '1 row' : drillTotal.toLocaleString() + ' rows';
}

function drillPaintTable(scroll: HTMLElement): void {
  scroll.innerHTML = '';
  if (drillColumns.length === 0) return;

  const table = document.createElement('table');
  table.className = 'ds-table drill-table';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  drillColumns.forEach((col) => {
    const th = document.createElement('th');
    th.className = 'ds-th';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drill-th-btn';
    const nm = document.createElement('span');
    nm.textContent = col.name;                     // data — textContent, never innerHTML
    btn.appendChild(nm);
    if (drillSortCol === col.name) {
      btn.appendChild(icon(drillSortDir === 'asc' ? 'chevron-up' : 'chevron-down'));
    }
    btn.setAttribute(
      'aria-label',
      'Sort by ' + col.name + (drillSortCol === col.name && drillSortDir === 'asc' ? ', descending' : ', ascending'),
    );
    btn.addEventListener('click', () => drillSortBy(col.name));
    th.appendChild(btn);
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  drillRows.forEach((row) => {
    const tr = document.createElement('tr');
    const cells: any[] = Array.isArray(row) ? row : [];
    drillColumns.forEach((_, c) => {
      const td = document.createElement('td');
      td.className = 'ds-td';
      const v = cells[c];
      td.textContent = v == null ? '' : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);

  if (drillRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'drill-empty';
    empty.textContent = drillSearch.trim() ? 'No rows match that search.' : 'No rows.';
    scroll.appendChild(empty);
  }
}

function drillSortBy(name: string): void {
  if (drillSortCol === name) {
    drillSortDir = drillSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    drillSortCol = name;
    drillSortDir = 'asc';
  }
  drillOffset = 0;
  void drillFetch();
}

/**
 * Write the CURRENT row set to a CSV file.
 *
 * Main re-resolves the drill from the same arguments and re-reads the same
 * filtered, searched, sorted set, so the file is the grid — not the window on
 * screen, and not the unfiltered table. The renderer sends arguments, never
 * rows: shipping the set here to write it is the pattern this whole feature
 * avoids, and the panel only ever holds one page anyway.
 */
async function exportDrillRows(): Promise<void> {
  if (!drillOpts || drillReason !== '' || drillTotal === 0) return;
  const o = drillOpts;
  const btn = drillQ('.js-drill-export') as HTMLButtonElement | null;
  const bridge = (window.hub as any).exportVisualRows;
  if (typeof bridge !== 'function') return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Exporting…';
  }
  let res: any = null;
  try {
    res = await bridge(o.projectId, o.datasetId, o.encoding, o.filters || [], o.mark || null, {
      search: drillSearch.trim(),
      sortColumn: drillSortCol,
      sortDir: drillSortDir,
    }, o.name || '');
  } catch (_) {
    res = null;
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Export these rows (CSV)';
  }
  if (!res || res.canceled) return;
  if (typeof showToast === 'function') {
    if (res.ok) {
      const file = String(res.dest || '').split(/[\\/]/).pop();
      showToast(`Exported ${Number(res.rows || 0).toLocaleString()} rows → ${file}`);
    } else {
      showToast(res.error || 'Could not export these rows');
    }
  }
}

function drillPaintPager(): void {
  const pager = drillQ('.js-drill-pager');
  if (!pager) return;
  pager.innerHTML = '';
  if (drillReason !== '' || drillTotal <= DRILL_PAGE_ROWS) return;

  const first = drillTotal === 0 ? 0 : drillOffset + 1;
  const last = Math.min(drillOffset + drillRows.length, drillTotal);
  const label = document.createElement('span');
  label.textContent = `Rows ${first.toLocaleString()}–${last.toLocaleString()} of ${drillTotal.toLocaleString()}`;
  pager.appendChild(label);

  // `side` says which end the chevron sits on: iconLabel() only ever leads.
  const mk = (
    name: string,
    label: string,
    side: 'left' | 'right',
    delta: number,
    disabled: boolean,
  ): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm drill-page-btn';
    const span = document.createElement('span');
    span.textContent = label;
    if (side === 'left') btn.append(icon(name), span);
    else btn.append(span, icon(name));
    btn.disabled = disabled;
    btn.addEventListener('click', () => {
      const next = drillOffset + delta * DRILL_PAGE_ROWS;
      if (next < 0 || next >= drillTotal) return;
      drillOffset = next;
      void drillFetch();
    });
    pager.appendChild(btn);
  };
  mk('chevron-left', 'Prev', 'left', -1, drillOffset <= 0);
  mk('chevron-right', 'Next', 'right', 1, drillOffset + DRILL_PAGE_ROWS >= drillTotal);
}
