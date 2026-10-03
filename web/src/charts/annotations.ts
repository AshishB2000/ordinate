// The Analytics pane's overlays and the comment pins, drawn onto a Chart.js
// chart (renderer/hub/chartAnnotations.ts) — a hand-written inline plugin.
// NOTHING HERE COMPUTES A FIGURE: every value it draws arrives resolved from
// the server on `data.analytics` (src/analysis/analytics.ts via `visual:data`);
// this file turns values into pixels through the chart's own scales.
//
//   beforeDatasetsDraw  bands and forecast intervals, UNDER the bars/lines
//   afterDatasetsDraw   reference / target / trend / moving-average / forecast
//                       lines, highlight outlines, callouts and comment pins
//
// Interaction, only where a chart is being AUTHORED (an ancestor marked
// `data-chart-editable`): drag a constant reference / target line, ⌥-click a
// mark to annotate it, click a pin to open its thread. The desktop reached the
// Analytics pane and the comments feature through page globals; here the
// screen that owns them sets `annotationHooks` (the builder, T2.3).

import { getCSSVar } from './palette';
import type { ChartTypeSpec } from './typeSpec';
import type { Cx } from './types';

/** What the authoring screen does with an annotation gesture. Unset → the chart does not respond. */
export const annotationHooks: {
  onOverlayDragged?: (id: string, value: number) => void;
  onAnnotateAt?: (label: string, seriesIndex: number) => void;
  onOpenPin?: (kind: string, id: string, pinId: string) => void;
} = {};

export interface AnnCommentPin {
  n: number;
  id: string;
  label: string;
  series?: string;
  resolved?: boolean;
}

/** What buildChart hands the plugin — all in the ORIGINAL (unsorted) label order. */
export interface AnnConfig {
  overlays: Cx[];
  pins: AnnCommentPin[];
  /** Labels as main produced them (before any forecast extension). */
  labels: Cx[];
  /** Series values as main produced them. */
  series: Array<{ name?: string; values: Cx[] }>;
  /** chart position → original index, when the chart sorted its categories. */
  order: number[] | null;
  /** The comment target the pins belong to, for the click-through. */
  pinTarget?: { kind: string; id: string } | null;
  fmt: (v: Cx) => string;
  fontFamily: string;
}

const ANN_KIND_VAR: Record<string, string> = {
  reference: '--text-dim', target: '--ok', band: '--accent', trend: '--chart-accent',
  moving_average: '--warn', forecast: '--accent', annotation: '--text-strong', highlight: '--accent',
};

/** Nothing drawable and nothing to pin: the chart gets no plugin at all. */
export function annWanted(overlays: Cx[], pins: AnnCommentPin[], spec: ChartTypeSpec): boolean {
  const kinds = spec.overlayKinds || [];
  return (overlays || []).some((o) => o && !o.warning && kinds.indexOf(o.kind) >= 0) || (pins || []).length > 0;
}

/** The drawable overlays for this chart type. */
export function annDrawable(overlays: Cx[], spec: ChartTypeSpec, sorted: boolean): Cx[] {
  const kinds = spec.overlayKinds || [];
  return (overlays || []).filter((o) => o && !o.warning && kinds.indexOf(o.kind) >= 0
    // A sorted axis is no longer in time order: a line through it would be a lie.
    && !(sorted && (o.kind === 'trend' || o.kind === 'moving_average' || o.kind === 'forecast')));
}

/** The value extent every overlay needs the value axis to include. */
export function annExtent(overlays: Cx[]): { min: number; max: number } | null {
  const vals: number[] = [];
  const add = (v: Cx) => { if (typeof v === 'number' && Number.isFinite(v)) vals.push(v); };
  for (const o of overlays) {
    add(o.value); add(o.from); add(o.to);
    (o.points || []).forEach(add);
    if (o.forecast) { o.forecast.lo.forEach(add); o.forecast.hi.forEach(add); o.forecast.values.forEach(add); }
  }
  return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
}

