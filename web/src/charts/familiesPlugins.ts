// What the waterfall, bullet, calendar heatmap and Pareto families draw BY
// HAND on the canvas (the desktop's chartFamiliesPlugins.ts) — waterfall
// connectors and step labels, bullet bands and target ticks, the Pareto 80%
// marker, the calendar's month/weekday labels and colour legend. Every hook
// reads the state familiesExtra's dataset builder left on `opts`, and runs in
// afterDatasetsDraw / afterDraw / beforeDatasetsDraw — which also run with
// animation off, so PNG exports carry every mark.

import { CAL_WEEKDAYS, EXTRA_FULL_MIN_W, xAlpha } from './familiesExtra';
import { valueLabelKeys, valueLabelText } from './labelText';
import type { BulletRow, CalendarCell } from './shapes';
import { t } from './strings';
import type { ChartCtx, Cx } from './types';

const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function buildExtraPlugins(c: ChartCtx): Cx[] {
  const { opts, valueMode, fontFamily, textColor, titleColor, fmt } = c;
  const plugins: Cx[] = [];
  const text = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number,
                align: CanvasTextAlign, base: CanvasTextBaseline, color = titleColor, weight = 600): void => {
    ctx.font = `${weight} 10px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.fillText(s, x, y);
  };
  // The label text, by the same rule as every other value label (chartValueLabels).
  const label = (v: number): string => (c.overrides.numberFormat ? fmt(v) : valueLabelText(v));

  if (c.isWaterfall) {
    const w = opts._wf;
    // Thin dashed connectors from each bar's end to the next bar, at the
    // running level — the line the eye follows down a waterfall.
    plugins.push({
      id: 'waterfallConnectors',
      afterDatasetsDraw(chart: Cx) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        const ys = chart.scales.y;
        if (!meta || !ys) return;
        ctx.save();
        ctx.strokeStyle = xAlpha(textColor, 0.6);
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        for (let i = 0; i < meta.data.length - 1; i++) {
          const a = meta.data[i], b = meta.data[i + 1];
          if (!a || !b) continue;
          const y = Math.round(ys.getPixelForValue(w.running[i])) + 0.5;
          ctx.beginPath();
          ctx.moveTo(a.x + a.width / 2, y);
          ctx.lineTo(b.x - b.width / 2, y);
          ctx.stroke();
        }
        ctx.restore();
      },
    });
    if (valueMode !== 'off') {
      // Totals are always labelled; steps follow the Values menu (max/min/all).
      const steps = w.kind.map((k: string, i: number) => (k === 'up' || k === 'down' ? w.delta[i] : null));
      const keys = valueLabelKeys(valueMode, [steps]);
      plugins.push({
        id: 'waterfallLabels',
        afterDatasetsDraw(chart: Cx) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          ctx.save();
          meta.data.forEach((el: Cx, i: number) => {
            const step = steps[i] !== null;
            if (!el || (step && !keys.has('0:' + i))) return;
            const v = w.delta[i];
            const s = (step && v > 0 ? '+' : '') + label(v);
            if (v >= 0) text(ctx, s, el.x, Math.min(el.y, el.base) - 4, 'center', 'bottom');
            else text(ctx, s, el.x, Math.max(el.y, el.base) + 4, 'center', 'top');
          });
          ctx.restore();
        },
      });
    }
  }

  if (c.isPareto) {
    const p = opts._pareto;
    // The 80% line on the percent axis, and a ring where the cumulative line
    // first reaches it: "these N categories are the 80%".
    plugins.push({
      id: 'paretoMarker',
      afterDatasetsDraw(chart: Cx) {
        const { ctx, chartArea: a } = chart;
        const y1 = chart.scales.y1;
        if (!a || !y1 || !p.count80) return;
        const y = Math.round(y1.getPixelForValue(80)) + 0.5;
        ctx.save();
        ctx.strokeStyle = xAlpha(textColor, 0.75);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke();
        const line = chart.getDatasetMeta(1);
        const pt = line && !line.hidden && line.data[p.count80 - 1];
        if (pt) {
          ctx.beginPath(); ctx.moveTo(pt.x, pt.y); ctx.lineTo(pt.x, a.bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 2;
          ctx.strokeStyle = opts._paretoLine;
          ctx.beginPath(); ctx.arc(pt.x, pt.y, 5.5, 0, Math.PI * 2); ctx.stroke();
          if (chart.width >= EXTRA_FULL_MIN_W) {
            const right = pt.x > a.left + a.width * 0.7;
            text(ctx, t('chartFamiliesPlugins.80_of', { count80: p.count80, labelsCount: p.labels.length }), pt.x + (right ? -9 : 9), pt.y - 8,
                 right ? 'right' : 'left', 'bottom');
          }
        }
        ctx.restore();
      },
    });
    if (valueMode !== 'off') {
      const keys = valueLabelKeys(valueMode, [p.values]);
      plugins.push({
        id: 'paretoLabels',
        afterDatasetsDraw(chart: Cx) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          if (!meta || meta.hidden) return;
          ctx.save();
          meta.data.forEach((el: Cx, i: number) => {
            const v = p.values[i];
            if (el && v !== null && keys.has('0:' + i)) text(ctx, label(v), el.x, el.y - 4, 'center', 'bottom');
          });
          ctx.restore();
        },
      });
    }
  }

  if (c.isBullet) {
    const b = opts._bullet;
    const bandH = (chart: Cx): number =>
      Math.min((chart.chartArea.height / Math.max(1, b.rows.length)) * 0.62, 30);
    // Three qualitative bands behind each bar — poor, fair, good — darkest
    // first, as muted shades of the theme's own text token.
    plugins.push({
      id: 'bulletBands',
      beforeDatasetsDraw(chart: Cx) {
        const { ctx, chartArea: a } = chart;
        const xs = chart.scales.x, ys = chart.scales.y;
        if (!a || !xs || !ys) return;
        const h = bandH(chart);
        const shades = [xAlpha(textColor, 0.3), xAlpha(textColor, 0.18), xAlpha(textColor, 0.09)];
        ctx.save();
        ctx.beginPath(); ctx.rect(a.left, a.top, a.width, a.height); ctx.clip();
        b.rows.forEach((r: BulletRow, i: number) => {
          const cy = ys.getPixelForValue(i);
          let prev = xs.getPixelForValue(0);
          r.bands.forEach((edge: number, k: number) => {
            const x = xs.getPixelForValue(edge);
            ctx.fillStyle = shades[k];
            ctx.fillRect(Math.min(prev, x), cy - h / 2, Math.abs(x - prev), h);
            prev = x;
          });
        });
        ctx.restore();
      },
      // The target tick, then the value labels, over the bars.
      afterDatasetsDraw(chart: Cx) {
        const { ctx } = chart;
        const xs = chart.scales.x, ys = chart.scales.y;
        if (!xs || !ys) return;
        const h = bandH(chart) * 0.8;
        ctx.save();
        ctx.fillStyle = titleColor;
        b.rows.forEach((r: BulletRow, i: number) => {
          if (r.target === null) return;
          ctx.fillRect(Math.round(xs.getPixelForValue(r.target)) - 1.25, ys.getPixelForValue(i) - h / 2, 2.5, h);
        });
        if (valueMode !== 'off') {
          const keys = valueLabelKeys(valueMode, [b.rows.map((r: BulletRow) => r.value)]);
          const meta = chart.getDatasetMeta(0);
          meta.data.forEach((el: Cx, i: number) => {
            const v = b.rows[i] && b.rows[i].value;
            if (!el || v === null || v === undefined || !keys.has('0:' + i)) return;
            text(ctx, label(v), v >= 0 ? el.x + 6 : el.x - 6, el.y, v >= 0 ? 'left' : 'right', 'middle');
          });
        }
        ctx.restore();
      },
    });
  }

  if (c.isCalendar) plugins.push(calendarFrame(c, text));
  return plugins;
}

// The calendar's frame: per band, month names along its top edge and Mon/Wed/Fri
// down its left, then a min → max colour legend under the last band — all in
// the room calPad reserves, and none of it on a thumbnail.
function calendarFrame(
  c: ChartCtx,
  text: (ctx: CanvasRenderingContext2D, s: string, x: number, y: number,
         align: CanvasTextAlign, base: CanvasTextBaseline, color?: string, weight?: number) => void,
): Cx {
  const { opts, fontFamily, textColor, fmt } = c;
  const cal = opts._cal;
  const lay = opts._calLay;
  const multiYear = cal.monthMarks.some((m: Cx) => m.year !== cal.monthMarks[0].year);
  // Each band's labels: its real month starts, plus the month it OPENS in when
  // no month starts in its first column.
  const bandMarks: Array<Array<{ col: number; s: string }>> = [];
  for (let b = 0; b < lay.bands; b++) {
    const lo = b * lay.perRow, hi = lo + lay.perRow;
    const marks = cal.monthMarks.filter((m: Cx) => m.week >= lo && m.week < hi)
      .map((m: Cx) => ({ col: m.week - lo, month: m.month, year: m.year }));
    if (!marks.length || marks[0].col > 0) {
      const first = cal.cells.find((k: CalendarCell) => k.week === lo);
      if (first) marks.unshift({ col: 0, month: +first.date.slice(5, 7) - 1, year: +first.date.slice(0, 4) });
    }
    // A month that opens a band in its last days leaves no room to name it.
    if (marks.length > 1 && marks[1].col - marks[0].col < 2) marks.shift();
    bandMarks.push(marks.map((m: Cx, k: number) => ({
      col: m.col,
      s: CAL_MONTHS[m.month] + (multiYear && (m.month === 0 || k === 0) ? ' ' + m.year : ''),
    })));
  }
  return {
    id: 'calendarFrame',
    afterDraw(chart: Cx) {
      const { ctx, chartArea: a } = chart;
      if (!a || chart.width < EXTRA_FULL_MIN_W) return;
      const colW = a.width / lay.perRow, rowH = a.height / lay.rows;
      ctx.save();
      bandMarks.forEach((marks, b) => {
        const top = a.top + b * (7 + lay.gap) * rowH;
        let lastRight = -Infinity;
        ctx.font = `500 10px ${fontFamily}`;
        marks.forEach((m) => {
          const x = a.left + m.col * colW;
          if (x < lastRight + 6) return;
          text(ctx, m.s, x, top - 5, 'left', 'bottom', textColor, 500);
          lastRight = x + ctx.measureText(m.s).width;
        });
        if (rowH >= 8) {
          [0, 2, 4].forEach((d) => text(ctx, CAL_WEEKDAYS[d], a.left - 6, top + (d + 0.5) * rowH, 'right', 'middle', textColor, 500));
        }
      });
      // Legend: min, five swatches along the ramp, max — right-aligned.
      const lo = fmt(cal.min), hi = fmt(cal.max);
      const sw = 10, gap = 3, y = a.bottom + 10;
      ctx.font = `500 10px ${fontFamily}`;
      let x = a.right - ctx.measureText(hi).width;
      text(ctx, hi, x, y + sw / 2, 'left', 'middle', textColor, 500);
      x -= 6 + 5 * sw + 4 * gap;
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = opts._calHeat(cal.min + (i / 4) * (cal.max - cal.min));
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x + i * (sw + gap), y, sw, sw, 2); else ctx.rect(x + i * (sw + gap), y, sw, sw);
        ctx.fill();
      }
      text(ctx, lo, x - 6, y + sw / 2, 'right', 'middle', textColor, 500);
      ctx.restore();
    },
  };
}
