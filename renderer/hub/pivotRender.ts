// The pivot table — a real <table>, not a canvas.
//
// It is the sibling of chartTable.js (`buildDataTable`) rather than of
// chartRender.js: no Chart.js instance, no chart id, nothing on a canvas. Its
// whole job is DOM, over the `data.pivot` grid main already computed. Every
// figure here is app-computed; this file FORMATS and LAYS OUT, and computes
// nothing except the one ratio a tooltip needs ("of total") and the 0..1
// position a conditional ramp needs — both of which are ratios of two figures
// that are already on the screen.
//
// Loads after chartPalette.js (for `getCSSVar`) and before renderResult.js,
// which dispatches to it. Classic global-scope script — NO import/export.
//
// Cells are written with textContent / append only — never innerHTML with data
// in it — so a dimension value containing markup renders as text.
//
// VIRTUALISATION. Above PIVOT_VIRT_MIN rows the tbody renders a window of rows
// plus spacer rows above and below, and re-renders on scroll. It is deliberately
// a plain fixed-height window and not a measured one: `--pivot-row-h` is the
// single source of the row height for both the CSS and the arithmetic here, so
// there is nothing to measure and nothing to drift.

/** `analysis/pivotData.PivotGrid`, as it arrives over IPC. */
interface PivotGridShape {
  rowHeaders: string[][];
  colHeaders: string[][];
  cells: (number | null)[][];
  rowTotals: (number | null)[][] | null;
  colTotals: (number | null)[] | null;
  grand: (number | null)[] | null;
  rowKinds: Array<'leaf' | 'subtotal'>;
  valueNames: string[];
  valueCount: number;
  showAs: string[];
  formats: string[];
  conditional: Array<{ valueIdx: number; kind: string; threshold?: number }>;
  sort: { by: 'label' | number; dir: 'asc' | 'desc' } | null;
  rowGroupCount: number;
  colGroupCount: number;
  truncated: boolean;
  /** Table calculations (analysis/pivotCalc.ts): per value, and the cells before them. */
  calcs?: Array<TcCalc | null>;
  rawCells?: (number | null)[][];
}

interface PivotViewOpts {
  /**
   * Re-sort: the caller recomputes the grid with this sort and renders again.
   * Sorting is MAIN's job — it reorders siblings at every level of the
   * hierarchy, over figures only main has — so the header click asks rather
   * than rearranges. Absent means the headers are labels, not buttons: a
   * surface that cannot recompute must not offer a control that does nothing.
   */
  onSort?: (sort: { by: 'label' | number; dir: 'asc' | 'desc' }) => void;
  /** Read-only surfaces (a published tile, an export preview) pass false. */
  interactive?: boolean;
}

/** Rows above which the tbody is windowed rather than fully built. */
const PIVOT_VIRT_MIN = 200;
/** Rows drawn beyond the visible window, so a fast scroll does not flash blank. */
const PIVOT_VIRT_PAD = 20;

/** The one row height, read back from the token the CSS also uses. */
function pivotRowHeight(host: HTMLElement): number {
  const raw = getCSSVar('--pivot-row-h', host) || getCSSVar('--pivot-row-h') || '32px';
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 32;
}

