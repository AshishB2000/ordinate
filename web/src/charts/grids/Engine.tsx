// The cohort and event-funnel visuals (cohortRender.ts) over the server's
// `data.cohort` / `data.eventFunnel`. Every percentage, size, member total,
// average and median arrives computed; this file lays them out and formats
// them. A cohort is a heatmap <table> or the retention curve (the reply's own
// {labels, series}, drawn by <Chart>); a funnel is an ordered list of steps
// plus a breakdown <table>. Export CSV re-asks the server with the Share
// policy applied (`exportData`) and writes the full-precision figures.

import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { Chart, useDocumentTheme, type ChartHandle } from '../Chart';
import { fmtVal } from '../format';
import { getCSSVar } from '../palette';
import type { ChartDataShape } from '../types';
import { cohortMax, engDuration, engineRows, engNum, engPct, engWindow, makeRamp, shade, toCsv, type CohortGridShape, type EventFunnelShape, type Ramp } from './model';
import s from './Engine.module.css';
import { t } from './strings';

export type EngineData = ChartDataShape & { cohort?: CohortGridShape; eventFunnel?: EventFunnelShape };

interface EngineProps {
  data: EngineData;
  label: string;
  /** The same reply shaped by the project's Share policy (visual:data with share: 'export'). Absent → no Export button. */
  exportData?: () => Promise<EngineData>;
  fill?: boolean;
}

function Head({ meta, children }: { meta: string; children: ReactNode }) {
  return (
    <div className={s.head}>
      <span className={s.meta}>{meta}</span>
      <div className={s.tools}>{children}</div>
    </div>
  );
}

function ExportButton({ type, exportData }: { type: 'cohort' | 'event_funnel'; exportData: () => Promise<EngineData> }) {
  const run = async () => {
    try {
      const rows = engineRows(type, await exportData());
      if (!rows) return;
      const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = type === 'cohort' ? 'cohort-retention.csv' : 'event-funnel.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000); // after the download has read it
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not export the data.', { kind: 'error' });
    }
  };
  return (
    <Button
      size="sm"
      icon="download"
      aria-label={type === 'cohort' ? t('cohortRender.export_the_cohort_table_as_csv') : t('cohortRender.export_the_funnel_as_csv')}
      onClick={() => void run()}
    >
      {t('common.export_csv')}
    </Button>
  );
}

// ── The cohort ───────────────────────────────────────────────────────────────

export function CohortView({ data, label, exportData, fill }: EngineProps & { data: EngineData & { cohort: CohortGridShape } }) {
  const g = data.cohort;
  const [curve, setCurve] = useState(!!g.curve);
  const notes: string[] = [];
  if (g.truncated) notes.push(t('cohortRender.showing_the_latest_cohorts_and_first', { cohortsCount: g.cohorts.length, periods: g.periods, p2: g.periodNoun.toLowerCase() }));
  if (g.excluded) notes.push(t('cohortRender.without_an_entity_or_a_readable', { excluded: fmtVal(g.excluded), excluded2: g.excluded }));
  const views: Array<[string, boolean]> = [
    [t('common.table'), false],
    [t('common.retention_curve'), true],
  ];
  return (
    <div className={[s.wrap, fill && s.fill].filter(Boolean).join(' ')}>
      <Head
        meta={t('cohortRender.members_by', {
          cohortsCount: g.cohorts.length,
          members: fmtVal(g.members),
          p3: g.show === 'value' ? g.valueName : 'retention',
          p4: g.periodNoun.toLowerCase(),
        })}
      >
        <div className={s.seg} role="group" aria-label={t('cohortRender.cohort_view')}>
          {views.map(([name, isCurve]) => (
            <button key={name} type="button" className={s.segBtn} aria-pressed={curve === isCurve} onClick={() => setCurve(isCurve)}>
              {name}
            </button>
          ))}
        </div>
        {exportData && <ExportButton type="cohort" exportData={exportData} />}
      </Head>
      {notes.length > 0 && <p className={s.note}>{notes.join(' ')}</p>}
      <div className={s.body}>{curve ? <CohortCurve data={data} g={g} /> : <CohortTable g={g} label={label} />}</div>
    </div>
  );
}

