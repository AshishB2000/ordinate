// The project's EVENTS on a chart's date axis — a marker for a single date, a
// shaded band for a range, an icon per kind and the title on hover. A
// hand-written inline Chart.js plugin beside chartAnnotations.ts, no dependency.
//
// NOTHING HERE MATCHES A DATE. Main placed every event on `data.events`
// (src/analysis/events.ts via `visual:data`) as label indices at the chart's
// own grain; this file turns indices into pixels through the chart's scales.
// A visual hides them with `overrides.showEvents === false` (Format → Axes).
//
// On an export (`overrides.devicePixelRatio`: a report page, a PNG) there is no hover,
// so each icon carries its title instead.
//
// Classic global-scope script — NO import/export. Reuses annPill/annAxes from
// chartAnnotations.js, resolved at call time.

interface EvMark { id: string; kind: string; title: string; when: string; from: number; to: number; range: boolean }

const EV_KIND_VAR: Record<string, string> = {
  launch: '--accent', campaign: '--warn', incident: '--error', holiday: '--ok', other: '--text-dim',
};
const EV_KIND_NAME: Record<string, string> = {
  launch: t('common.launch'), campaign: t('common.campaign'), incident: t('common.incident'), holiday: t('common.holiday'), other: t('common.event'),
};
const EV_ICON_R = 7;

/**
 * The events this chart draws: none when the visual hides them, when the axis
 * was re-sorted (no longer in time order), or for a type without a category
 * axis an annotation could sit on.
 */
function evDrawable(data: any, spec: ChartTypeSpec, sorted: boolean, overrides: any): EvMark[] {
  const list = data && Array.isArray(data.events) ? data.events : [];
  if (!list.length || sorted || (overrides && overrides.showEvents === false)) return [];
  return (spec.overlayKinds || []).indexOf('annotation') >= 0 ? list : [];
}

/** The kind's glyph, white on a filled disc — a shape per kind, so colour is not the only cue. */
function evIcon(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, EV_ICON_R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  if (kind === 'launch') { ctx.moveTo(x, y - 4); ctx.lineTo(x + 3.5, y + 3); ctx.lineTo(x - 3.5, y + 3); ctx.closePath(); ctx.fill(); }
  else if (kind === 'campaign') { ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill(); }
  else if (kind === 'incident') { ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 0.5); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y + 3, 1, 0, Math.PI * 2); ctx.fill(); }
  else if (kind === 'holiday') {
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 1.8 : 4.4;
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      if (k) ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); else ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.closePath(); ctx.fill();
  } else { ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

// ponytail: vertical category axes only — a date axis on a horizontal bar chart draws no events; add a y-axis branch if one is asked for.
function eventsPlugin(cfg: { events: EvMark[]; fontFamily: string; isStatic: boolean }): any {
  const state: { hover: string | null; icons: Array<{ ev: EvMark; x: number; y: number }>; cleanup: (() => void) | null } =
    { hover: null, icons: [], cleanup: null };

  /** Left / right pixel of an event: a line has l === r, a band spans its buckets. */
  function geom(chart: ChartJsCtx, ev: EvMark): { l: number; r: number } | null {
    const ax = annAxes(chart);
    const area = chart.chartArea;
    if (!ax || ax.horiz || !area) return null;
    const step = Math.abs(ax.cat.getPixelForValue(1) - ax.cat.getPixelForValue(0)) || (area.right - area.left);
    const l = ax.cat.getPixelForValue(ev.from);
    const r = ax.cat.getPixelForValue(ev.to);
    if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
    return ev.range
      ? { l: Math.max(area.left, l - step / 2), r: Math.min(area.right, r + step / 2) }
      : { l, r: l };
  }

  function drawUnder(chart: ChartJsCtx): void {
    const area = chart.chartArea;
    if (!area) return;
    const { ctx, canvas } = chart;
    ctx.save();
    for (const ev of cfg.events) {
      const g = geom(chart, ev);
      if (!g) continue;
      const color = getCSSVar(EV_KIND_VAR[ev.kind] || '--text-dim', canvas) || '#64748b';
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (ev.range) {
        ctx.globalAlpha = state.hover === ev.id ? 0.16 : 0.08;
        ctx.fillRect(g.l, area.top, Math.max(1, g.r - g.l), area.bottom - area.top);
      } else {
        ctx.globalAlpha = state.hover === ev.id ? 0.9 : 0.55;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(g.l, area.top); ctx.lineTo(g.l, area.bottom); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawOver(chart: ChartJsCtx): void {
    const area = chart.chartArea;
    if (!area) return;
    const { ctx, canvas } = chart;
    const box: AnnRect = { l: area.left, t: area.top, r: area.right, b: area.bottom };
    const placed: AnnRect[] = [];
    state.icons = [];
    for (const ev of cfg.events) {
      const g = geom(chart, ev);
      if (!g) continue;
      const x = ev.range ? (g.l + g.r) / 2 : g.l;
      // Icons on one spot stack downwards rather than hiding each other.
      let y = area.top + EV_ICON_R + 2;
      while (state.icons.some((p) => Math.abs(p.x - x) < EV_ICON_R * 2 && Math.abs(p.y - y) < EV_ICON_R * 2)) y += EV_ICON_R * 2 + 2;
      state.icons.push({ ev, x, y });
      const color = getCSSVar(EV_KIND_VAR[ev.kind] || '--text-dim', canvas) || '#64748b';
      evIcon(ctx, ev.kind, x, y, color);
    }
    // Titles AFTER every icon, so a pill is never painted under a later icon.
    for (const { ev, x, y } of state.icons) {
      if (!cfg.isStatic && state.hover !== ev.id) continue;
      const color = getCSSVar(EV_KIND_VAR[ev.kind] || '--text-dim', canvas) || '#64748b';
      const full = cfg.isStatic ? ev.title : `${EV_KIND_NAME[ev.kind] || t('common.event')} · ${ev.title} · ${ev.when}`;
      const text = full.length > 64 ? full.slice(0, 63) + '…' : full;
      const right = x > (area.left + area.right) / 2;
      annPill(ctx, text, x + (right ? -(EV_ICON_R + 3) : EV_ICON_R + 3), y, getCSSVar('--surface-float', canvas) || '#fff',
        cfg.fontFamily, right ? 'right' : 'left', placed, box,
        { ink: getCSSVar('--text-strong', canvas) || '#222', edge: color });
    }
  }

  function attach(chart: ChartJsCtx): void {
    const canvas: HTMLCanvasElement = chart.canvas;
    if (!canvas || cfg.isStatic) return;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const hit = state.icons.find((p) => Math.hypot(p.x - x, p.y - y) <= EV_ICON_R + 3);
      const id = hit ? hit.ev.id : null;
      if (id === state.hover) return;
      state.hover = id;
      chart.draw();
    };
    const onLeave = () => { if (state.hover) { state.hover = null; chart.draw(); } };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    state.cleanup = () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }

  return {
    id: 'ordEvents',
    /** What this chart was handed — read by the smoke to prove events arrived. */
    events: cfg.events,
    /** The event under the pointer (its title pill is showing) — read by the smoke. */
    hovered: (): string | null => state.hover,
    afterInit(chart: ChartJsCtx) { attach(chart); },
    beforeDatasetsDraw(chart: ChartJsCtx) { drawUnder(chart); },
    afterDatasetsDraw(chart: ChartJsCtx) { drawOver(chart); },
    afterDestroy() { if (state.cleanup) state.cleanup(); state.cleanup = null; },
  };
}