export function annAxes(chart: Cx): { cat: Cx; val: Cx; horiz: boolean } | null {
  const horiz = chart.options && chart.options.indexAxis === 'y';
  const sc = chart.scales || {};
  const cat = horiz ? sc.y : sc.x;
  const val = horiz ? sc.x : sc.y;
  return cat && val ? { cat, val, horiz } : null;
}

/** Original label index → chart position (identity unless the chart sorted). */
function annPos(cfg: AnnConfig, i: number): number {
  return cfg.order ? cfg.order.indexOf(i) : i;
}

function annColor(canvas: HTMLCanvasElement, o: Cx): string {
  return o.color || getCSSVar(ANN_KIND_VAR[o.kind] || '--accent', canvas) || '#6366f1';
}

export type AnnRect = { l: number; t: number; r: number; b: number };

/**
 * A small filled pill with text — the label a line or a callout carries.
 *
 * `placed` is every pill already drawn this frame: a pill that would land on
 * one steps down (or, at the floor of the plot, up) until it is clear, so a
 * trend, a moving average and a forecast ending on the same month read as
 * three labels rather than one smudge. `ink` / `edge` override the white text
 * on a solid fill, for a callout drawn on the surface colour instead.
 */
export function annPill(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, font: string,
  align: 'left' | 'right' | 'center', placed: AnnRect[], area: AnnRect, style: { ink?: string; edge?: string } = {},
): void {
  ctx.save();
  ctx.font = `600 10px ${font}`;
  const w = ctx.measureText(text).width + 10;
  const h = 16;
  let left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  left = Math.max(area.l, Math.min(area.r - w, left));
  let top = Math.max(area.t, Math.min(area.b - h, y - h / 2));
  const hits = (t: number) => placed.some((p) => left < p.r && left + w > p.l && t < p.b && t + h > p.t);
  let dir = 1;
  for (let guard = 0; guard < 12 && hits(top); guard++) {
    top += dir * (h + 2);
    if (top + h > area.b) { dir = -1; top = y - h / 2 - (h + 2); }
  }
  placed.push({ l: left, t: top, r: left + w, b: top + h });
  ctx.fillStyle = fill;
  ctx.globalAlpha = style.edge ? 1 : 0.92;
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, 4);
  ctx.fill();
  if (style.edge) { ctx.strokeStyle = style.edge; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.ink || '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, left + 5, top + h / 2 + 0.5);
  ctx.restore();
}

function annLineThrough(ctx: CanvasRenderingContext2D, pts: Array<[number, number] | null>): void {
  ctx.beginPath();
  let pen = false;
  for (const p of pts) {
    if (!p) { pen = false; continue; }
    if (pen) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
    pen = true;
  }
  ctx.stroke();
}

/** Pixel of one category position and value — (x, y) whatever the orientation. */
function annPoint(ax: { cat: Cx; val: Cx; horiz: boolean }, pos: number, v: number): [number, number] {
  const c = ax.cat.getPixelForValue(pos);
  const p = ax.val.getPixelForValue(v);
  return ax.horiz ? [p, c] : [c, p];
}

