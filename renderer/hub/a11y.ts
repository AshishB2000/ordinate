'use strict';

// The ACCESSIBILITY LAYER — the behaviours every surface shares, applied once
// here instead of re-implemented (or forgotten) per panel. Classic global-scope
// renderer <script>, loaded late; scripts/test-a11y.ts holds the app to it.
//
//   live regions   a polite and an assertive region; errors toasts are also
//                  announced assertively, and `a11yAnnounce` says "done".
//   modals         focus stays inside the topmost dialog and returns to the
//                  control that opened it when it closes.
//   menus          role=menu / menuitem, focus on open, ↑↓ Home End, focus back
//                  to the trigger on close (a11yMenu; openMiniMenu calls it).
//   tabs           ←→ Home End move AND select, with a roving tabindex.
//   segmented      a row of toggle buttons is a radiogroup: aria-checked, ←→.
//   lists / grids  ↑↓ (and ←→ in a grid) move between items; Enter opens.
//   icon buttons   an icon-only button with a name gets the same text as its
//                  tooltip, and one with only a tooltip gets it as its name.
//   charts         every chart canvas is role=img, described by the app's own
//                  caption (captions.ts, via main), focusable, and ←→↑↓ walk
//                  its marks with the tooltip following; Enter clicks the mark.

// ── Live regions ────────────────────────────────────────────────────────────

function a11yRegion(id: string, assertive: boolean): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'sr-only';
    el.setAttribute('role', assertive ? 'alert' : 'status');
    el.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
  }
  return el;
}

/** Say something to a screen reader without showing anything. */
function a11yAnnounce(msg: string, assertive = false): void {
  const el = a11yRegion(assertive ? 'a11y-alert' : 'a11y-live', assertive);
  // Clear first: the same sentence twice must be announced twice.
  el.textContent = '';
  window.setTimeout(() => { el.textContent = msg; }, 30);
}

// ── Modals ──────────────────────────────────────────────────────────────────

const A11Y_MODAL = '[aria-modal="true"], .ws-modal-overlay';
const A11Y_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function a11yShown(el: Element): boolean {
  return (el as HTMLElement).getClientRects().length > 0 && !el.closest('[hidden], [inert]');
}

function a11yFocusables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(A11Y_FOCUSABLE)).filter((el) => a11yShown(el) && !el.closest('[aria-hidden="true"]'));
}

/** The dialog on top: the last visible one in document order. */
function a11yTopModal(): HTMLElement | null {
  const open = Array.from(document.querySelectorAll<HTMLElement>(A11Y_MODAL)).filter(a11yShown);
  const top = open[open.length - 1];
  if (!top) return null;
  return (top.matches('.ws-modal-overlay') ? (top.querySelector('[role="dialog"], .ws-modal') as HTMLElement) || top : top);
}

// Where focus was before the current dialog took it, for when it closes.
let a11yLastOutside: HTMLElement | null = null;
let a11yModalOpen: HTMLElement | null = null;

function a11yWatchModals(): void {
  document.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement;
    if (t && !t.closest(A11Y_MODAL)) a11yLastOutside = t;
  }, true);
  // Tab never leaves the top dialog, in either direction.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const m = a11yTopModal();
    if (!m) return;
    const f = a11yFocusables(m);
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (i < 0) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); return; }
    if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }, true);
  // A dialog that closed without handing focus back leaves it on <body>:
  // give it to whatever had it before the dialog opened.
  const check = (): void => {
    const m = a11yTopModal();
    if (m && m !== a11yModalOpen) {
      if (!m.contains(document.activeElement)) (a11yFocusables(m)[0] || m).focus?.();
    }
    if (!m && a11yModalOpen) {
      const lost = !document.activeElement || document.activeElement === document.body || !a11yShown(document.activeElement);
      if (lost && a11yLastOutside && a11yLastOutside.isConnected && a11yShown(a11yLastOutside)) a11yLastOutside.focus();
    }
    a11yModalOpen = m;
  };
  new MutationObserver(() => window.requestAnimationFrame(check))
    .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'aria-modal'] });
}

// ── Menus ───────────────────────────────────────────────────────────────────

