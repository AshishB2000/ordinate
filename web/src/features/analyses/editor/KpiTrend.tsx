// A KPI's small TREND (CardMetric.trend, src/ipc/kpiTrend.ts): the line of its
// months and, when the card has no Compare of its own, the change in the latest
// month. Every figure — the months' values, the delta's text, its percent and
// whether it is good news — is the server's; this only draws them.

import { Icon } from '../../../ui/icons/Icon';
import type { KpiTrend } from '../api';
import s from './Cards.module.css';

const W = 120;
const H = 28;

/** The months as a line, scaled to the box. Drawing, not arithmetic on a figure the reader sees. */
export function TrendLine({ trend }: { trend: KpiTrend }) {
  const pts = trend.values.flatMap((v, i) => (v === null ? [] : [[i, v] as const]));
  if (pts.length < 2) return null;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys);
  const span = Math.max(...ys) - min || 1;
  const step = W / Math.max(1, trend.values.length - 1);
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${(i * step).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`).join(' ');
  const first = trend.labels[pts[0][0]] ?? '';
  const last = trend.labels[pts[pts.length - 1][0]] ?? '';
  return (
    <svg className={s.spark} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Monthly trend, ${first} to ${last}`}>
      <path d={d} />
    </svg>
  );
}

/** The latest month against the one before, as the server worded and judged it; `pct` is its percent as MetricCard words one. */
export function TrendChange({ change, pct }: { change: NonNullable<KpiTrend['change']>; pct: string }) {
  const up = change.delta > 0;
  return (
    <>
      <div className={`${s.delta} ${s[change.tone]}`}>
        {change.delta !== 0 && <Icon name={up ? 'arrow-up' : 'arrow-down'} size={12} />}
        <span className={s.tnum}>{change.deltaDisplay}</span>
        {pct && <span className={s.tnum}>({pct})</span>}
      </div>
      <div className={s.vsRow}>
        <span className={s.vs} title={change.label}>
          {change.label}
        </span>
      </div>
    </>
  );
}