/** A figure as this grid shows it — the app formatter, or a percentage. */
function pivotFmt(v: number | null | undefined, showAs: string, format: string, calcKind = ''): string {
  if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return '–';
  // A table calculation formats as its kind (calcMenu.ts); it wins over showAs.
  if (calcKind) return tcCalcValueText(calcKind, v);
  if (showAs === 'pct_row' || showAs === 'pct_col' || showAs === 'pct_total') {
    return (v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%';
  }
  if (showAs === 'rank') return String(v);
  return fmtWith(v, format || 'auto');
}

/** Which value field a grid column carries. */
const pivotValueOf = (grid: PivotGridShape, col: number): number =>
  grid.valueCount > 0 ? col % grid.valueCount : 0;

// ── Conditional formatting ───────────────────────────────────────────────────
//
// Painting reads the LEAF cells of the value's own columns for its range: a
// subtotal is bigger than its children by construction and would flatten every
// ramp it was included in.

interface CondRange { lo: number; hi: number }

function pivotCondRanges(grid: PivotGridShape): Map<number, CondRange> {
  const out = new Map<number, CondRange>();
  for (const rule of grid.conditional || []) {
    if (out.has(rule.valueIdx)) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = 0; r < grid.cells.length; r += 1) {
      if (grid.rowKinds[r] !== 'leaf') continue;
      for (let c = rule.valueIdx; c < grid.cells[r].length; c += grid.valueCount) {
        const v = grid.cells[r][c];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo <= hi) out.set(rule.valueIdx, { lo, hi });
  }
  return out;
}

/** 0..1 within the value's own range; 0 when every cell is the same figure. */
function pivotPos(v: number, range: CondRange): number {
  if (range.hi === range.lo) return 0;
  return Math.min(1, Math.max(0, (v - range.lo) / (range.hi - range.lo)));
}

function paintCell(
  td: HTMLElement,
  v: number | null,
  rule: { kind: string; threshold?: number } | undefined,
  range: CondRange | undefined,
): void {
  if (!rule || v == null || typeof v !== 'number' || !Number.isFinite(v)) return;
  if (rule.kind === 'threshold') {
    const line = typeof rule.threshold === 'number' ? rule.threshold : 0;
    td.classList.add(v >= line ? 'is-above' : 'is-below');
    return;
  }
  if (!range) return;
  const pos = pivotPos(v, range);
  if (rule.kind === 'scale') {
    // A three-stop ramp in --chart-1's own hue: transparent at the bottom, a
    // wash in the middle, the token at 28% at the top. `color-mix` keeps it one
    // token rather than three hand-picked tints that a style preset would miss.
    td.style.background = `color-mix(in srgb, var(--chart-1) ${(pos * 28).toFixed(1)}%, transparent)`;
    return;
  }
  if (rule.kind === 'bars') {
    td.classList.add('has-bar');
    // The bar is a background gradient rather than an extra element: a cell
    // with a child div stops being a plain right-aligned figure.
    const pct = (pos * 100).toFixed(1);
    td.style.background =
      `linear-gradient(to left, color-mix(in srgb, var(--chart-1) 22%, transparent) ${pct}%,` +
      ` transparent ${pct}%)`;
  }
}

// ── The tooltip ──────────────────────────────────────────────────────────────

let pivotTipEl: HTMLElement | null = null;

function pivotHideTip(): void {
  if (pivotTipEl) { pivotTipEl.remove(); pivotTipEl = null; }
}

function pivotShowTip(anchor: HTMLElement, lines: string[]): void {
  pivotHideTip();
  const tip = document.createElement('div');
  tip.className = 'tip pivot-tip';
  lines.forEach((line, i) => {
    if (i > 0) tip.appendChild(document.createElement('br'));
    tip.appendChild(document.createTextNode(line));
  });
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, r.left)) + 'px';
  tip.style.top = Math.max(8, r.top - tip.offsetHeight - 6) + 'px';
  pivotTipEl = tip;
}

// ── The renderer ─────────────────────────────────────────────────────────────

/**
 * Draw `grid` into `container`. Returns nothing: like `buildDataTable`, the DOM
 * IS the result. Safe to call repeatedly — the container is cleared first.
 *
 * Collapse and sort are VIEW state held on the mounted element, in the same
 * spirit as the drill panel's: a re-render from new data resets them, because
 * a collapsed level of a grid that no longer has that level is meaningless.
 */