/**
 * Menu semantics and keys for a popup of buttons: role=menu/menuitem, focus on
 * the first item, ↑↓ Home End to move, focus back to `anchor` when it closes.
 */
function a11yMenu(menu: HTMLElement, anchor: HTMLElement | null): void {
  if (menu.dataset.a11yMenu) return;
  menu.dataset.a11yMenu = '1';
  menu.setAttribute('role', 'menu');
  const items = (): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="menuitemcheckbox"]'))
    .filter((b) => a11yShown(b) && !(b as HTMLButtonElement).disabled);
  items().forEach((b) => {
    if (!b.getAttribute('role')) b.setAttribute('role', b.getAttribute('aria-checked') !== null ? 'menuitemcheckbox' : 'menuitem');
    b.tabIndex = -1;
  });
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % list.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Tab') { e.preventDefault(); return; }
    if (next < 0) return;
    e.preventDefault();
    list[next].focus();
  });
  window.requestAnimationFrame(() => { const first = items()[0]; if (first) first.focus(); });
  new MutationObserver((_m, obs) => {
    if (menu.isConnected) return;
    obs.disconnect();
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      const a = document.activeElement;
      if (anchor.isConnected && (!a || a === document.body || !a.isConnected)) anchor.focus();
    }
  }).observe(document.body, { childList: true, subtree: false });
}

// ── Tabs, segmented controls, lists ─────────────────────────────────────────

const A11Y_LISTS = '#ds-saved-list, #mp-list, #viz-grid, #an-list, #cap-grid, #rel-list, #home-recent, .home-grid';

function a11yArrowTarget(e: KeyboardEvent, list: HTMLElement[], cur: number, grid: boolean): number {
  const n = list.length;
  if (e.key === 'Home') return 0;
  if (e.key === 'End') return n - 1;
  const fwd = e.key === 'ArrowRight' || (e.key === 'ArrowDown' && !grid);
  const back = e.key === 'ArrowLeft' || (e.key === 'ArrowUp' && !grid);
  if (fwd) return (cur + 1) % n;
  if (back) return (cur - 1 + n) % n;
  if (grid && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    // A visual grid: the item below/above is the nearest one in the next/previous row.
    const r = list[cur].getBoundingClientRect();
    const cand = list.map((el, i) => ({ i, b: el.getBoundingClientRect() }))
      .filter((x) => (e.key === 'ArrowDown' ? x.b.top > r.bottom - 2 : x.b.bottom < r.top + 2));
    if (!cand.length) return cur;
    cand.sort((a, b) => Math.abs(a.b.top - r.top) - Math.abs(b.b.top - r.top) || Math.abs(a.b.left - r.left) - Math.abs(b.b.left - r.left));
    return cand[0].i;
  }
  return -1;
}

function a11yKeys(): void {
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (!t || e.altKey || e.metaKey || e.ctrlKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;

    // Tabs: move AND select (automatic activation), skipping hidden tabs.
    const tab = t.closest('[role="tab"]') as HTMLElement | null;
    const tablist = tab && (tab.closest('[role="tablist"]') as HTMLElement | null);
    if (tab && tablist && !e.defaultPrevented) {
      const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]')).filter(a11yShown);
      const vertical = tablist.getAttribute('aria-orientation') === 'vertical';
      if (!vertical && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
      const next = a11yArrowTarget(e, tabs, tabs.indexOf(tab), false);
      if (next < 0) return;
      e.preventDefault();
      tabs[next].click();
      tabs[next].focus();
      return;
    }

    // A segmented control (role=radiogroup): the same, over its radios.
    const radio = t.closest('[role="radio"]') as HTMLElement | null;
    const group = radio && (radio.closest('[role="radiogroup"]') as HTMLElement | null);
    if (radio && group && !e.defaultPrevented) {
      const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).filter(a11yShown);
      const next = a11yArrowTarget(e, radios, radios.indexOf(radio), false);
      if (next < 0) return;
      e.preventDefault();
      radios[next].click();
      radios[next].focus();
      return;
    }

    // Lists and card grids: arrows move between items' first control.
    const list = t.closest(A11Y_LISTS) as HTMLElement | null;
    if (list && !e.defaultPrevented && !t.matches('input, select, textarea')) {
      const items = Array.from(list.children).filter(a11yShown) as HTMLElement[];
      const at = items.findIndex((it) => it.contains(t));
      if (at < 0) return;
      const grid = getComputedStyle(list).display === 'grid' || /grid/.test(list.className);
      const next = a11yArrowTarget(e, items, at, grid);
      if (next < 0 || next === at) return;
      const target = items[next].matches(A11Y_FOCUSABLE) ? items[next] : a11yFocusables(items[next])[0];
      if (!target) return;
      e.preventDefault();
      target.focus();
    }
  });
}

