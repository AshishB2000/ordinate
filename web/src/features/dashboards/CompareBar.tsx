// COMPARE — the whole sheet against another period (view state, never saved;
// useViewer.ts). Two pieces:
//
//   CompareControl   in the head's view controls: off, the previous period, the
//                    same period last year, or two dates. The period being
//                    compared is the sheet's own date filter or control — the
//                    server moves that range, exactly as a KPI card's Compare.
//   CompareSummary   above the sheet while it is on: what changed, one line per
//                    KPI — the key-drivers caption the server writes ("Revenue
//                    rose $412K; West explains 61%, led by California").
//
// Every figure and every sentence here is the server's: the KPI cards ask for
// their own delta, a bar chart for its second series, and these lines are
// `drivers:explain` — the question a KPI's "Why?" asks, so the two share one
// answer. Nothing is summed, subtracted or worded in the browser.

import { useQueries } from '@tanstack/react-query';
import { skipToken } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import type { Card } from '../analyses/api';
import type { EditorApi } from '../analyses/editor/context';
import { metricLabel } from '../analyses/editor/MetricCard';
import { call, driversKey, type DriversRequest, type DriversResult } from '../analytics/api';
import type { Compare } from './useViewer';
import s from './Dashboards.module.css';

const MODES: { value: Compare['mode']; label: string }[] = [
  { value: 'previous_period', label: 'vs previous period' },
  { value: 'previous_year', label: 'vs same period last year' },
  { value: 'custom', label: 'vs custom dates…' },
];
/** Lines in the summary: enough to read at a glance; every KPI still has its own "Why?". */
export const SUMMARY_KPIS = 3;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** A custom comparison is asked only once it has both dates (the server needs both). */
export const usable = (c: Compare | null): Compare | null => (c && (c.mode !== 'custom' || (ISO.test(c.from ?? '') && ISO.test(c.to ?? ''))) ? c : null);

export function CompareControl({ value, onChange }: { value: Compare | null; onChange: (c: Compare | null) => void }) {
  return (
    <>
      <Select
        size="sm"
        aria-label="Compare this dashboard with"
        className={value ? s.asOfOn : undefined}
        value={value?.mode ?? ''}
        onValueChange={(mode) => onChange(mode ? { mode: mode as Compare['mode'] } : null)}
        options={[{ value: '', label: 'Compare: off' }, ...MODES]}
      />
      {value?.mode === 'custom' && (
        <>
          <Input size="sm" type="date" aria-label="Compare from" value={value.from ?? ''} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          <Input size="sm" type="date" aria-label="Compare to" value={value.to ?? ''} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} />
        </>
      )}
    </>
  );
}

/** The drivers question one KPI card asks under the sheet's Compare — the same one its "Why?" asks. */
export function changeRequest(card: Card, filters: EditorApi['filters'], compare: Compare): DriversRequest | null {
  const m = card.type === 'metric' ? card.metric : undefined;
  if (!m) return null;
  return {
    datasetId: m.datasetId,
    metric: { ...(m.metricId ? { metricId: m.metricId } : {}), column: m.column, aggregation: m.aggregation, ...(m.label ? { label: m.label } : {}) },
    filters,
    compare,
    path: [],
  };
}

export function CompareSummary({ ed }: { ed: EditorApi }) {
  const compare = usable(ed.view.compare);
  const kpis = compare ? ed.cards.filter((c) => c.type === 'metric' && c.metric).slice(0, SUMMARY_KPIS) : [];
  const answers = useQueries({
    queries: kpis.map((card) => {
      const request = compare ? changeRequest(card, ed.filters, compare) : null;
      return {
        queryKey: driversKey(ed.projectId, request),
        queryFn: request ? () => call<DriversResult>(rpc('drivers:explain', { projectId: ed.projectId, request }), 'Could not explain the change.') : skipToken,
        staleTime: Infinity,
        retry: false,
      };
    }),
  });
  if (!ed.view.compare) return null;
  const mode = MODES.find((m) => m.value === ed.view.compare?.mode)?.label ?? '';
  const refused = answers.map((a) => (a.data && !a.data.ok ? a.data.error : a.isError ? a.error.message : null));
  // One reason for every line (no date in scope to move) is said once, not three times.
  const shared = refused.length > 0 && refused.every((r) => r !== null && r === refused[0]) ? refused[0] : null;
  return (
    <section className={s.cmpStrip} aria-label="What changed">
      <span className={s.selLabel}>What changed · {mode}</span>
      {!compare ? (
        <p className={s.cmpNote}>Pick both dates to compare with.</p>
      ) : !kpis.length ? (
        <p className={s.cmpNote}>The bar charts on this sheet show the comparison period beside each bar. Add a KPI to see what changed in a sentence.</p>
      ) : shared ? (
        <p className={s.cmpNote}>{shared}</p>
      ) : (
        <ul className={s.cmpList}>
          {kpis.map((card, i) => {
            const a = answers[i];
            const r = a.data;
            return (
              <li key={card.id} aria-busy={a.isPending || undefined}>
                {a.isPending ? (
                  <Skeleton className={s.cmpSk} />
                ) : r && r.ok ? (
                  // The caption names what drove the change; with nothing to break it down by, the headline still says how much.
                  <span>{r.caption || `${r.headline}.`}</span>
                ) : (
                  <span className={s.cmpNote}>
                    {metricLabel(card.metric as NonNullable<Card['metric']>)}: {refused[i] ?? 'Could not explain the change.'}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