function renderPivotTable(
  container: HTMLElement,
  grid: PivotGridShape | null | undefined,
  opts?: PivotViewOpts,
): void {
  container.innerHTML = '';
  if (!grid || !Array.isArray(grid.cells)) {
    const m = document.createElement('div');
    m.className = 'cv-chart-fallback';
    m.textContent = 'Pick a row dimension and at least one value to build a pivot.';
    container.appendChild(m);
    return;
  }

  const o = opts || {};
  const interactive = o.interactive !== false && typeof o.onSort === 'function';
  const wrap = document.createElement('div');
  wrap.className = 'pivot-wrap';
  container.appendChild(wrap);

  if (grid.truncated) {
    const note = document.createElement('div');
    note.className = 'pivot-note';
    note.textContent =
      `Showing the first ${grid.rowGroupCount.toLocaleString()} row groups and ` +
      `${grid.colGroupCount.toLocaleString()} column groups — narrow the pivot with a filter or Top N to see the rest.`;
    wrap.appendChild(note);
  }

  const scroller = document.createElement('div');
  scroller.className = 'pivot-scroll';
  wrap.appendChild(scroller);

  const table = document.createElement('table');
  table.className = 'pivot-table';
  scroller.appendChild(table);

  // Collapsed row PATHS, by their joined key. A subtotal row's descendants are
  // the rows whose header path starts with it.
  const collapsed = new Set<string>();
  const pathKey = (p: string[]): string => p.join(' ');
  const isHidden = (r: number): boolean => {
    const p = grid.rowHeaders[r];
    for (let d = 1; d < p.length; d += 1) if (collapsed.has(pathKey(p.slice(0, d)))) return true;
    return false;
  };

  const ranges = pivotCondRanges(grid);
  const ruleFor = new Map<number, { kind: string; threshold?: number }>();
  for (const rule of grid.conditional || []) if (!ruleFor.has(rule.valueIdx)) ruleFor.set(rule.valueIdx, rule);

  const draw = (): void => {
    table.innerHTML = '';
    table.appendChild(pivotHead(grid, o, interactive));
    const visible: number[] = [];
    for (let r = 0; r < grid.cells.length; r += 1) if (!isHidden(r)) visible.push(r);
    const body = document.createElement('tbody');
    table.appendChild(body);

    const rowH = pivotRowHeight(container);
    const virtual = visible.length > PIVOT_VIRT_MIN;

    const fill = (): void => {
      body.innerHTML = '';
      let from = 0;
      let to = visible.length;
      if (virtual) {
        const top = scroller.scrollTop;
        const h = scroller.clientHeight || 400;
        from = Math.max(0, Math.floor(top / rowH) - PIVOT_VIRT_PAD);
        to = Math.min(visible.length, Math.ceil((top + h) / rowH) + PIVOT_VIRT_PAD);
        if (from > 0) body.appendChild(pivotSpacer(from * rowH, grid));
      }
      for (let i = from; i < to; i += 1) {
        body.appendChild(pivotBodyRow(grid, visible[i], {
          collapsed, pathKey, interactive,
          onToggle: (key) => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); draw(); },
          ruleFor, ranges,
        }));
      }
      if (virtual && to < visible.length) body.appendChild(pivotSpacer((visible.length - to) * rowH, grid));
    };
    fill();

    if (virtual) {
      let queued = false;
      scroller.onscroll = (): void => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; fill(); });
      };
    } else {
      scroller.onscroll = null;
    }

    const foot = pivotFoot(grid);
    if (foot) table.appendChild(foot);
  };
  draw();
}

/** One spacer row standing in for the rows outside the window. */
function pivotSpacer(height: number, grid: PivotGridShape): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'pivot-spacer';
  const td = document.createElement('td');
  td.colSpan = 1 + grid.colHeaders.length + (grid.rowTotals ? grid.valueCount : 0);
  td.style.height = height + 'px';
  tr.appendChild(td);
  return tr;
}

/**
 * The header: one <tr> per column-dimension level, with equal consecutive
 * parents MERGED into one cell, then the value-name row when the values need
 * naming. A single-level header is one row, which is the common case.
 */
