'use strict';

// Virtual scrolling for the dataset grid (dsGrid.ts). Classic global-scope
// <script>: no import/export. Loads before dsGrid.js.
//
// The grid used to draw 500 rows and page with Prev/Next. Now the scroll box
// is as tall as the WHOLE result (rows × a fixed row height) and only the rows
// in view — plus DSV_PAD either side — exist in the DOM; spacer rows above and
// below hold the scroll height. Rows arrive in blocks of DS_PAGE_ROWS from
// `datasetPage` (search, sort and the quality-rule filter all still run in
// MAIN against the Parquet), fetched as the viewport reaches them and kept
// until the query changes. A million rows scroll like a hundred: the DOM never
// holds more than ~one screen, and main never hydrates the table.
//
// The fixed height is the whole trick — `--ds-row-h` in platform.css is the one
// source of it for both the CSS and the arithmetic here, so there is nothing
// to measure and nothing to drift (the same rule pivotRender.ts follows).

/** Rows drawn beyond the viewport, so a fast scroll does not flash blank. */
const DSV_PAD = 40;
const DSV_FALLBACK_ROW_H = 28;
/**
 * The tallest scroll space the grid asks for. Chromium clamps an element's
 * height at 16,777,215 px, and a million 28 px rows is 28 M — past it the
 * bottom half of the table simply cannot be scrolled to. Above this height the
 * spacers COMPRESS: each row stands for less than its height in scroll space
 * (the rows actually drawn keep their real height), so the whole range stays
 * reachable. Well under the clamp, on purpose.
 */
const DSV_MAX_SCROLL_PX = 8_000_000;

/** Scroll pixels per row: the row height, or less once the table would pass the cap. */
function dsvScrollPerRow(h: number): number {
  return expTotal * h > DSV_MAX_SCROLL_PX ? DSV_MAX_SCROLL_PX / expTotal : h;
}

/** The rows fetched so far for the current query, by block index. */
let dsvBlocks = new Map<number, ExpCell[][]>();
/** Blocks requested and not yet back. */
const dsvLoading = new Set<number>();
/** The whole result, when main could not serve windows (the client-side fallback). */
let dsvAll: ExpCell[][] | null = null;
/** Bumped on every query change; a late block for an older query is dropped. */
let dsvGen = 0;
let dsvFrame = 0;
let dsvWired: HTMLElement | null = null;

function dsvRowHeight(): number {
  const host = dsEl('ds-explorer-scroll');
  const v = host ? parseFloat(getComputedStyle(host).getPropertyValue('--ds-row-h')) : NaN;
  return Number.isFinite(v) && v > 0 ? v : DSV_FALLBACK_ROW_H;
}

/** Forget every fetched row — a new query, a prepare step, a reopen. */
function dsvReset(): void {
  dsvGen++;
  dsvBlocks = new Map();
  dsvLoading.clear();
  dsvAll = null;
}

/** Seed one block (the first fetch comes back through refreshExplorerPage). */
function dsvPut(offset: number, rows: ExpCell[][]): void {
  dsvBlocks.set(Math.floor(offset / DS_PAGE_ROWS), rows);
}

/** The client-side fallback has the whole result already. */
function dsvPutAll(rows: ExpCell[][]): void {
  dsvAll = rows;
}

function dsvRow(i: number): ExpCell[] | undefined {
  if (dsvAll) return dsvAll[i];
  const block = dsvBlocks.get(Math.floor(i / DS_PAGE_ROWS));
  return block ? block[i % DS_PAGE_ROWS] : undefined;
}

/** First and last row index (inclusive) to draw for the current scroll position. */
function dsvRange(host: HTMLElement): { first: number; last: number } {
  const h = dsvRowHeight();
  const head = host.querySelector('thead') as HTMLElement | null;
  const top = Math.max(0, host.scrollTop - (head ? head.offsetHeight : 0));
  // Capped: a scroll box that lost its height limit (a CSS change) must degrade
  // to a short grid, never to a million <tr>s.
  const inView = Math.min(200, Math.ceil((host.clientHeight || 400) / h));
  const at = Math.min(expTotal - 1, Math.floor(top / dsvScrollPerRow(h)));
  const first = Math.max(0, at - DSV_PAD);
  const last = Math.min(expTotal - 1, at + inView + DSV_PAD);
  return { first, last };
}