/** Segmented controls → radiogroups whose checked state follows their active class. */
function a11ySegmented(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.seg:not([role]), [data-seg]:not([role])').forEach((seg) => {
    const opts = Array.from(seg.children).filter((c) => c.tagName === 'BUTTON') as HTMLElement[];
    if (opts.length < 2) return;
    seg.setAttribute('role', 'radiogroup');
    if (!seg.getAttribute('aria-label')) seg.setAttribute('aria-label', seg.getAttribute('title') || 'Options');
    const sync = (): void => {
      const on = opts.find((o) => /\b(active|is-on|is-active|is-selected)\b/.test(o.className)) || opts[0];
      opts.forEach((o) => {
        o.setAttribute('role', 'radio');
        o.setAttribute('aria-checked', String(o === on));
        o.tabIndex = o === on ? 0 : -1;
      });
    };
    sync();
    new MutationObserver(sync).observe(seg, { attributes: true, subtree: true, attributeFilter: ['class'] });
  });
}

/** Tab lists keep a roving tabindex in step with aria-selected. */
function a11yTablists(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((list) => {
    if (list.dataset.a11yTabs) return;
    list.dataset.a11yTabs = '1';
    const sync = (): void => {
      const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
      if (!tabs.some((t) => t.getAttribute('aria-selected') === 'true')) return;
      tabs.forEach((t) => { t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1; });
    };
    sync();
    new MutationObserver(sync).observe(list, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
  });
}

// ── Icon-only buttons: one text for the name and the tooltip ────────────────

function a11yIconButtons(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('button, [role="button"]').forEach((b) => {
    // Once per element: tooltip.ts lifts `title` off while its own tip shows,
    // and putting it back mid-hover would bring the native tooltip up too.
    if (b.dataset.a11yTip || (b.textContent || '').trim()) return;
    const label = b.getAttribute('aria-label');
    const title = b.getAttribute('title');
    if (!label && !title) return;
    b.dataset.a11yTip = '1';
    if (label && !title) b.setAttribute('title', label);
    else if (title && !label) b.setAttribute('aria-label', title);
  });
}

// ── Charts ──────────────────────────────────────────────────────────────────

/** The chart instance that owns `canvas`, found on its nearest registered container. */
function a11yChartOf(canvas: HTMLCanvasElement): { chart: any; area: HTMLElement } | null {
  for (let el: HTMLElement | null = canvas.parentElement; el; el = el.parentElement) {
    const c = chartInstances.get(el);
    if (c && !Array.isArray(c) && c.canvas === canvas) return { chart: c, area: el };
  }
  return null;
}

function a11yChartData(chart: any): any {
  return {
    labels: (chart.data && chart.data.labels) || [],
    series: ((chart.data && chart.data.datasets) || []).map((d: any) => ({
      name: String(d.label || ''),
      values: (d.data || []).map((v: any) => (typeof v === 'number' ? v : v && typeof v.y === 'number' ? v.y : null)),
    })),
  };
}

/** role=img, the app's caption as its description, and keyboard mark navigation. */
function a11yChart(canvas: HTMLCanvasElement): void {
  if (canvas.dataset.a11yChart) return;
  const own = a11yChartOf(canvas);
  if (!own) return;
  canvas.dataset.a11yChart = '1';
  const { chart } = own;
  canvas.setAttribute('role', 'img');
  const title = (canvas.closest('.dash-card')?.querySelector('.dash-card-title')?.textContent || '').trim();
  const data = a11yChartData(chart);
  const type = String((chart.config && chart.config.type) || 'bar');
  canvas.setAttribute('aria-label', (title ? title + '. ' : '') + `Chart with ${data.labels.length} ${data.labels.length === 1 ? 'value' : 'values'}.`);
  // The builder's chart is a QUERY the user just ran: say when it is back, and what it found.
  const inBuilder = !!canvas.closest('#viz-area');
  if (window.hub && typeof window.hub.reportsCaption === 'function') {
    void window.hub.reportsCaption({ chartType: type, data }).then((cap: any) => {
      if (typeof cap === 'string' && cap && canvas.isConnected) {
        canvas.setAttribute('aria-label', (title ? title + '. ' : '') + cap + '.');
        if (inBuilder) a11yAnnounce('Chart updated. ' + cap + '.');
      }
    }).catch(() => { /* the plain label stays */ });
  }
  canvas.tabIndex = 0;
  let di = 0;
  let ix = -1;
  const show = (): void => {
    const meta = chart.getDatasetMeta(di);
    const el = meta && meta.data && meta.data[ix];
    if (!el) return;
    const active = [{ datasetIndex: di, index: ix }];
    try {
      chart.setActiveElements(active);
      if (chart.tooltip) chart.tooltip.setActiveElements(active, { x: el.x, y: el.y });
      chart.update('none');
    } catch (_) { /* a chart type without tooltips */ }
    const v = data.series[di] ? data.series[di].values[ix] : null;
    a11yAnnounce(`${data.labels[ix]}${data.series.length > 1 ? ', ' + data.series[di].name : ''}: ${typeof v === 'number' ? _fmtVal(v) : 'no value'}`);
  };
  canvas.addEventListener('keydown', (e) => {
    const n = data.labels.length;
    if (!n) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { ix = (ix + (e.key === 'ArrowRight' ? 1 : -1) + n) % n; }
    else if (e.key === 'Home') ix = 0;
    else if (e.key === 'End') ix = n - 1;
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && data.series.length > 1) {
      di = (di + (e.key === 'ArrowDown' ? 1 : -1) + data.series.length) % data.series.length;
      if (ix < 0) ix = 0;
    } else if ((e.key === 'Enter' || e.key === ' ') && ix >= 0) {
      // The same path a mouse click takes: a click AT the mark, so drill,
      // cross-filter and tile actions all see an ordinary event.
      const el = chart.getDatasetMeta(di).data[ix];
      const r = canvas.getBoundingClientRect();
      e.preventDefault();
      e.stopPropagation();
      if (el) canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + el.x, clientY: r.top + el.y }));
      return;
    } else return;
    // Ours alone: on a dashboard the CARD also listens for arrows (to nudge the
    // tile), and a mark step must not move the card it is in.
    e.preventDefault();
    e.stopPropagation();
    show();
  });
  canvas.addEventListener('blur', () => {
    try { chart.setActiveElements([]); if (chart.tooltip) chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.update('none'); } catch (_) { /* gone */ }
  });
}