/** The per-chart plugin. `state` holds a drag in progress so a redraw can show it. */
export function annotationsPlugin(cfg: AnnConfig): Cx {
  const state: { drag: { id: string; value: number } | null; hover: string | null; cleanup: (() => void) | null } =
    { drag: null, hover: null, cleanup: null };

  const valueOf = (o: Cx): number => (state.drag && state.drag.id === o.id ? state.drag.value : o.value);

  function lineGeom(chart: Cx, v: number): { a: [number, number]; b: [number, number] } | null {
    const ax = annAxes(chart);
    const area = chart.chartArea;
    if (!ax || !area || typeof v !== 'number') return null;
    const p = ax.val.getPixelForValue(v);
    return ax.horiz ? { a: [p, area.top], b: [p, area.bottom] } : { a: [area.left, p], b: [area.right, p] };
  }

  function drawUnder(chart: Cx): void {
    const ax = annAxes(chart);
    const area = chart.chartArea;
    if (!ax || !area) return;
    const { ctx, canvas } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
    ctx.clip();
    for (const o of cfg.overlays) {
      const color = annColor(canvas, o);
      if (o.kind === 'band') {
        const p1 = ax.val.getPixelForValue(o.from);
        const p2 = ax.val.getPixelForValue(o.to);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.1;
        if (ax.horiz) ctx.fillRect(Math.min(p1, p2), area.top, Math.abs(p2 - p1), area.bottom - area.top);
        else ctx.fillRect(area.left, Math.min(p1, p2), area.right - area.left, Math.abs(p2 - p1));
        ctx.globalAlpha = 1;
      } else if (o.kind === 'forecast' && o.forecast) {
        const n = cfg.labels.length;
        const f = o.forecast;
        const hi = f.hi.map((v: number, i: number) => annPoint(ax, n + i, v));
        const lo = f.lo.map((v: number, i: number) => annPoint(ax, n + i, v)).reverse();
        if (!hi.length) continue;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.12;
        ctx.beginPath();
        [...hi, ...lo].forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  function drawOver(chart: Cx): void {
    const ax = annAxes(chart);
    const area = chart.chartArea;
    if (!ax || !area) return;
    const { ctx, canvas } = chart;
    const font = cfg.fontFamily;
    const placed: AnnRect[] = [];
    const box: AnnRect = { l: area.left, t: area.top, r: area.right, b: area.bottom };
    ctx.save();
    for (const o of cfg.overlays) {
      const color = annColor(canvas, o);
      const s = cfg.series[o.series || 0];
      const values = s ? s.values : [];
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      if (o.kind === 'reference' || o.kind === 'target') {
        const v = valueOf(o);
        const g = lineGeom(chart, v);
        if (!g) continue;
        ctx.lineWidth = o.kind === 'target' || state.hover === o.id || (state.drag && state.drag.id === o.id) ? 2.5 : 1.5;
        ctx.setLineDash(o.kind === 'target' ? [] : [6, 4]);
        annLineThrough(ctx, [g.a, g.b]);
        ctx.setLineDash([]);
        const label = state.drag && state.drag.id === o.id ? `${o.label} ${cfg.fmt(v)}` : o.text;
        if (ax.horiz) annPill(ctx, label, g.a[0] + 4, area.top + 9, color, font, 'left', placed, box);
        else annPill(ctx, label, area.right - 2, g.a[1] - 10, color, font, 'right', placed, box);
      } else if (o.kind === 'band') {
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([2, 3]);
        for (const v of [o.from, o.to]) { const g = lineGeom(chart, v); if (g) annLineThrough(ctx, [g.a, g.b]); }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const g = lineGeom(chart, o.to);
        if (g && !ax.horiz) annPill(ctx, o.label, area.left + 2, g.a[1] + 10, color, font, 'left', placed, box);
      } else if ((o.kind === 'trend' || o.kind === 'moving_average') && Array.isArray(o.points)) {
        const pts = o.points.map((v: Cx, i: number) =>
          (typeof v === 'number' ? annPoint(ax, annPos(cfg, i), v) : null));
        ctx.lineWidth = 2;
        ctx.setLineDash(o.kind === 'trend' ? [8, 4] : []);
        annLineThrough(ctx, pts);
        ctx.setLineDash([]);
        const last = [...pts].reverse().find((p) => p);
        if (last) annPill(ctx, o.kind === 'trend' ? `${o.label} ${o.text.split(' · ')[0]}` : o.label, last[0] - 2, last[1] - 12, color, font, 'right', placed, box);
      } else if (o.kind === 'forecast' && o.forecast) {
        const n = cfg.labels.length;
        let lastIdx = -1;
        for (let i = values.length - 1; i >= 0; i--) if (typeof values[i] === 'number') { lastIdx = i; break; }
        const pts: Array<[number, number]> = [];
        if (lastIdx >= 0) pts.push(annPoint(ax, lastIdx, values[lastIdx]));
        o.forecast.values.forEach((v: number, i: number) => pts.push(annPoint(ax, n + i, v)));
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        annLineThrough(ctx, pts);
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        for (const p of pts.slice(lastIdx >= 0 ? 1 : 0)) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2); ctx.fill(); }
        const end = pts[pts.length - 1];
        if (end) annPill(ctx, `${o.label} ${cfg.fmt(o.forecast.values[o.forecast.values.length - 1])}`, end[0] - 2, end[1] - 12, color, font, 'right', placed, box);
      } else if (o.kind === 'highlight' && o.highlight) {
        drawHighlight(chart, ax, o, color);
      } else if (o.kind === 'annotation' && o.annotation) {
        const i = cfg.labels.map(String).indexOf(String(o.annotation.at));
        const v = o.annotation.value;
        if (i < 0) continue;
        const pos = annPos(cfg, i);
        const p = typeof v === 'number' ? annPoint(ax, pos, v) : annPoint(ax, pos, ax.val.min);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2); ctx.fill();
        const y = Math.max(area.top + 9, p[1] - 22);
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        annLineThrough(ctx, [[p[0], p[1] - 4], [p[0], y + 8]]);
        const right = p[0] > (area.left + area.right) / 2;
        // A callout on the surface colour with the text colour — readable in
        // both themes, and distinct from the solid pills of the lines.
        annPill(ctx, String(o.annotation.text).slice(0, 60), p[0] + (right ? 4 : -4), y,
          getCSSVar('--surface-float', canvas) || '#fff', font, right ? 'right' : 'left', placed, box,
          { ink: getCSSVar('--text-strong', canvas) || '#222', edge: o.color || getCSSVar('--border-2', canvas) || '#ccc' });
      }
    }
    drawPins(chart, ax);
    ctx.restore();
  }

  function drawHighlight(chart: Cx, ax: { cat: Cx; val: Cx; horiz: boolean }, o: Cx, color: string): void {
    const { ctx } = chart;
    const s = cfg.series[o.series || 0];
    const meta = chart.getDatasetMeta(o.series || 0);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    for (const i of o.highlight.indices) {
      const pos = annPos(cfg, i);
      const el = meta && meta.data ? meta.data[pos] : null;
      if (el && typeof el.width === 'number' && typeof el.base === 'number') {
        const r = typeof el.getProps === 'function' ? el.getProps(['x', 'y', 'base', 'width', 'height'], true) : el;
        if (ax.horiz) ctx.strokeRect(Math.min(r.x, r.base), r.y - r.height / 2, Math.abs(r.x - r.base), r.height);
        else ctx.strokeRect(r.x - r.width / 2, Math.min(r.y, r.base), r.width, Math.abs(r.base - r.y));
      } else if (s && typeof s.values[i] === 'number') {
        const p = annPoint(ax, pos, s.values[i]);
        ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function pinGeom(ax: { cat: Cx; val: Cx; horiz: boolean }, pin: AnnCommentPin): [number, number] | null {
    const i = cfg.labels.map(String).indexOf(String(pin.label));
    if (i < 0) return null;
    let si = pin.series ? cfg.series.findIndex((s) => s && s.name === pin.series) : 0;
    if (si < 0) si = 0;
    const s = cfg.series[si];
    const v = s && typeof s.values[i] === 'number' ? s.values[i] : ax.val.min;
    const p = annPoint(ax, annPos(cfg, i), v);
    return ax.horiz ? [p[0] + 14, p[1]] : [p[0], p[1] - 14];
  }

  function drawPins(chart: Cx, ax: { cat: Cx; val: Cx; horiz: boolean }): void {
    const { ctx, canvas } = chart;
    const accent = getCSSVar('--accent', canvas) || '#6366f1';
    const muted = getCSSVar('--text-faint', canvas) || '#999';
    for (const pin of cfg.pins) {
      const g = pinGeom(ax, pin);
      if (!g) continue;
      ctx.save();
      ctx.fillStyle = pin.resolved ? muted : accent;
      ctx.beginPath(); ctx.arc(g[0], g[1], 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `700 9px ${cfg.fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(pin.n), g[0], g[1] + 0.5);
      ctx.restore();
    }
  }

  // ── interaction ────────────────────────────────────────────────────────────

  function nearLine(chart: Cx, x: number, y: number): Cx {
    const ax = annAxes(chart);
    if (!ax) return null;
    for (const o of cfg.overlays) {
      if (!o.draggable || (o.kind !== 'reference' && o.kind !== 'target')) continue;
      const p = ax.val.getPixelForValue(valueOf(o));
      if (Math.abs((ax.horiz ? x : y) - p) <= 5) return o;
    }
    return null;
  }

  function hitPin(chart: Cx, x: number, y: number): AnnCommentPin | null {
    const ax = annAxes(chart);
    if (!ax) return null;
    for (const pin of cfg.pins) {
      const g = pinGeom(ax, pin);
      if (g && Math.hypot(g[0] - x, g[1] - y) <= 9) return pin;
    }
    return null;
  }

  /** A value dragged to a pixel, rounded to three significant figures of the axis span. */
  function niceValue(ax: { val: Cx }, v: number): number {
    const span = Math.abs((ax.val.max || 0) - (ax.val.min || 0)) || Math.abs(v) || 1;
    const step = Math.pow(10, Math.floor(Math.log10(span)) - 2);
    return Math.round(v / step) * step;
  }

  function attach(chart: Cx): void {
    const canvas: HTMLCanvasElement = chart.canvas;
    const editable = !!(canvas && canvas.closest && canvas.closest('[data-chart-editable]'));
    const local = (e: PointerEvent | MouseEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const onMove = (e: PointerEvent) => {
      const [x, y] = local(e);
      if (state.drag) {
        const ax = annAxes(chart);
        if (!ax) return;
        state.drag.value = niceValue(ax, ax.val.getValueForPixel(ax.horiz ? x : y));
        chart.draw();
        return;
      }
      const line = editable ? nearLine(chart, x, y) : null;
      const pin = hitPin(chart, x, y);
      const hover = line ? line.id : null;
      canvas.style.cursor = line ? (chart.options.indexAxis === 'y' ? 'ew-resize' : 'ns-resize') : pin ? 'pointer' : '';
      if (hover !== state.hover) { state.hover = hover; chart.draw(); }
    };
    const onDown = (e: PointerEvent) => {
      if (!editable || e.button !== 0) return;
      const [x, y] = local(e);
      const line = nearLine(chart, x, y);
      if (!line) return;
      state.drag = { id: line.id, value: line.value };
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not every pointer can be captured */ }
      e.preventDefault();
      e.stopPropagation();
    };
    const onUp = (e: PointerEvent) => {
      if (!state.drag) return;
      const done = state.drag;
      state.drag = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      annotationHooks.onOverlayDragged?.(done.id, done.value);
    };
    const onClick = (e: MouseEvent) => {
      const [x, y] = local(e);
      const pin = hitPin(chart, x, y);
      if (pin) {
        e.stopPropagation();
        if (cfg.pinTarget) annotationHooks.onOpenPin?.(cfg.pinTarget.kind, cfg.pinTarget.id, pin.id);
        return;
      }
      if (!editable || !e.altKey) return;
      const els = chart.getElementsAtEventForMode(e, 'nearest', { intersect: false }, true);
      const el = els && els[0];
      if (!el) return;
      const orig = cfg.order ? cfg.order[el.index] : el.index;
      if (orig === undefined || orig >= cfg.labels.length) return;
      e.stopPropagation();
      annotationHooks.onAnnotateAt?.(String(cfg.labels[orig]), el.datasetIndex || 0);
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('click', onClick, true);
    state.cleanup = () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('click', onClick, true);
    };
  }

  return {
    id: 'ordAnnotations',
    /** What this chart was handed — read by the smoke to prove pins arrived. */
    config: cfg,
    afterInit(chart: Cx) { attach(chart); },
    beforeDatasetsDraw(chart: Cx) { drawUnder(chart); },
    afterDatasetsDraw(chart: Cx) { drawOver(chart); },
    afterDestroy() { if (state.cleanup) state.cleanup(); state.cleanup = null; },
  };
}