/** Fetch every block the range touches that is not in hand yet. */
function dsvEnsure(first: number, last: number): void {
  if (dsvAll || !expId || last < first) return;
  const page = datasetPageBridge();
  if (!page && !dqGridRule) return;
  for (let b = Math.floor(first / DS_PAGE_ROWS); b <= Math.floor(last / DS_PAGE_ROWS); b++) {
    if (dsvBlocks.has(b) || dsvLoading.has(b)) continue;
    dsvLoading.add(b);
    const gen = dsvGen;
    const wantId = expId;
    const req: DatasetPageReq = {
      offset: b * DS_PAGE_ROWS,
      limit: DS_PAGE_ROWS,
      search: expSearch.trim(),
      sortColumn: expSortColumnName(),
      sortDir: expSortDir === 1 ? 'asc' : 'desc',
    };
    void (async () => {
      let res: any = null;
      try {
        if (dqGridRule && currentProjectId) res = await window.hub.qualityFailingRows(currentProjectId, wantId, dqGridRule.id, req);
        else if (page && currentProjectId) res = await page(currentProjectId, wantId, req);
      } catch (_) { res = null; }
      if (gen !== dsvGen || wantId !== expId) return; // the query moved on
      dsvLoading.delete(b);
      if (res && res.ok === true && Array.isArray(res.rows)) {
        dsvBlocks.set(b, res.rows);
        if (typeof res.total === 'number') expTotal = res.total;
        dsvPaintBody();
      }
    })();
  }
}

/** Build the tbody for the rows in view: spacer, rows, spacer. */
function dsvBuildBody(host: HTMLElement): HTMLTableSectionElement {
  const tbody = document.createElement('tbody');
  const visible = expColumns.map((_, c) => c).filter((c) => !expHidden.has(c));
  if (expTotal === 0) return tbody;
  const { first, last } = dsvRange(host);
  const per = dsvScrollPerRow(dsvRowHeight());
  const spacer = (rows: number): void => {
    if (rows <= 0) return;
    const tr = document.createElement('tr');
    tr.className = 'ds-vspacer';
    tr.setAttribute('aria-hidden', 'true');
    const td = document.createElement('td');
    td.colSpan = Math.max(1, visible.length);
    td.style.height = Math.round(rows * per) + 'px';
    tr.appendChild(td);
    tbody.appendChild(tr);
  };
  spacer(first);
  const drawn: ExpCell[][] = [];
  for (let i = first; i <= last; i++) {
    const cells = dsvRow(i);
    const tr = document.createElement('tr');
    tr.setAttribute('aria-rowindex', String(i + 2)); // +1 for 1-based, +1 for the header row
    if (!cells) tr.className = 'ds-tr-loading';
    else drawn.push(cells);
    for (const c of visible) {
      const td = document.createElement('td');
      td.className = 'ds-td';
      const v = cells ? cells[c] : null;
      // A number reads grouped, in the workspace's marks, without float noise
      // (1565150.4600000004 → 1,565,150.46). Display only — the cell is exact.
      if (typeof v === 'number' && Number.isFinite(v)) {
        td.textContent = OrdFormat.formatNumber(v, { maxDecimals: 4 });
        td.classList.add('ds-td-num');
      } else td.textContent = v == null ? '' : String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  spacer(expTotal - 1 - last);
  // The window in hand, for the surfaces that read "the rows on screen"
  // (the profile panel's samples, the catalog's example values).
  expPageRows = drawn;
  expOffset = first;
  dsvEnsure(first, last);
  return tbody;
}

/** Repaint only the body — a scroll, or a block arriving. */
function dsvPaintBody(): void {
  const host = dsEl('ds-explorer-scroll');
  const table = host ? (host.querySelector('table.ds-table') as HTMLTableElement | null) : null;
  if (!host || !table) return;
  const old = table.tBodies[0];
  const next = dsvBuildBody(host);
  if (old) table.replaceChild(next, old);
  else table.appendChild(next);
  paintExplorerPager();
}

/** Scroll → repaint on the next frame (at most once per frame). */
function dsvWire(host: HTMLElement): void {
  if (dsvWired === host) return;
  dsvWired = host;
  host.addEventListener('scroll', () => {
    if (dsvFrame) return;
    dsvFrame = requestAnimationFrame(() => {
      dsvFrame = 0;
      dsvPaintBody();
    });
  }, { passive: true });
}
