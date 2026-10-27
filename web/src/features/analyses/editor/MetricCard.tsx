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
import { DrillPanel, type DrillTarget } from '../../visuals/drill/DrillPanel';
import { PointMenu } from '../../analytics/explain/PointMenu';
import { useEditor, type EditorApi } from './context';
import { useTileAsOf } from './tileAsOf';
import { TrendChange, TrendLine } from './KpiTrend';
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

/**
 * The rows behind a KPI's figure: the dataset under the SAME filters the card read
 * (MetricBody's). A saved metric goes by id — the server adds its own filters, or
 * says why a calculated one has no single set of rows (src/ipc/drillScope.ts).
 */
export function kpiDrillTarget(ed: Pick<EditorApi, 'projectId' | 'filters' | 'params'>, card: Card): DrillTarget | null {
  const m = card.metric;
  if (!m) return null;
  return {
    name: metricLabel(m),
    projectId: ed.projectId,
    datasetId: m.datasetId,
    encoding: { values: [{ column: m.column, aggregation: m.aggregation }] } as DrillTarget['encoding'],
    filters: ed.filters as DrillTarget['filters'],
    mark: null,
    description: 'The rows behind this figure',
    params: ed.params,
    ...(m.metricId ? { metricId: m.metricId } : {}),
  };
}

export function MetricBody({ card }: { card: Card }) {
  const ed = useEditor();
  const m = card.metric as NonNullable<Card['metric']>;
  // The sheet's Compare (view state) wins while it is on: every KPI then answers the same question.
  const sheetCompare = ed.view.compare && (ed.view.compare.mode !== 'custom' || (ed.view.compare.from && ed.view.compare.to)) ? ed.view.compare : null;
  const compare = sheetCompare ?? m.compare;
  const req = useMemo(
    () => ({
      kind: 'metric' as const,
      datasetId: m.datasetId,
      column: m.column,
      aggregation: m.aggregation,
      ...(m.metricId ? { metricId: m.metricId } : {}),
      ...(compare ? { compare } : {}),
      // A what-if is of a saved metric (the scenario's drivers aim at what the metric reads).
      ...(m.scenarioId && m.metricId ? { scenarioId: m.scenarioId } : {}),
      ...(m.trend ? { trend: true as const } : {}),
      filters: ed.filters,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the compare by value: a new object each render is the same question
    [m, ed.filters, JSON.stringify(compare)],
  );
  const q = useTile<MetricTile>(ed.projectId, ed.params, req);
  useTileAsOf(q.data?.ok ? q.data.asOf : undefined);
  const [why, setWhy] = useState(false);
  // A right-click on the figure: the rows behind it (also in the card's ⋯ menu, for a keyboard and for touch).
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [rows, setRows] = useState<DrillTarget | null>(null);
  if (q.isPending) {
    return (
      <div className={s.metric} aria-busy="true">
        <Skeleton className={s.skValue} />
      </div>
    );
  }
  const t = q.data;
  // Off for a Live dataset (L2.6): the server's reason and a copy.
  const live = liveRefusalOf(q.isError ? q.error : t);
  if (live !== null) return <LiveRefusal refusal={q.isError ? q.error : t} projectId={ed.projectId} datasetId={m.datasetId} />;
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
  // A trend's change stands in for a Compare the card does not have (KpiTrend.tsx).
  const tc = t.trend?.change;
  if (!delta && tc) delta = <TrendChange change={tc} pct={typeof tc.pct === 'number' && Number.isFinite(tc.pct) ? kpiPct(tc.pct) : ''} />;
  // A what-if card: the figure UNDER the scenario is the headline, its change on the baseline the one comparison shown.
  // The sheet's parameters reach both sides, so a driver that follows one moves with that parameter's slider.
  const sc = t.scenario;
  let figure = text;
  let whatIfNote: string | null = null;
  if (sc && sc.ok) {
    figure = sc.display || '—';
    const tone = !sc.delta || sc.tone === 'neutral' ? 'flat' : sc.tone;
    delta = (
      <>
        <div className={`${s.delta} ${s[tone]}`} title={`${sc.baselineDisplay || '—'} without the scenario`}>
          {!!sc.delta && <Icon name={sc.delta > 0 ? 'arrow-up' : 'arrow-down'} size={12} />}
          <span className={s.tnum}>{sc.delta === null ? 'No figure' : sc.delta === 0 ? 'No change' : sc.deltaDisplay}</span>
          {!!sc.delta && typeof sc.pct === 'number' && Number.isFinite(sc.pct) && <span className={s.tnum}>({kpiPct(sc.pct)})</span>}
        </div>
        <div className={s.vsRow}>
          <span className={s.vs} title={`What-if: ${sc.scenarioName}`}>
            What-if: {sc.scenarioName} · baseline {sc.baselineDisplay || '—'}
          </span>
        </div>
      </>
    );
  } else if (sc) whatIfNote = `What-if unavailable: ${sc.error}`;
  return (
    <div className={s.metric}>
      <div
        className={s.value}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
      >
        {figure}
      </div>
      <PointMenu
        key={menuAt ? `${menuAt.x}:${menuAt.y}` : ''}
        at={menuAt}
        items={[{ label: 'Show the rows', icon: 'table', onSelect: () => setRows(kpiDrillTarget(ed, card)) }]}
        label={`${label} actions`}
        onClose={() => setMenuAt(null)}
      />
      {rows && <DrillPanel target={rows} onClose={() => setRows(null)} />}
      {/* Under the figure only when it adds something — never the head's title again (as kpiSubtitle.ts on a published page). */}
      {label.trim().toLowerCase() !== metricLabel(m).trim().toLowerCase() && <div className={s.metricLabel}>{label}</div>}
      {delta}
      {t.trend && <TrendLine trend={t.trend} />}
      {whatIfNote && <p className={s.paramErr}>{whatIfNote}</p>}
      {t.paramErrors && t.paramErrors.length > 0 && <p className={s.paramErr}>{t.paramErrors[0]}</p>}
      {why && compare && (
        <Drawer open wide onOpenChange={(o) => !o && setWhy(false)} title={`Why did ${label} change?`} description="What drove the change against the comparison period">
          <DriversView
            projectId={ed.projectId}
            readOnly={ed.readOnly}
            request={{
              datasetId: m.datasetId,
              metric: { ...(m.metricId ? { metricId: m.metricId } : {}), column: m.column, aggregation: m.aggregation, ...(m.label ? { label: m.label } : {}) },
              filters: ed.filters,
              compare,
              path: [],
            }}
          />
        </Drawer>
      )}
    </div>
  );
}