function pivotHead(grid: PivotGridShape, opts: PivotViewOpts, interactive: boolean): HTMLTableSectionElement {
  const thead = document.createElement('thead');
  const depth = grid.colHeaders.length ? Math.max(...grid.colHeaders.map((h) => h.length)) : 1;
  const sort = grid.sort || null;

  for (let level = 0; level < depth; level += 1) {
    const tr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'pivot-corner';
    // The corner spans every header level and carries the label sort.
    if (level === 0) {
      corner.rowSpan = depth;
      if (interactive) {
        corner.appendChild(pivotSortButton('', sort && sort.by === 'label' ? sort.dir : null, () => {
          const dir = sort && sort.by === 'label' && sort.dir === 'asc' ? 'desc' : 'asc';
          if (opts.onSort) opts.onSort({ by: 'label', dir });
        }));
      }
      tr.appendChild(corner);
    }

    let c = 0;
    while (c < grid.colHeaders.length) {
      const label = grid.colHeaders[c][level] ?? '';
      let span = 1;
      // Merge only while the WHOLE prefix matches — two different regions that
      // happen to share a sub-label are two headers, not one.
      while (
        c + span < grid.colHeaders.length
        && (grid.colHeaders[c + span][level] ?? '') === label
        && samePrefix(grid.colHeaders[c], grid.colHeaders[c + span], level)
      ) span += 1;

      const th = document.createElement('th');
      th.className = 'pivot-col-head';
      if (span > 1) th.colSpan = span;
      const leafLevel = level === depth - 1;
      if (interactive && leafLevel) {
        const dir = sort && sort.by === c ? sort.dir : null;
        const col = c;
        th.appendChild(pivotSortButton(label, dir, () => {
          const next = sort && sort.by === col && sort.dir === 'desc' ? 'asc' : 'desc';
          if (opts.onSort) opts.onSort({ by: col, dir: next });
        }));
      } else {
        th.textContent = label;
      }
      tr.appendChild(th);
      c += span;
    }

    if (grid.rowTotals && level === 0) {
      const th = document.createElement('th');
      th.className = 'pivot-col-head pivot-total-head';
      th.rowSpan = depth;
      if (grid.valueCount > 1) th.colSpan = grid.valueCount;
      th.textContent = 'Total';
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }
  return thead;
}

function samePrefix(a: string[], b: string[], level: number): boolean {
  for (let i = 0; i < level; i += 1) if ((a[i] ?? '') !== (b[i] ?? '')) return false;
  return true;
}

/** A header label that is also the sort control. The arrow says which way. */
function pivotSortButton(label: string, dir: 'asc' | 'desc' | null, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pivot-sort' + (dir ? ' is-sorted' : '');
  b.appendChild(document.createTextNode(label));
  const arrow = document.createElement('span');
  arrow.className = 'pivot-arrow';
  arrow.textContent = dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '';
  arrow.setAttribute('aria-hidden', 'true');
  b.appendChild(arrow);
  b.setAttribute('aria-label',
    'Sort by ' + (label || 'label') + (dir === 'asc' ? ', ascending' : dir === 'desc' ? ', descending' : ''));
  b.addEventListener('click', onClick);
  return b;
}

interface BodyRowCtx {
  collapsed: Set<string>;
  pathKey: (p: string[]) => string;
  interactive: boolean;
  onToggle: (key: string) => void;
  ruleFor: Map<number, { kind: string; threshold?: number }>;
  ranges: Map<number, CondRange>;
}

function pivotBodyRow(grid: PivotGridShape, r: number, ctx: BodyRowCtx): HTMLTableRowElement {
  const path = grid.rowHeaders[r];
  const kind = grid.rowKinds[r];
  const tr = document.createElement('tr');
  tr.className = 'pivot-row' + (kind === 'subtotal' ? ' is-subtotal' : '');

  const th = document.createElement('th');
  th.className = 'pivot-row-head';
  th.style.paddingLeft = `calc(var(--sp-8) + ${(path.length - 1)} * var(--sp-12))`;
  const own = path[path.length - 1] ?? '';
  if (kind === 'subtotal' && ctx.interactive) {
    const key = ctx.pathKey(path);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pivot-collapse';
    const closed = ctx.collapsed.has(key);
    btn.setAttribute('aria-expanded', String(!closed));
    btn.setAttribute('aria-label', (closed ? 'Expand ' : 'Collapse ') + own);
    const caret = icon('chevron-down', 12);
    caret.classList.add('pivot-caret');
    if (closed) caret.classList.add('is-closed');
    btn.appendChild(caret);
    btn.appendChild(document.createTextNode(own));
    btn.addEventListener('click', () => ctx.onToggle(key));
    th.appendChild(btn);
  } else {
    th.textContent = own;
  }
  tr.appendChild(th);

  const rowTotal = grid.rowTotals ? grid.rowTotals[r] : null;
  for (let c = 0; c < grid.colHeaders.length; c += 1) {
    const vi = pivotValueOf(grid, c);
    const v = grid.cells[r][c] ?? null;
    const td = document.createElement('td');
    td.className = 'pivot-cell';
    td.textContent = pivotFmt(v, grid.showAs[vi], grid.formats[vi], tcPivotKind(grid, vi));
    if (kind === 'leaf') paintCell(td, v, ctx.ruleFor.get(vi), ctx.ranges.get(vi));
    attachCellTip(td, grid, r, c, v, rowTotal ? rowTotal[vi] : null);
    tr.appendChild(td);
  }

  if (grid.rowTotals) {
    for (let vi = 0; vi < grid.valueCount; vi += 1) {
      const td = document.createElement('td');
      td.className = 'pivot-cell pivot-total-cell';
      // A Total column always shows the FIGURE — a percentage of itself is 100%
      // and says nothing, and the rank of a total has no meaning.
      td.textContent = pivotFmt(rowTotal ? rowTotal[vi] : null, 'value', grid.formats[vi]);
      tr.appendChild(td);
    }
  }
  return tr;
}

/** Row path, column path, the figure, and its share of the row total. */
function attachCellTip(
  td: HTMLElement,
  grid: PivotGridShape,
  r: number,
  c: number,
  v: number | null,
  rowTotal: number | null,
): void {
  td.addEventListener('mouseenter', () => {
    const vi = pivotValueOf(grid, c);
    const lines = [
      (grid.rowHeaders[r] || []).filter(Boolean).join(' · ') || '—',
      (grid.colHeaders[c] || []).filter(Boolean).join(' · ') || grid.valueNames[vi] || '',
      // A calculated cell names both figures: "24.1% of total · 1.25M".
      tcPivotTip(grid, r, c, vi) || pivotFmt(v, grid.showAs[vi], grid.formats[vi]),
    ].filter(Boolean);
    // "of total" only where the cell IS a figure — with a `showAs` in force the
    // cell is already a share, and a share of a share is noise.
    if (!tcPivotKind(grid, vi) && grid.showAs[vi] === 'value' && typeof v === 'number' && typeof rowTotal === 'number' && rowTotal !== 0) {
      lines.push(((v / rowTotal) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '% of total');
    }
    pivotShowTip(td, lines);
  });
  td.addEventListener('mouseleave', pivotHideTip);
}

/** The bottom Total row, when the encoding asked for one. */
function pivotFoot(grid: PivotGridShape): HTMLTableSectionElement | null {
  if (!grid.colTotals && !grid.grand) return null;
  const tfoot = document.createElement('tfoot');
  const tr = document.createElement('tr');
  tr.className = 'pivot-row pivot-grand';
  const th = document.createElement('th');
  th.className = 'pivot-row-head';
  th.textContent = 'Total';
  tr.appendChild(th);
  for (let c = 0; c < grid.colHeaders.length; c += 1) {
    const td = document.createElement('td');
    td.className = 'pivot-cell';
    td.textContent = grid.colTotals
      ? pivotFmt(grid.colTotals[c], 'value', grid.formats[pivotValueOf(grid, c)])
      : '';
    tr.appendChild(td);
  }
  if (grid.rowTotals) {
    for (let vi = 0; vi < grid.valueCount; vi += 1) {
      const td = document.createElement('td');
      td.className = 'pivot-cell pivot-total-cell';
      td.textContent = grid.grand ? pivotFmt(grid.grand[vi], 'value', grid.formats[vi]) : '';
      tr.appendChild(td);
    }
  }
  tfoot.appendChild(tr);
  return tfoot;
}

// ── Copy / export ────────────────────────────────────────────────────────────

/**
 * The grid as TSV — headers, every row (collapsed or not), totals included.
 *
 * Deliberately the FULL grid rather than what is on screen: this is the thing
 * that lands in a spreadsheet, and a paste that silently dropped the rows
 * someone had collapsed for reading would be a trap.
 */
function pivotToRows(grid: PivotGridShape): string[][] {
  const out: string[][] = [];
  const depth = grid.colHeaders.length ? Math.max(...grid.colHeaders.map((h) => h.length)) : 1;
  for (let level = 0; level < depth; level += 1) {
    const head = [''];
    for (const h of grid.colHeaders) head.push(h[level] ?? '');
    if (grid.rowTotals) for (let vi = 0; vi < grid.valueCount; vi += 1) head.push(level === 0 ? 'Total' : '');
    out.push(head);
  }
  grid.cells.forEach((row, r) => {
    const path = grid.rowHeaders[r] || [];
    // Indented with spaces so the hierarchy survives a paste into a cell that
    // has no notion of levels.
    const line = ['  '.repeat(Math.max(0, path.length - 1)) + (path[path.length - 1] ?? '')];
    row.forEach((v, c) => line.push(pivotFmt(v, grid.showAs[pivotValueOf(grid, c)], grid.formats[pivotValueOf(grid, c)],
      tcPivotKind(grid, pivotValueOf(grid, c)))));
    if (grid.rowTotals) {
      for (let vi = 0; vi < grid.valueCount; vi += 1) {
        line.push(pivotFmt(grid.rowTotals[r][vi], 'value', grid.formats[vi]));
      }
    }
    out.push(line);
  });
  if (grid.colTotals || grid.grand) {
    const line = ['Total'];
    for (let c = 0; c < grid.colHeaders.length; c += 1) {
      line.push(grid.colTotals ? pivotFmt(grid.colTotals[c], 'value', grid.formats[pivotValueOf(grid, c)]) : '');
    }
    if (grid.rowTotals) {
      for (let vi = 0; vi < grid.valueCount; vi += 1) {
        line.push(grid.grand ? pivotFmt(grid.grand[vi], 'value', grid.formats[vi]) : '');
      }
    }
    out.push(line);
  }
  return out;
}

function pivotToTsv(grid: PivotGridShape): string {
  // A tab or a newline inside a dimension value would break the paste into a
  // spreadsheet, so both become a space. Nothing else is escaped: TSV has no
  // quoting, which is exactly why CSV exists beside it.
  const clean = (s: string): string => String(s).replace(/[\t\r\n]+/g, ' ');
  return pivotToRows(grid).map((r) => r.map(clean).join('\t')).join('\n');
}

function pivotToCsv(grid: PivotGridShape): string {
  const cell = (s: string): string => {
    const v = String(s);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return pivotToRows(grid).map((r) => r.map(cell).join(',')).join('\r\n');
}

/**
 * A dashboard tile's pivot actions, and where the grid they act on is kept.
 *
 * They live HERE rather than in dashGrid.ts because they are about the GRID,
 * not about the tile: copying a pivot as a table means the same thing wherever
 * the pivot is, and dashGrid was at its line cap besides. The tile's only part
 * in it is parking the grid it drew.
 */
function setPivotGridOnCard(cardEl: Element | null, grid: PivotGridShape | null | undefined, src?: any): void {
  // Cleared on a non-pivot, so a card whose chart type changed cannot leave a
  // stale grid behind its menu. `src` (project/dataset/encoding) is what lets
  // the share policy shape the grid on its way out.
  if (cardEl) {
    (cardEl as any)._pivotGrid = grid || null;
    (cardEl as any)._pivotSrc = grid ? src || null : null;
  }
}

/** `[label, run]` pairs for the card's ⋯ menu — empty when the card is not a pivot. */
function pivotMenuItems(cardEl: Element | null, title: string): Array<[string, () => void]> {
  const grid: PivotGridShape | null = (cardEl && (cardEl as any)._pivotGrid) || null;
  if (!grid) return [];
  // Both actions put the grid outside the app, so its headers go through the
  // Share policy first (privacyShare.ts). null = declined or hidden.
  const shaped = async (): Promise<PivotGridShape | null> => {
    const out = await pvShareData((cardEl as any)._pivotSrc || null, { labels: [], series: [], pivot: grid }, 'export');
    return out && out.pivot ? out.pivot : null;
  };
  return [
    ['Copy as table', async () => {
      const g = await shaped();
      if (!g) return;
      try {
        window.hub.copyText(pivotToTsv(g));
        if (typeof showToast === 'function') showToast('Table copied');
      } catch (_) { /* the clipboard is best-effort here, as everywhere else */ }
    }],
    ['Export CSV', async () => {
      const g = await shaped();
      if (!g) return;
      const safe = String(title || 'pivot').replace(/[^\w .-]+/g, '_').slice(0, 60) || 'pivot';
      // Through the SAME native save panel as every other export: the user
      // picks the one file, and the app needs no folder entitlement.
      window.hub.saveCsv(pivotToCsv(g), safe + '.csv').catch(() => {});
    }],
  ];
}
