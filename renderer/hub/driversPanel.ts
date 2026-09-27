'use strict';

// "Why did this change?" — the KEY DRIVERS panel. RENDERER ONLY, classic
// global-scope script (no import/export).
//
// A sheet from the right, like the drill panel: the change as a headline, the
// dimensions ranked by how much of it they explain, the chosen one as a
// waterfall (start, the top five up, the top five down, other, end), the app's
// own caption, and three actions. Clicking a contributor breaks it down by the
// next dimension (West → state); the breadcrumb climbs back.
//
// NOTHING HERE COMPUTES A FIGURE. Every number and every sentence arrives from
// main (`drivers:explain`, src/ipc/drivers.ts) already written; this file lays
// them out and sends the next question. Entry points and actions live in
// driversEntry.ts.

let drvRoot: HTMLElement | null = null;
/** The question on screen, as main last echoed it back (its sanitized spec) plus params. */
let drvReq: any = null;
let drvRes: any = null;
let drvSeq = 0;
let drvPrevFocus: HTMLElement | null = null;

function drvQ<T extends HTMLElement = HTMLElement>(sel: string): T | null {
  return drvRoot ? (drvRoot.querySelector(sel) as T | null) : null;
}

function drvEl(tag: string, cls?: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function drvButton(label: string, cls: string, iconName?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  if (iconName) b.appendChild(icon(iconName, 16));
  b.appendChild(document.createTextNode(label));
  return b;
}

/** Build the sheet once; every open repaints it. */
function drvEnsureRoot(): HTMLElement {
  if (drvRoot) return drvRoot;
  const back = drvEl('div', 'drv-backdrop');
  back.hidden = true;
  const panel = drvEl('aside', 'drv-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'drv-title');

  const head = drvEl('header', 'drv-head');
  const eyebrow = drvEl('div', 'drv-eyebrow');
  eyebrow.appendChild(icon('activity', 16));
  eyebrow.appendChild(document.createTextNode('Why did this change?'));
  const row = drvEl('div', 'drv-head-row');
  const title = drvEl('h2', 'drv-title', 'Explaining the change…');
  title.id = 'drv-title';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'drv-x';
  x.setAttribute('aria-label', 'Close');
  x.appendChild(icon('x', 16));
  x.addEventListener('click', () => closeDriversPanel());
  row.append(title, x);
  head.append(eyebrow, row, drvEl('div', 'drv-periods'), drvEl('nav', 'drv-crumbs'));
  head.querySelector('.drv-crumbs')!.setAttribute('aria-label', 'Breakdown path');

  const body = drvEl('div', 'drv-body');
  const dims = drvEl('div', 'drv-dims');
  const main = drvEl('section', 'drv-main');
  body.append(dims, main);

  const foot = drvEl('footer', 'drv-foot');
  const note = drvEl('span', 'drv-foot-note');
  note.appendChild(icon('shield', 16));
  note.appendChild(document.createTextNode('Every figure is computed by Ordinate from your data.'));
  const acts = drvEl('div', 'drv-actions');
  const tile = drvButton('Add as tile', 'btn drv-act-tile', 'layout-dashboard');
  const ask = drvButton('Ask the Assistant', 'btn drv-act-ask', 'sparkles');
  const alert = drvButton('Alert me…', 'btn drv-act-alert', 'bell');
  tile.addEventListener('click', () => { void drvAddTile(); });
  ask.addEventListener('click', () => { void drvAsk(); });
  alert.addEventListener('click', () => { void drvAlertMe(); });
  acts.append(tile, ask, alert);
  foot.append(note, acts);

  panel.append(head, body, foot);
  back.appendChild(panel);
  back.addEventListener('click', (e) => { if (e.target === back) closeDriversPanel(); });
  back.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDriversPanel(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(panel.querySelectorAll('button:not([disabled])')) as HTMLElement[];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.body.appendChild(back);
  drvRoot = back;
  return back;
}

function driversPanelIsOpen(): boolean {
  return !!drvRoot && !drvRoot.hidden;
}

/**
 * Open for a question. `first` is the call that answers it (explain or
 * explainAlert); later questions — a dimension, a drill, a crumb — go through
 * `drivers:explain` with the spec main echoed back.
 */
async function openDriversPanel(first: () => Promise<any>, params?: any): Promise<void> {
  const root = drvEnsureRoot();
  drvPrevFocus = document.activeElement as HTMLElement | null;
  drvReq = null;
  drvRes = null;
  root.hidden = false;
  document.body.classList.add('drv-open');
  drvPaintLoading();
  (drvQ('.drv-x') as HTMLElement | null)?.focus();
  await drvRun(first, params);
}

function closeDriversPanel(): void {
  if (!drvRoot || drvRoot.hidden) return;
  drvRoot.hidden = true;
  drvSeq += 1; // a reply still in flight is now stale
  document.body.classList.remove('drv-open');
  if (drvPrevFocus && document.contains(drvPrevFocus)) drvPrevFocus.focus();
  drvPrevFocus = null;
}

async function drvRun(call: () => Promise<any>, params?: any): Promise<void> {
  const seq = ++drvSeq;
  let res: any;
  try {
    res = await call();
  } catch (_) {
    res = { ok: false, error: 'Could not explain the change.' };
  }
  if (seq !== drvSeq) return;
  if (!res || res.ok !== true) {
    drvPaintError((res && res.error) || 'Could not explain the change.');
    return;
  }
  drvRes = res;
  drvReq = { ...res.spec, params: params !== undefined ? params : drvReq ? drvReq.params : undefined };
  drvPaint();
}

/** The next question: the same one with a different dimension or path. */
function drvAskAgain(patch: { dimension?: string; path?: any[] }): void {
  if (!drvReq || !currentProjectId) return;
  const next = { ...drvReq, ...patch };
  if (patch.path) delete next.dimension; // a new level picks its own best dimension
  drvReq = next;
  drvPaintLoading();
  const pid = currentProjectId;
  void drvRun(() => window.hubDrivers.explain(pid, next));
}

// ── Painting ────────────────────────────────────────────────────────────────

function drvPaintLoading(): void {
  const dims = drvQ('.drv-dims');
  const main = drvQ('.drv-main');
  if (!dims || !main) return;
  dims.textContent = '';
  main.textContent = '';
  dims.appendChild(drvEl('div', 'drv-sec-h', 'Dimensions'));
  for (let i = 0; i < 4; i += 1) dims.appendChild(drvEl('div', 'drv-skel drv-skel--dim'));
  main.appendChild(drvEl('div', 'drv-skel drv-skel--caption'));
  for (let i = 0; i < 7; i += 1) main.appendChild(drvEl('div', 'drv-skel drv-skel--bar'));
  main.setAttribute('aria-busy', 'true');
  drvSetActions(false);
}

function drvPaintError(msg: string): void {
  const title = drvQ('#drv-title');
  if (title && !drvRes) title.textContent = 'Nothing to explain yet';
  const dims = drvQ('.drv-dims');
  const main = drvQ('.drv-main');
  if (!dims || !main) return;
  dims.textContent = '';
  main.textContent = '';
  main.removeAttribute('aria-busy');
  main.appendChild(drvEmpty('calendar', 'This change cannot be explained', msg));
  drvSetActions(false);
}

function drvEmpty(iconName: string, heading: string, body: string): HTMLElement {
  const box = drvEl('div', 'drv-empty');
  const ic = drvEl('div', 'drv-empty-ic');
  ic.appendChild(icon(iconName, 20));
  box.append(ic, drvEl('h3', 'drv-empty-h', heading), drvEl('p', 'drv-empty-p', body));
  return box;
}

function drvSetActions(on: boolean): void {
  const r = drvRes;
  const tile = drvQ<HTMLButtonElement>('.drv-act-tile');
  const ask = drvQ<HTMLButtonElement>('.drv-act-ask');
  const alert = drvQ<HTMLButtonElement>('.drv-act-alert');
  if (tile) tile.disabled = !on || !r || !r.selected;
  if (ask) ask.disabled = !on || !r;
  if (alert) {
    alert.disabled = !on || !r || !r.alert;
    alert.title = r && !r.alert ? 'Alerts watch a column total — this metric is a formula.' : '';
  }
}

/** Good or bad news, by the metric's direction (up is good unless it says otherwise). */
function drvTone(delta: number): string {
  if (!delta) return 'is-flat';
  const good = drvRes && drvRes.metric && drvRes.metric.direction === 'down_good' ? delta < 0 : delta > 0;
  return good ? 'is-good' : 'is-bad';
}

function drvPaint(): void {
  const r = drvRes;
  if (!r) return;
  const title = drvQ('#drv-title');
  if (title) title.textContent = r.headline || r.metric.name;

  const periods = drvQ('.drv-periods');
  if (periods) {
    periods.textContent = '';
    const side = (label: string, text: string, cls: string): HTMLElement => {
      const s = drvEl('span', 'drv-period ' + cls);
      s.append(drvEl('span', 'drv-period-l', label), drvEl('span', 'drv-period-v tnum', text));
      return s;
    };
    periods.append(side(r.periods.b, r.totals.bText, 'is-before'));
    const arrow = drvEl('span', 'drv-period-arrow');
    arrow.appendChild(icon('arrow-right', 16));
    periods.append(arrow, side(r.periods.a, r.totals.aText, 'is-after'));
    if (typeof r.totals.delta === 'number') {
      const pill = drvEl('span', 'drv-pill tnum ' + drvTone(r.totals.delta), r.totals.deltaText);
      if (typeof r.totals.pct === 'number' && r.metric.kind !== 'ratio') {
        pill.textContent += ' (' + (r.totals.pct > 0 ? '+' : r.totals.pct < 0 ? '−' : '') + Math.abs(r.totals.pct).toFixed(1) + '%)';
      }
      periods.appendChild(pill);
    }
  }
  drvPaintCrumbs();
  drvPaintDims();
  drvPaintMain();
  drvSetActions(true);
}

function drvPaintCrumbs(): void {
  const nav = drvQ('.drv-crumbs');
  const r = drvRes;
  if (!nav || !r) return;
  nav.textContent = '';
  nav.hidden = !r.path.length;
  if (!r.path.length) return;
  const crumb = (label: string, depth: number, current: boolean): void => {
    if (current) {
      const s = drvEl('span', 'drv-crumb is-current', label);
      s.setAttribute('aria-current', 'page');
      nav.appendChild(s);
      return;
    }
    const b = drvButton(label, 'drv-crumb');
    b.addEventListener('click', () => drvAskAgain({ path: r.path.slice(0, depth).map((p: any) => ({ column: p.column, value: p.value })) }));
    nav.appendChild(b);
  };
  crumb('All ' + r.metric.name, 0, false);
  r.path.forEach((p: any, i: number) => {
    const sep = drvEl('span', 'drv-crumb-sep');
    sep.appendChild(icon('chevron-right', 16));
    nav.appendChild(sep);
    crumb(p.column + ': ' + p.label, i + 1, i === r.path.length - 1);
  });
}

function drvPaintDims(): void {
  const host = drvQ('.drv-dims');
  const r = drvRes;
  if (!host || !r) return;
  host.textContent = '';
  const h = drvEl('div', 'drv-sec-h', 'Dimensions');
  h.appendChild(drvEl('span', 'drv-sec-sub', 'ranked by explained variance'));
  host.appendChild(h);
  if (!r.dimensions.length) {
    host.appendChild(drvEl('p', 'drv-dims-none', 'No dimension here has between 2 and 200 values.'));
    return;
  }
  const list = drvEl('div', 'drv-dim-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Break the change down by');
  const selected = r.selected ? r.selected.column : '';
  for (const d of r.dimensions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'drv-dim' + (d.column === selected ? ' is-on' : '');
    b.setAttribute('aria-pressed', String(d.column === selected));
    const pct = Math.round(d.explained * 100);
    b.setAttribute('aria-label', `${d.column}: explains ${pct}% of the change`);
    const top = drvEl('div', 'drv-dim-top');
    top.append(drvEl('span', 'drv-dim-name', d.column), drvEl('span', 'drv-dim-pct tnum', pct + '%'));
    const track = drvEl('div', 'drv-dim-track');
    const fill = drvEl('div', 'drv-dim-fill');
    fill.style.width = Math.max(2, pct) + '%';
    track.appendChild(fill);
    const sub = drvEl('div', 'drv-dim-sub', d.memberCount + ' members' + (d.lead ? ' · led by ' + d.lead : ''));
    b.append(top, track, sub);
    b.addEventListener('click', () => { if (d.column !== selected) drvAskAgain({ dimension: d.column }); });
    list.appendChild(b);
  }
  host.appendChild(list);
}

function drvPaintMain(): void {
  const host = drvQ('.drv-main');
  const r = drvRes;
  if (!host || !r) return;
  host.textContent = '';
  host.removeAttribute('aria-busy');
  if (r.caption) {
    const cap = drvEl('div', 'drv-caption');
    cap.appendChild(icon('sparkles', 16));
    cap.appendChild(drvEl('span', 'drv-caption-text', r.caption));
    cap.appendChild(drvEl('span', 'xp-prov-chip', 'app-computed'));
    host.appendChild(cap);
  }
  if (!r.selected) {
    host.appendChild(drvEmpty('info', 'No breakdown for this change', r.unavailable || 'Nothing in these periods to break down.'));
    return;
  }
  const s = r.selected;
  const drillable = r.dimensions.length > 1 && r.path.length < 4;
  const h = drvEl('div', 'drv-sec-h', 'Contributors by ' + s.column);
  h.appendChild(drvEl('span', 'drv-sec-sub', drillable ? 'select a member to break it down further' : 'largest moves first'));
  host.appendChild(h);
  host.appendChild(drvWaterfall(s, drillable, r.metric.kind === 'ratio'));
  if (r.metric.kind === 'ratio') {
    host.appendChild(drvEl('p', 'drv-ratio-note',
      'A ratio moves two ways: a member\'s MIX effect is its weight growing or shrinking, its RATE effect is its own ratio moving. Mix + rate = its contribution.'));
  }
}

/**
 * A member's weight in words: its share of the change — or, when members
 * offset each other (a small net change over big moves), its share of all the
 * movement, because "1,457% of the change" explains nothing.
 */
function drvShareText(st: any, offsetting: boolean): string | undefined {
  if (st.share === null || st.share === undefined) return undefined;
  if (offsetting || Math.abs(st.share) > 200) return Math.round(st.moveShare) + '% of all movement';
  const pct = Math.round(st.share);
  return (pct < 0 ? '−' + Math.abs(pct) : String(pct)) + '% of the change';
}

/** Horizontal waterfall rows. Totals from the axis start; steps float at the running level. */
function drvWaterfall(s: any, drillable: boolean, ratio: boolean): HTMLElement {
  const w = s.waterfall;
  const rows: Array<{ label: string; from: number; to: number; text: string; kind: string; step?: any; sub?: string }> = [];
  rows.push({ label: drvRes.periods.b, from: 0, to: w.start, text: w.startText, kind: 'total' });
  let run = w.start;
  for (const st of w.steps) {
    rows.push({ label: st.label, from: run, to: run + st.delta, text: st.deltaText, kind: 'step', step: st,
      sub: ratio && st.mixText !== undefined ? `Mix ${st.mixText} · Rate ${st.rateText}` : drvShareText(st, s.offsetting) });
    run += st.delta;
  }
  if (w.other.count > 0) {
    rows.push({ label: `Other (${w.other.count})`, from: run, to: run + w.other.delta, text: w.other.deltaText, kind: 'other' });
    run += w.other.delta;
  }
  rows.push({ label: drvRes.periods.a, from: 0, to: w.end, text: w.endText, kind: 'total' });

  // The axis: from 0, unless every level sits far above it — then zoom in so
  // the steps are visible, and mark the totals as cut.
  const levels = rows.flatMap((x) => (x.kind === 'total' ? [x.to] : [x.from, x.to]));
  let lo = Math.min(0, ...levels);
  const hi = Math.max(0, ...levels);
  const minLevel = Math.min(...levels);
  let cut = false;
  if (lo === 0 && minLevel > 0 && minLevel > 0.4 * hi) {
    lo = minLevel - (hi - minLevel) * 0.35;
    cut = true;
  }
  const span = hi - lo || 1;
  const pos = (v: number): number => ((v - lo) / span) * 100;

  const box = drvEl('div', 'drv-wf');
  box.setAttribute('role', 'list');
  box.setAttribute('aria-label', 'Waterfall of contributors');
  for (const x of rows) {
    const clickable = drillable && x.kind === 'step';
    const row = clickable ? document.createElement('button') : drvEl('div');
    if (clickable) (row as HTMLButtonElement).type = 'button';
    row.className = 'drv-wf-row is-' + x.kind + (clickable ? ' is-drill' : '');
    row.setAttribute('role', 'listitem');
    const lab = drvEl('div', 'drv-wf-label');
    lab.appendChild(drvEl('span', 'drv-wf-name', x.label));
    if (x.sub) lab.appendChild(drvEl('span', 'drv-wf-sub', x.sub));
    const track = drvEl('div', 'drv-wf-track');
    const bar = drvEl('div', 'drv-wf-bar' + (x.kind === 'total' ? (cut ? ' is-cut' : '') : ' ' + drvTone(x.to - x.from)));
    const a = x.kind === 'total' ? pos(Math.max(lo, 0)) : pos(Math.min(x.from, x.to));
    const b = x.kind === 'total' ? pos(x.to) : pos(Math.max(x.from, x.to));
    bar.style.left = Math.min(a, b) + '%';
    bar.style.width = Math.max(0.6, Math.abs(b - a)) + '%';
    track.appendChild(bar);
    const val = drvEl('div', 'drv-wf-val tnum ' + (x.kind === 'total' ? '' : drvTone(x.to - x.from)), x.text);
    row.append(lab, track, val);
    if (clickable) {
      row.setAttribute('aria-label', `${x.label}: ${x.text}. Break it down further.`);
      row.addEventListener('click', () => {
        const path = (drvRes.path || []).map((p: any) => ({ column: p.column, value: p.value }));
        drvAskAgain({ path: path.concat([{ column: s.column, value: x.step.key }]) });
      });
    }
    box.appendChild(row);
  }
  return box;
}