function CohortTable({ g, label }: { g: CohortGridShape; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useDocumentTheme();
  const [ramp, setRamp] = useState<Ramp | null>(null);
  // The tokens as THIS host sees them (a dashboard style preset remaps them on a container).
  useLayoutEffect(() => {
    const el = host.current;
    setRamp(makeRamp(getCSSVar('--surface', el), getCSSVar('--accent', el), getCSSVar('--text', el)));
  }, [theme]);
  const max = cohortMax(g);
  const text = (v: number): string => (g.show === 'value' ? engNum(v) : engPct(v));
  return (
    <div ref={host} className={s.scroll} tabIndex={0} role="region" aria-label={t('cohortRender.cohort_table')}>
      <table className={s.table} aria-label={label}>
        <thead>
          <tr>
            <th scope="col" className={`${s.corner} ${s.label}`}>
              {t('common.cohort')}
            </th>
            <th scope="col" className={`${s.corner} ${s.size}`}>
              {t('cohortRender.members')}
            </th>
            {Array.from({ length: g.periods }, (_, k) => (
              <th key={k} scope="col">{`${g.periodNoun} ${k}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.cohorts.map((name, i) => (
            <tr key={name} className={s.row}>
              <th scope="row" className={s.label}>
                {name}
              </th>
              <td className={s.size}>{fmtVal(g.sizes[i])}</td>
              {(g.cells[i] ?? []).map((v, k) => {
                if (v == null) return <td key={k} className={`${s.cell} ${s.blank}`} />;
                const base = k === 0 && g.show !== 'value';
                return (
                  <td
                    key={k}
                    className={base ? `${s.cell} ${s.base}` : s.cell}
                    style={!base && ramp && max > 0 ? shade(v / max, ramp) : undefined}
                    title={t('cohortRender.cohort_members', { label: name, p1: fmtVal(g.sizes[i]), periodNoun: g.periodNoun, k, v: text(v) })}
                  >
                    {text(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={s.avg}>
            <th scope="row" className={s.label} title={t('cohortRender.weighted_by_cohort_size_over_the')}>
              Average
            </th>
            <td className={s.size}>{fmtVal(g.members)}</td>
            {g.average.map((v, k) => (
              <td key={k} className={s.cell}>
                {v == null ? '' : text(v)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** One line per cohort plus the average, bold, on top — the reply's {labels, series} as drawn. */
function CohortCurve({ data, g }: { data: EngineData; g: CohortGridShape }) {
  const overrides = useMemo(() => ({
    valueMode: 'off',
    showLegend: g.cohorts.length <= 12,
    noAnimate: true,
    smooth: false,
    numberFormat: g.show === 'value' ? undefined : 'plain',
    yAxisLabel: g.show === 'value' ? g.valueName : t('cohortRender.retained'),
    xAxisLabel: t('cohortRender.s_since_first_event', { periodNoun: g.periodNoun }),
  }), [g]);
  const plain = useMemo(() => ({ labels: data.labels, series: data.series }), [data]);
  const emphasise = (chart: ChartHandle | null) => {
    if (!chart || !Array.isArray(chart.data?.datasets)) return;
    const strong = getCSSVar('--text-strong', chart.canvas) || getCSSVar('--text', chart.canvas);
    for (const ds of chart.data.datasets) {
      const avg = ds.label === 'Average';
      ds.borderWidth = avg ? 3.5 : 1.25;
      ds.pointRadius = avg ? 2.5 : 0;
      ds.order = avg ? 0 : 1;
      if (avg && strong) {
        ds.borderColor = strong;
        ds.backgroundColor = strong;
      }
    }
    chart.update('none');
  };
  return (
    <div className={s.curve}>
      <Chart type="line" data={plain} overrides={overrides} label={t('cohortRender.retention_curve_cohorts_and_their', { cohortsCount: g.cohorts.length })} onChart={emphasise} />
    </div>
  );
}

// ── The event funnel ─────────────────────────────────────────────────────────

export function FunnelView({ data, exportData, fill }: EngineProps & { data: EngineData & { eventFunnel: EventFunnelShape } }) {
  const f = data.eventFunnel;
  const bd = f.breakdown;
  const bdId = useId();
  return (
    <div className={[s.wrap, fill && s.fill].filter(Boolean).join(' ')}>
      <Head meta={t('cohortRender.entered_strict_order_within_of_the', { p0: fmtVal(f.counts[0] || 0), window: engWindow(f.window) })}>
        {exportData && <ExportButton type="event_funnel" exportData={exportData} />}
      </Head>
      {f.excluded > 0 && (
        <p className={s.note}>{t('cohortRender.without_an_entity_or_a_readable_2', { excluded: fmtVal(f.excluded), excluded2: f.excluded })}</p>
      )}
      <div className={s.efScroll}>
        <ol className={s.steps}>
          {f.steps.map((step, k) => (
            <li
              key={k}
              className={s.step}
              aria-label={t('cohortRender.step_entities', {
                p0: k + 1,
                step,
                p2: f.counts[k],
                p3: k
                  ? t('cohortRender.of_the_first_step_of_the', { p0: engPct(f.pctOfFirst[k]), p1: engPct(f.pctOfPrev[k]), p2: engDuration(f.medianMs[k]) })
                  : '',
              })}
            >
              <div className={s.name}>
                <span className={s.idx}>{k + 1}</span>
                <span className={s.stepLabel}>{step}</span>
              </div>
              <div className={s.track} aria-hidden="true">
                {/* The server's % of step 1 as a width — a position, not a printed figure. */}
                <div className={s.bar} style={{ width: `${Math.max(0, Math.min(100, f.pctOfFirst[k] ?? 0))}%` }} />
              </div>
              <div className={s.figs}>
                <span className={s.count}>{fmtVal(f.counts[k])}</span>
                <span className={s.rate}>{k ? t('cohortRender.of_first', { p0: engPct(f.pctOfFirst[k]) }) : 'entered'}</span>
                {k > 0 && <span className={s.rate}>{t('cohortRender.of_previous', { p0: engPct(f.pctOfPrev[k]) })}</span>}
                {k > 0 && <span className={s.rate}>{t('cohortRender.median_after_step', { p0: engDuration(f.medianMs[k]), k })}</span>}
              </div>
            </li>
          ))}
        </ol>
        {bd && bd.groups.length > 0 && (
          <div className={s.breakdown}>
            <h4 id={bdId} className={s.bdTitle}>{t('cohortRender.by', { column: bd.column, p1: bd.truncated ? t('cohortRender.top', { groupsCount: bd.groups.length }) : '' })}</h4>
            <table className={s.bdTable} aria-labelledby={bdId}>
              <thead>
                <tr>
                  <th scope="col" className={s.bdLabel}>
                    {bd.column}
                  </th>
                  {f.steps.map((st, k) => (
                    <th key={k} scope="col">{`${k + 1}. ${st}`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bd.groups.map((grp, i) => (
                  <tr key={i}>
                    <th scope="row" className={s.bdLabel}>
                      {grp.label === '' ? '(blank)' : grp.label}
                    </th>
                    {grp.counts.map((c, k) => (
                      <td key={k}>
                        <span className={s.bdCount}>{fmtVal(c)}</span>
                        {k > 0 && <span className={s.bdPct}>{engPct(grp.pctOfFirst[k])}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
