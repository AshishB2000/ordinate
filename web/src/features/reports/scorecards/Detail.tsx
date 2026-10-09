// A scorecard row's DETAIL (scorecardDetail.ts): the metric over its last 24
// periods as a large line with its target and a forecast drawn as Analytics
// overlays, and the chosen period broken out by the dataset's top dimension.
// Every figure — history, target line, forecast and its interval, breakdown,
// attainment — comes from `scorecard:detail`; the charts are the shared engine.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Chart } from '../../../charts/Chart';
import type { ChartDataShape } from '../../../charts/types';
import { IconButton } from '../../../ui/Button';
import { SkeletonBlock, SkeletonRows } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import type { ScoreDetail } from '../api';
import { LiveRefusal } from '../../live/LiveOff';
import { liveRefusalOf, replyError } from '../../live/refusal';
import { Dot } from './Dot';
import s from './Scorecard.module.css';

const LINE = { showLegend: false, valueMode: 'off' };
const BARS = { showLegend: false, valueMode: 'all' };

export function Detail({ projectId, scorecardId, metricId, offset, onClose }: { projectId: string; scorecardId: string; metricId: string; offset: number; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['scorecard:detail', projectId, scorecardId, metricId, offset],
    queryFn: async () => {
      const r = (await rpc('scorecard:detail', { projectId, id: scorecardId, metricId, offset })) as ScoreDetail | { ok: false; error: string };
      // A metric over a Live dataset (L2.6): its history reads rows — the server's typed refusal keeps its code.
      if (!r.ok) throw replyError(r, 'Could not load this metric.');
      return r;
    },
  });
  const d = q.data;
  const bars = useMemo<ChartDataShape | null>(
    () => (d?.breakdown?.labels.length ? { labels: d.breakdown.labels, series: [{ name: d.metric.name, values: d.breakdown.values }] } : null),
    [d],
  );
  const forecast = d?.series.analytics?.find((o) => o.kind === 'forecast');
  return (
    <aside className={s.detail} aria-label="Metric detail">
      <div className={s.detailHead}>
        <h2 className={s.detailTitle}>
          {d && <Dot status={d.status} />}
          {d ? d.metric.name : 'Metric'}
        </h2>
        <IconButton icon="x" label="Close the detail" onClick={onClose} />
      </div>
      {q.isPending ? (
        <div className={s.detailBody}>
          <SkeletonRows rows={2} label="Loading the metric" />
          <div className={s.detailChart}>
            <SkeletonBlock label="Loading the history" />
          </div>
        </div>
      ) : q.isError && liveRefusalOf(q.error) !== null ? (
        <LiveRefusal message={liveRefusalOf(q.error) ?? ''} projectId={projectId} />
      ) : q.isError ? (
        <ErrorState compact heading={3} title="Could not load this metric" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <div className={s.detailBody}>
          <div className={s.figs}>
            <div className={`${s.fig} ${s.figLead}`}>
              <span className={s.figLabel}>{q.data.window ? q.data.window.label : 'Value'}</span>
              <span className={s.figValue}>{q.data.display || '—'}</span>
            </div>
            <div className={s.fig}>
              <span className={s.figLabel}>Target</span>
              <span className={s.figValue}>{q.data.targetDisplay || 'None set'}</span>
            </div>
            <div className={s.fig}>
              <span className={s.figLabel}>Attainment</span>
              <span className={s.figValue}>{q.data.attainmentDisplay || '—'}</span>
            </div>
            <div className={`${s.fig} ${s[`fig_${q.data.status}`]}`}>
              <span className={s.figLabel}>Status</span>
              <span className={s.figValue}>{q.data.statusWord ? q.data.statusWord.charAt(0).toUpperCase() + q.data.statusWord.slice(1) : '—'}</span>
            </div>
          </div>
          <p className={s.def}>{q.data.metric.definitionText}</p>
          <div className={s.sub}>{q.data.dateColumn ? `Last ${(q.data.series.labels ?? []).length} periods, by ${q.data.dateColumn}` : 'No date column — no history to draw.'}</div>
          {(q.data.series.labels ?? []).length > 0 && (
            <div className={s.detailChart}>
              <Chart type="line" data={q.data.series} overrides={LINE} label={`${q.data.metric.name} over time, with its target and forecast`} />
            </div>
          )}
          {forecast?.text && (
            <p className={s.forecast}>
              Forecast: {forecast.text}
              {forecast.forecast?.season ? ` · season of ${forecast.forecast.season} detected` : ''}
            </p>
          )}
          {bars && q.data.breakdown && (
            <>
              <div className={s.sub}>
                {q.data.window ? q.data.window.label : 'This period'} by {q.data.breakdown.dimension}
              </div>
              <div className={s.detailBars} style={{ height: Math.max(120, Math.min(360, 28 * (bars.labels ?? []).length + 40)) }}>
                <Chart type="bar" data={bars} overrides={BARS} label={`${q.data.metric.name} by ${q.data.breakdown.dimension}`} />
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
