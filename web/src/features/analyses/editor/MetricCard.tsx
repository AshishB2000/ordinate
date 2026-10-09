// A KPI card's body (legacy dashFiltersUi.ts renderMetricCard + kpiCompare.ts
// paintMetricCompare): the server's figure — a saved metric's own display
// string, else the value formatted the card's way — and, when the card asks,
// the delta against another period, coloured by whether up is good news.
// Both are computed by the server on every render and never stored.

import { useMemo, useState } from 'react';
import * as OrdFormat from '../../../../../src/app/format.ts';
import { fmtWith } from '../../../charts/format';
import { Drawer } from '../../../ui/Dialog';
import { Skeleton } from '../../../ui/Skeleton';
import { DriversView } from '../../analytics/drivers/DriversView';
import { Icon } from '../../../ui/icons/Icon';
import { AGG_LABEL, useTile, type Card, type MetricTile } from '../api';
import { useEditor } from './context';
import { useTileAsOf } from './tileAsOf';
import s from './Cards.module.css';
import { LiveRefusal } from '../../live/LiveOff';
import { liveRefusalOf } from '../../live/refusal';

/** "+18.2%" / "−4.1%" — one decimal under 10%, none above, a real minus sign (kpiPct). */
export function kpiPct(pct: number): string {
  const a = Math.abs(pct);
  return (pct > 0 ? '+' : pct < 0 ? '−' : '') + OrdFormat.formatNumber(a, { maxDecimals: a < 10 ? 1 : 0 }) + '%';
}

export function metricLabel(m: NonNullable<Card['metric']>, name?: string): string {
  return m.label || name || `${AGG_LABEL[m.aggregation] ?? m.aggregation} of ${m.column}`;
}

export function MetricBody({ card }: { card: Card }) {
  const ed = useEditor();
  const m = card.metric as NonNullable<Card['metric']>;
  const req = useMemo(
    () => ({
      kind: 'metric' as const,
      datasetId: m.datasetId,
      column: m.column,
      aggregation: m.aggregation,
      ...(m.metricId ? { metricId: m.metricId } : {}),
      ...(m.compare ? { compare: m.compare } : {}),
      filters: ed.filters,
    }),
    [m, ed.filters],
  );
  const q = useTile<MetricTile>(ed.projectId, ed.params, req);
  useTileAsOf(q.data?.ok ? q.data.asOf : undefined);
  const [why, setWhy] = useState(false);
  if (q.isPending) {
    return (
      <div className={s.metric} aria-busy="true">
        <Skeleton className={s.skValue} />
        <Skeleton className={s.skLabel} />
      </div>
    );
  }
  const t = q.data;
  // Off for a Live dataset (L2.6): the server's reason and a copy.
  const live = liveRefusalOf(q.isError ? q.error : t);
  if (live !== null) return <LiveRefusal message={live} projectId={ed.projectId} datasetId={m.datasetId} />;
  if (q.isError || !t || !t.ok) {
    return (
      <div className={s.metric}>
        <span className={s.missing}>
          <Icon name="alert" size={12} /> {q.isError ? q.error.message : t && !t.ok ? t.error : 'Source removed'}
        </span>
        {q.isError && (
          <button type="button" className={s.why} onClick={() => void q.refetch()}>
            Try again
          </button>
        )}
      </div>
    );
  }
  // Converted money (a dashboard currency, fx) reads in that currency unless the card chose a format (fxUi.ts fxOverrides).
  const money = t.fx && (!m.format || m.format === 'auto');
  const text = t.display ?? (typeof t.value === 'number' ? (money ? OrdFormat.formatMetric(t.value, { kind: 'currency', decimals: 1, compact: true }, t.fx?.target) : fmtWith(t.value, m.format || 'auto')) : '—');
  const label = metricLabel(m, t.name);
  const c = t.compare;
  let delta = null;
  if (c && c.ok) {
    if (c.reason === 'no_date_filter') {
      delta = (
        <div className={`${s.delta} ${s.hint}`} title="Previous period and last year move the date range in scope, and this card has none.">
          <Icon name="calendar" size={12} /> Add a date filter to compare
        </div>
      );
    } else if (c.delta == null) {
      delta = <div className={`${s.delta} ${s.flat}`}>No figure {c.label}</div>;
    } else {
      const up = c.delta > 0;
      const flat = c.delta === 0;
      const good = c.direction === 'down_good' ? !up : up;
      const prev = c.previousDisplay || (c.previous == null ? '—' : fmtWith(c.previous, m.format || 'auto'));
      delta = (
        <>
          <div className={`${s.delta} ${flat ? s.flat : good ? s.good : s.bad}`} title={`Was ${prev}${c.prior ? ` · ${OrdFormat.formatDateRange(c.prior.from, c.prior.to)}` : ''}`}>
            {!flat && <Icon name={up ? 'arrow-up' : 'arrow-down'} size={12} />}
            <span className={s.tnum}>{c.deltaDisplay || fmtWith(Math.abs(c.delta), m.format || 'auto')}</span>
            {typeof c.pct === 'number' && Number.isFinite(c.pct) && <span className={s.tnum}>({kpiPct(c.pct)})</span>}
          </div>
          <div className={s.vsRow}>
            <span className={s.vs} title={c.label}>
              {c.label}
            </span>
            {/* "Why?" (driversEntry.ts drvMountKpiWhy): the change broken down by what drove it, asked of the server. */}
            <button type="button" className={s.why} aria-label="Why did this change?" title="Break the change down by what drove it" onClick={() => setWhy(true)}>
              Why?
            </button>
          </div>
        </>
      );
    }
  }
  return (
    <div className={s.metric}>
      <div className={s.value}>{text}</div>
      {/* The label goes when the delta line is there and the head already says it (kpiCompare.ts). */}
      {!(delta && label === metricLabel(m)) && <div className={s.metricLabel}>{label}</div>}
      {delta}
      {t.paramErrors && t.paramErrors.length > 0 && <p className={s.paramErr}>{t.paramErrors[0]}</p>}
      {why && m.compare && (
        <Drawer open wide onOpenChange={(o) => !o && setWhy(false)} title={`Why did ${label} change?`} description="What drove the change against the comparison period">
          <DriversView
            projectId={ed.projectId}
            request={{
              datasetId: m.datasetId,
              metric: { ...(m.metricId ? { metricId: m.metricId } : {}), column: m.column, aggregation: m.aggregation, ...(m.label ? { label: m.label } : {}) },
              filters: ed.filters,
              compare: m.compare,
              path: [],
            }}
          />
        </Drawer>
      )}
    </div>
  );
}
