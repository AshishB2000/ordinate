// DATA TRANSITIONS on a dashboard: when a filter, a selection, a parameter, the
// "As of" time or a sort changes, every chart animates from what it showed to
// what it shows now, instead of being drawn again from nothing.
//
// Classic global-scope renderer script (no import/export). Loads after
// chartRender.js (whose one animation config this obeys) and motionPlan.js
// (the pure plan). Everything here is keyed by DASHBOARD CARD id, and a chart
// outside a `.dash-card` is untouched — the Visuals builder, the capture
// thread, thumbnails and every export keep exactly the draw they had.
//
// HOW, given that the grid rebuilds every card on every change (renderDashGrid):
//   1. `mtPlugin.beforeDestroy` remembers the outgoing chart's FRAME (labels,
//      numbers, per-bar colours) and a bitmap copy of its canvas, by card id.
//   2. While main computes the new figures the card shows that bitmap
//      (`mtHold`) instead of a skeleton, so nothing blinks.
//   3. `mtAfterBuild` runs on the new chart: it draws the OLD frame instantly,
//      then steps to the new one through Chart.js's own element animation —
//      matched by label (motionPlan.ts). Leaving bars shrink to zero where
//      they stood (half the time), then the axis re-flows: staying bars SLIDE
//      to their new slot, because their element is carried there, and
//      arriving ones grow out of their neighbour.
// Reduced motion → none of this; the new chart is simply drawn (instant swap).

interface MtFrame {
  type: string;
  labels: string[];
  values: any[][];
  names: string[];
  /** Per-mark option arrays (a category's own colour), old order. */
  opts: Array<Record<string, any[]>>;
}

const MT_TYPES = new Set(['bar', 'line']);
// What a mark's geometry is made of, for an arriving mark cloned off a neighbour.
const MT_GEOM = ['x', 'y', 'base', 'width', 'height', 'horizontal', 'skip', 'stop'];
const mtFrames = new Map<string, MtFrame>();
const mtHolds = new Map<string, { canvas: HTMLCanvasElement; w: number; h: number }>();

// Small multiples share one card, so no one mini owns its frame: left alone.
function mtCardId(chart: any): string {
  const c: HTMLElement | null = chart && chart.canvas;
  const card = c && !c.closest('.cv-sm-cell') ? c.closest('.dash-card') as HTMLElement | null : null;
  return card ? card.dataset.cardId || '' : '';
}

/** The chart's frame — or its DESTINATION mid-transition — when it is one we can animate. */
function mtFrameOf(chart: any): MtFrame | null {
  if (!MT_TYPES.has(chart.config.type)) return null;
  const t = chart.$mtTarget;
  const labels: any[] = t ? t.labels : chart.data.labels || [];
  const sets: any[] = chart.data.datasets || [];
  const values: any[][] = t ? t.values : sets.map((d: any) => d.data);
  const numeric = (a: any) => Array.isArray(a) && a.length === labels.length
    && a.every((v: any) => v === null || v === undefined || typeof v === 'number');
  if (!labels.length || !values.every(numeric)) return null;
  const opts = t ? t.opts : sets.map((d: any) => {
    const o: Record<string, any[]> = {};
    Object.keys(d).forEach((k) => { if (k !== 'data' && Array.isArray(d[k]) && d[k].length === labels.length) o[k] = d[k]; });
    return o;
  });
  return {
    type: chart.$mtType || '',
    labels: labels.map(String),
    values: values.map((a) => a.slice()),
    names: sets.map((d: any) => String(d.label == null ? '' : d.label)),
    opts,
  };
}

const mtPlugin = {
  id: 'ordMotion',
  beforeDestroy(chart: any): void {
    const id = mtCardId(chart);
    if (!id) return;
    const f = mtFrameOf(chart); // mid-transition this is the destination, not the tween
    if (f) mtFrames.set(id, f);
    if (chart.$mtFinish) chart.$mtFinish(false);
    const c: HTMLCanvasElement = chart.canvas;
    if (!c.width || !c.height || !c.clientWidth) return;
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    const ctx = copy.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(c, 0, 0);
    mtHolds.set(id, { canvas: copy, w: c.clientWidth, h: c.clientHeight });
  },
};

/**
 * Paint a card's last chart image while its next figures are computed. Returns
 * false when there is none (first open, a new card) and the caller shows a
 * skeleton. The wrapper is an `.sk-wrap`, so skelClear removes it on every exit.
 */
function mtHold(cardId: string, body: HTMLElement): boolean {
  const h = mtHolds.get(cardId);
  if (!h) return false;
  mtHolds.delete(cardId);
  const wrap = document.createElement('div');
  wrap.className = 'sk-wrap mt-hold';
  wrap.setAttribute('aria-hidden', 'true');
  h.canvas.style.width = h.w + 'px';
  h.canvas.style.height = h.h + 'px';
  wrap.appendChild(h.canvas);
  body.setAttribute('aria-busy', 'true');
  body.appendChild(wrap);
  return true;
}

/** The dashboard closed: nothing it showed is the "before" of anything any more. */
function mtForget(): void {
  mtFrames.clear();
  mtHolds.clear();
  if (typeof kpiForget === 'function') kpiForget();
}

/** Jump any chart (or small-multiples array) to its final frame — before a pixel read. */
function mtSettle(inst: any): void {
  (Array.isArray(inst) ? inst : inst ? [inst] : []).forEach((chart: any) => {
    try {
      if (chart.$mtFinish) chart.$mtFinish(true);
      else if (typeof chart.stop === 'function') { chart.stop(); chart.update('none'); }
    } catch (_) { /* destroyed */ }
  });
}