/** A map container gets a name and a description of what it shows. */
function a11yMap(wrap: HTMLElement): void {
  const box = wrap.querySelector('.cv-map-container') as HTMLElement | null;
  if (!box) return;
  const title = (wrap.closest('.dash-card')?.querySelector('.dash-card-title')?.textContent || 'Map').trim();
  const d = wrap.dataset;
  const what = d.clusters !== undefined
    ? `${Number(d.points || 0) + Number(d.clusters || 0)} marks (${d.clusters} clusters)`
    : d.matched !== undefined ? `${d.matched} regions with values` : 'geographic data';
  const label = `${title}. Map showing ${what}.`;
  // Only on change: this runs on every scan, and a same-value write is still a
  // mutation the scan's own observer would answer — a loop.
  if (box.getAttribute('aria-label') === label) return;
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', label);
}

// ── The data-table alternative ("View as table" in a tile's menu) ───────────

/** Show a chart tile's figures as a table, or its chart again. */
function a11yToggleTable(cardEl: HTMLElement): void {
  const area = cardEl.querySelector('.dash-viz-area') as HTMLElement | null;
  if (!area) return;
  const existing = cardEl.querySelector('.a11y-table-wrap') as HTMLElement | null;
  if (existing) {
    existing.remove();
    area.hidden = false;
    return;
  }
  const chart = chartInstances.get(area);
  const data = chart && !Array.isArray(chart) ? a11yChartData(chart) : null;
  const wrap = document.createElement('div');
  wrap.className = 'a11y-table-wrap';
  if (!data || !data.labels.length) {
    wrap.textContent = 'This tile has no table view.';
  } else {
    const table = document.createElement('table');
    table.className = 'a11y-table';
    const cap = document.createElement('caption');
    cap.textContent = (cardEl.querySelector('.dash-card-title')?.textContent || 'Data').trim();
    table.appendChild(cap);
    const head = document.createElement('tr');
    [''].concat(data.series.map((s: any) => s.name)).forEach((h, i) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = i === 0 ? 'Category' : h;
      head.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(head);
    const tbody = document.createElement('tbody');
    data.labels.forEach((l: any, r: number) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = String(l);
      tr.appendChild(th);
      data.series.forEach((s: any) => {
        const td = document.createElement('td');
        const v = s.values[r];
        td.textContent = typeof v === 'number' ? _fmtVal(v) : '—';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    wrap.appendChild(table);
  }
  area.hidden = true;
  area.after(wrap);
  wrap.tabIndex = -1;
  wrap.focus();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/**
 * A field whose only description is its placeholder takes that text as its
 * name too (a placeholder vanishes as you type, so it is not a label on its
 * own); a dialog's lone unlabelled input is named by the dialog's title.
 */
function a11yFieldNames(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select').forEach((f) => {
    if (f.dataset.a11yName || f.getAttribute('aria-label') || f.getAttribute('aria-labelledby')) return;
    if ((f.id && document.querySelector(`label[for="${CSS.escape(f.id)}"]`)) || f.closest('label')) return;
    const title = f.closest('.ws-modal')?.querySelector('.ws-modal-title')?.textContent?.trim();
    const name = f.getAttribute('placeholder')?.trim() || title || f.getAttribute('title')?.trim();
    if (!name) return;
    f.dataset.a11yName = '1';
    f.setAttribute('aria-label', name);
  });
}

// A dashboard's tiles are one query each: announce once when the last one lands.
let a11yDashReady = '';

function a11yDashProgress(): void {
  const grid = document.getElementById('dash-grid');
  if (!grid || !dashCurrent || !grid.getClientRects().length) return;
  const cards = grid.querySelectorAll('.dash-card').length;
  const key = dashCurrent.id + '/' + dashPageIdx;
  if (!cards || key === a11yDashReady || grid.querySelector('[aria-busy="true"]')) return;
  a11yDashReady = key;
  a11yAnnounce(`${dashCurrent.name || 'Dashboard'} is ready — ${cards} ${cards === 1 ? 'tile' : 'tiles'}.`);
}

function a11yScan(root: ParentNode): void {
  a11yDashProgress();
  a11yIconButtons(root);
  a11yFieldNames(root);
  a11ySegmented(root);
  a11yTablists(root);
  root.querySelectorAll<HTMLCanvasElement>('canvas').forEach((c) => a11yChart(c));
  root.querySelectorAll<HTMLElement>('.cv-map-wrap').forEach((w) => a11yMap(w));
  root.querySelectorAll<HTMLElement>('.project-card-popup').forEach((m) => a11yMenu(m, a11yLastOutside));
}

function initA11y(): void {
  a11yRegion('a11y-live', false);
  a11yRegion('a11y-alert', true);
  a11yWatchModals();
  a11yKeys();
  // Motion off means the charts too: Chart.js animates on its own clock.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && (window as any).Chart) {
    (window as any).Chart.defaults.animation = false;
  }
  // An error toast is urgent: say it assertively as well as showing it.
  const toasts = document.getElementById('hub-toast');
  if (toasts) {
    new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => {
        const el = n as HTMLElement;
        if (el.nodeType === 1 && /error/.test(el.className)) a11yAnnounce(el.textContent || '', true);
      });
    }).observe(toasts, { childList: true });
  }
  // Everything else is applied as the DOM grows, batched per frame.
  let pending = false;
  const scan = (): void => {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(() => { pending = false; a11yScan(document); });
  };
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-clusters', 'data-matched', 'aria-label', 'aria-busy'] });
  a11yScan(document);
}

document.addEventListener('DOMContentLoaded', () => initA11y());
