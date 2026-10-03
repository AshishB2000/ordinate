// The inline Chart.js plugins that put the app's own figures on a chart
// (renderer/hub/chartValueLabels.ts, its drawing half): gauge centre, funnel
// stage labels, value labels, round-slice labels, heatmap cell labels. All run
// in afterDatasetsDraw (gauge in afterDraw), reading per-family state the
// dataset builders left on `opts`.

import { isExtraFamily } from './familiesExtra';
import { buildExtraPlugins } from './familiesPlugins';
import { numOf, roundLabelFits, valueLabelAt, valueLabelKeys, valueLabelOf } from './labelText';
import type { ChartCtx, Cx } from './types';

// The per-chart inline plugins for one chart, in the order Chart.js should see
// them. Locals are destructured out of the context under their ORIGINAL names so
// each plugin body below is the same code it was inside buildChart.
export function buildChartPlugins(c: ChartCtx): Cx[] {
  // Waterfall / bullet / calendar / radar / Pareto draw their own marks and
  // labels: chartFamiliesExtra.js.
  if (isExtraFamily(c)) return buildExtraPlugins(c);
  const {
    opts, overrides, fmt, valueMode, fontFamily, textColor, titleColor,
    isRound, isGauge, isTreemap, isMatrix, isFunnel, isSankey, isCandlestick, isBoxplot, isHoriz,
  } = c;

  const inlinePlugins: Cx[] = [];   // Chart.js plugin objects, hooks typed per-use

  if (isGauge) {
    // Print the actual value at the hub of the half-circle.
    inlinePlugins.push({
      id: 'gaugeCenter',
      afterDraw(chart: Cx) {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        const v = opts._gaugeValue;
        const txt = (v >= 0 && v <= 1) ? Math.round(v * 100) + '%' : fmt(v);
        const cx = (chartArea.left + chartArea.right) / 2;
        const cy = (chartArea.top + chartArea.bottom) / 2 + 4;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = `700 22px ${fontFamily}`;
        ctx.fillStyle = titleColor;
        ctx.textBaseline = 'top';
        ctx.fillText(txt, cx, cy);
        // Name the metric below the value so the gauge isn't a context-free number.
        // (Skipped in small multiples — the per-mini caption already shows the name.)
        const label = opts._gaugeLabel;
        if (label && !overrides._smallMultiple) {
          ctx.font = `500 11px ${fontFamily}`;
          ctx.fillStyle = textColor;
          ctx.fillText(label, cx, cy + 26);
        }
        ctx.restore();
      },
    });
  }

  if (isFunnel) {
    // Always print each stage's value, centered on its bar.
    inlinePlugins.push({
      id: 'funnelLabels',
      afterDatasetsDraw(chart: Cx) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(1);   // the value dataset
        if (!meta) return;
        const vals = opts._funnelVals;
        meta.data.forEach((el: Cx, i: number) => {
          if (vals[i] == null) return;
          const pos = el.tooltipPosition();
          ctx.save();
          ctx.font = `600 11px ${fontFamily}`;
          // ON the filled stage, not floating over the plot — white is right in
          // both themes. The floating labels above use titleColor, which is the
          // token. Do not "theme" this one.
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(fmt(vals[i]), pos.x, pos.y);
          ctx.restore();
        });
      },
    });
  }

  if (valueMode !== 'off' && !isRound && !isTreemap && !isMatrix && !isFunnel
      && !isSankey && !isCandlestick && !isBoxplot) {
    // Draw the data value near selected bars/points after the chart renders.
    inlinePlugins.push({
      id: 'valueLabels',
      afterDatasetsDraw(chart: Cx) {
        const { ctx } = chart;
        // Build the value grid from visible datasets only (hidden → all-null row).
        // A period overlay is context, not a figure to read off: no labels, and
        // its peaks must not crowd out the real series' (visualsOverlay.ts).
        const grid = chart.data.datasets.map((ds: Cx, di: number) =>
          chart.getDatasetMeta(di).hidden || ds._overlay ? [] : (ds.data || []).map(numOf));
        const keys = valueLabelKeys(valueMode, grid);
        // Place each label in the first free vertical slot near its point so labels never
        // overlap. Sparse max/min modes nudge a collision into a small stack (keeping every
        // series' peak/trough visible even when lines nearly coincide); dense 'all' mode
        // just drops overlaps. Nudged slots stay inside the plot; the natural slot doesn't.
        const placed: { x: number; y: number; w: number; h: number }[] = [];
        const overlaps = (x: number, y: number, w: number, h: number) => placed.some((r) =>
          x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y);
        // Drop duplicate labels: identical value at the same x (e.g. several near-equal
        // series peaking at the same category) collapses to one, so it never piles up.
        const seen = new Set<string>();
        const area = chart.chartArea;
        const h = 12;
        const offsets = valueMode === 'all'
          ? [0]
          : [0, -(h + 1), h + 1, -2 * (h + 1), 2 * (h + 1), -3 * (h + 1), 3 * (h + 1), -4 * (h + 1), 4 * (h + 1)];
        ctx.save();
        ctx.font = `600 10px ${fontFamily}`;
        ctx.fillStyle = titleColor;
        ctx.textAlign = 'center';
        chart.data.datasets.forEach((dataset: Cx, di: number) => {
          const meta = chart.getDatasetMeta(di);
          if (meta.hidden || dataset._overlay) return;
          meta.data.forEach((element: Cx, j: number) => {
            if (!keys.has(di + ':' + j)) return;
            let displayVal = numOf(dataset.data[j]);
            if (displayVal == null) return;
            // Stacked charts position each point at the cumulative top, so label the running
            // total (visible series 0..di) — otherwise the raw number won't match the axis.
            if (opts.stacked) {
              let cum = 0;
              for (let d = 0; d <= di; d++) {
                if (chart.getDatasetMeta(d).hidden) continue;
                const dv = numOf(chart.data.datasets[d].data[j]);
                if (typeof dv === 'number') cum += dv;
              }
              displayVal = cum;
            }
            const pos = element.tooltipPosition();
            const formatted = valueLabelOf(displayVal, overrides, fmt);
            const w = ctx.measureText(formatted).width;
            const at = valueLabelAt(element, pos, isHoriz, overrides.labelPosition, w, h,
              chart.config.type === 'bar' && dataset.type !== 'line');
            const tx = at.x;
            const ty0 = at.y;
            const bx = at.bx;
            const dedupeKey = formatted + '@' + Math.round(tx);
            if (seen.has(dedupeKey)) return;
            for (const dy of offsets) {
              const ty = ty0 + dy;
              const by = isHoriz ? ty - h / 2 : ty - h;
              if (dy !== 0 && area && (by < area.top || by + h > area.bottom)) continue;
              if (overlaps(bx, by, w, h)) continue;
              placed.push({ x: bx, y: by, w, h });
              seen.add(dedupeKey);
              ctx.textBaseline = isHoriz ? 'middle' : 'bottom';
              // On a filled bar (inside / centre) white reads in both themes,
              // as the funnel's stage labels do; off it, the title token.
              ctx.fillStyle = at.onMark ? '#ffffff' : titleColor;
              ctx.fillText(formatted, tx, ty);
              break;
            }
          });
        });
        ctx.restore();
      },
    });
  }

  // A gauge is DRAWN as a doughnut, so isRound is true for it — correctly, for
  // datasets, cutout and rotation. Not for this plugin: a gauge's two "slices"
  // are a value and its remainder, not categories, and its label IS the metric
  // name the gaugeCenter plugin above already prints under the big number. So
  // roundLabels drew the same words twice on one small chart.
  if (isRound && !isGauge) {
    // Pie/donut have no axes, so label each big-enough slice with its category name
    // directly (always on — readable without hovering or colour-matching the legend);
    // slices that cannot hold their label fall back to the legend. When Values is
    // on, the slice's value is added below the name. White text + shadow keeps it
    // legible on any slice colour.
    //
    // "Big enough" is TWO tests, and the second is the one that matters at small
    // sizes: a share of the total (a product judgement about which slices deserve
    // a name at all), and then whether the measured text actually fits the slice's
    // geometry (roundLabelFits above). Without the second, a dashboard card's
    // ~150px donut drew its category names straight across the ring.
    inlinePlugins.push({
      id: 'roundLabels',
      afterDatasetsDraw(chart: Cx) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        const ds = chart.data.datasets[0];
        const row = ((ds && ds.data) || []).map(numOf);
        const total = row.reduce((a: number, v: number | null) => a + (typeof v === 'number' ? Math.abs(v) : 0), 0) || 1;
        const cats = chart.data.labels || [];
        const valueKeys = valueMode !== 'off' ? valueLabelKeys(valueMode, [row]) : new Set<string>();
        const clip = (s: string) => (s.length > 14 ? s.slice(0, 13) + '…' : s);
        meta.data.forEach((el: Cx, j: number) => {
          if (!el) return;
          const val = row[j];
          const frac = (typeof val === 'number' ? Math.abs(val) : 0) / total;
          const name = cats[j] == null ? '' : String(cats[j]);
          const showName = frac >= 0.06 && name !== '';   // only slices big enough to read
          const showVal = val != null && valueKeys.has('0:' + j);
          if (!showName && !showVal) return;
          const lines: string[] = [];
          if (showName) lines.push(clip(name));
          if (showVal) lines.push(valueLabelOf(val, overrides, fmt));
          const lh = 12;
          // Measure with each line's OWN font — the name is 600 weight and the
          // value 500, and the widest line is what has to fit.
          const fontFor = (k: number) => `${(k === 0 && showName) ? 600 : 500} 10px ${fontFamily}`;
          ctx.save();
          let textWidth = 0;
          lines.forEach((ln: string, k: number) => {
            ctx.font = fontFor(k);
            textWidth = Math.max(textWidth, ctx.measureText(ln).width);
          });
          if (!roundLabelFits(el, textWidth, lines.length * lh)) { ctx.restore(); return; }
          const pos = el.tooltipPosition();
          const y0 = pos.y - ((lines.length - 1) * lh) / 2;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 3;
          // Inside the slice — roundLabelFits() above refuses to draw otherwise —
          // so this sits on a filled arc in the accent palette, never on the
          // plot background. White plus the shadow is correct in both themes.
          ctx.fillStyle = '#ffffff';
          lines.forEach((ln: string, k: number) => {
            ctx.font = fontFor(k);
            ctx.fillText(ln, pos.x, y0 + k * lh);
          });
          ctx.restore();
        });
      },
    });
  }

  if (valueMode !== 'off' && isMatrix) {
    inlinePlugins.push({
      id: 'matrixValueLabels',
      afterDatasetsDraw(chart: Cx) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        const rows = (opts._matrixRows || []).length;
        if (!rows) return;
        const keys = valueLabelKeys(valueMode, opts._matrixGrid || []);   // [colIdx][rowIdx]
        meta.data.forEach((el: Cx, k: number) => {
          const colIdx = Math.floor(k / rows), rowIdx = k % rows;
          if (!keys.has(colIdx + ':' + rowIdx)) return;
          const v = numOf((chart.data.datasets[0].data[k] || {}).v);
          if (v == null) return;
          const pos = el.getCenterPoint ? el.getCenterPoint() : { x: el.x, y: el.y };
          const formatted = valueLabelOf(v, overrides, fmt);
          // Ink picked by cell darkness (the same accent-alpha ramp the cell is filled
          // with) — replaces the old halo stroke, which left a smudge behind the digits.
          const span = (opts._matrixVmax - opts._matrixVmin) || 1;
          const cellAlpha = 0.15 + 0.85 * ((v - opts._matrixVmin) / span);
          ctx.save();
          ctx.font = `600 10px ${fontFamily}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = cellAlpha >= 0.55 ? '#ffffff' : titleColor;
          ctx.fillText(formatted, pos.x, pos.y);
          ctx.restore();
        });
      },
    });
  }

  return inlinePlugins;
}