/** Called by buildChart on every chart it makes. */
function mtAfterBuild(chart: any, type: string, overrides: any): void {
  chart.$mtType = type;
  if (overrides.noAnimate || overrides.devicePixelRatio || !chart.attached) return;
  // Reduced motion: the instant swap must still land on the FINAL frame. A
  // chart drawn once with animation off resolves its scriptable fills before
  // its chart area exists (a gradient falls back to flat), so it is drawn
  // again, exactly as every export does before reading pixels.
  if (chartMotionReduced()) { chart.update('none'); return; }
  const id = mtCardId(chart);
  const from = id ? mtFrames.get(id) : null;
  if (!from || from.type !== type) return;
  const to = mtFrameOf(chart);
  if (!to || to.names.join('\u0001') !== from.names.join('\u0001')) return;
  const wrap = chart.canvas.parentElement;
  if (wrap) wrap.classList.remove('is-fresh'); // continuity, not a fresh mount
  if (JSON.stringify([from.labels, from.values]) === JSON.stringify([to.labels, to.values])) {
    chart.stop(); // nothing changed under this card — no re-grow on every filter
    chart.update('none');
    return;
  }
  mtRun(chart, from, to);
}

function mtSetOpts(ds: any, opts: Record<string, any[]>, keep: Record<string, any>): void {
  Object.keys(opts).forEach((k) => { if (!(k in keep)) keep[k] = ds[k]; ds[k] = opts[k]; });
}

function mtRun(chart: any, from: MtFrame, to: MtFrame): void {
  const plan = planTransition(from.labels, null, to.labels, null);
  const sets: any[] = chart.data.datasets;
  // The new chart's own per-mark arrays, back in once the axis is the new one.
  const kept: Array<Record<string, any>> = sets.map(() => ({}));
  chart.stop();
  chart.$mtTarget = { labels: to.labels, values: to.values, opts: to.opts };
  chart.$mtUntil = performance.now() + CHART_MOTION_MS;
  chart.data.labels = from.labels.slice();
  sets.forEach((ds, d) => { ds.data = from.values[d].slice(); mtSetOpts(ds, from.opts[d] || {}, kept[d]); });
  chart.update('none');

  let timer = 0;
  let stepped = false;
  const toNew = (mode?: string): void => {
    stepped = true;
    const carried = sets.map((_, d) => mtCarry(chart.getDatasetMeta(d), plan.order));
    chart.data.labels = to.labels.slice();
    sets.forEach((ds, d) => {
      ds.data = to.values[d].slice();
      Object.keys(kept[d]).forEach((k) => { if (kept[d][k] === undefined) delete ds[k]; else ds[k] = kept[d][k]; });
      if (carried[d]) chart.getDatasetMeta(d).data = carried[d];
    });
    chart.update(mode);
  };
  const done = (): void => { chart.$mtTarget = null; chart.$mtFinish = null; };
  // draw=false only cancels (the chart is being destroyed); draw=true lands on
  // the final frame now, for a pixel read.
  chart.$mtFinish = (draw: boolean): void => {
    window.clearTimeout(timer);
    if (draw && chart.canvas) {
      if (!stepped) toNew('none');
      chart.stop();
      chart.update('none');
    }
    done();
  };

  if (!plan.exit.length) {
    toNew();
    timer = window.setTimeout(done, CHART_MOTION_MS);
    return;
  }
  sets.forEach((ds, d) => { ds.data = exitStep(plan, from.values[d], to.values[d]); });
  chart.update('mtStep');
  timer = window.setTimeout(() => {
    if (!chart.canvas) return done();
    toNew('mtStep');
    timer = window.setTimeout(done, CHART_MOTION_MS / 2);
  }, CHART_MOTION_MS / 2);
}

/**
 * A dataset's elements laid out in the NEW order: a staying mark keeps its own
 * element (Chart.js then animates it from where it stood — the slide), an
 * arriving one is a fresh element cloned off its nearest staying neighbour and
 * collapsed onto its baseline, so it grows out of the row instead of popping in.
 * Null when there is nothing to carry; Chart.js then animates by position.
 */
function mtCarry(meta: any, order: number[]): any[] | null {
  const old: any[] = meta && Array.isArray(meta.data) ? meta.data : [];
  const El = meta && meta.controller && meta.controller.dataElementType;
  if (!old.length || !El || !order.some((i) => i >= 0 && old[i])) return null;
  const nearest = (j: number): any => {
    for (let k = 1; k < order.length; k++) {
      if (order[j - k] >= 0 && old[order[j - k]]) return old[order[j - k]];
      if (order[j + k] >= 0 && old[order[j + k]]) return old[order[j + k]];
    }
    return null;
  };
  return order.map((i, j) => {
    if (i >= 0 && old[i]) return old[i];
    const nb = nearest(j);
    const el = new El();
    MT_GEOM.forEach((p) => { if (nb && nb[p] !== undefined) el[p] = nb[p]; });
    // Chart.js only re-sends options to an element whose options are not the
    // dataset's shared set, so a clone must start with its neighbour's: the
    // shared object itself, or a copy of a per-mark one (never the same object).
    if (nb && nb.options) {
      if (nb.options.$shared) el.options = nb.options;
      else { el.options = Object.assign({}, nb.options); delete el.options.$animations; }
    }
    if (nb && typeof nb.base === 'number') { if (nb.horizontal) el.x = nb.base; else el.y = nb.base; }
    return el;
  });
}
