// One insight card (insights.ts insCard): a severity dot, the app-authored
// title (its detail on hover), a dismiss ×, up to three fact chips and the
// insight's own chart as a sparkline, then the surface's actions. The chips
// print `facts` as the server computed them — formatted, never derived — and
// the sparkline is the insight's own chart through `visual:data` (batched with
// the page's other cards; on Home it arrives inside home:overview), drawn as a
// bare SVG line or bars.

import { formatNumber, formatPercent } from '../../../../../src/app/format.ts';
import { useQuery } from '@tanstack/react-query';
import { loadVizData } from '../../../api/visuals';
import type { ChartDataShape } from '../../../charts/types';
import { Button, IconButton } from '../../../ui/Button';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { STALE_MS, type Insight } from './api';
import s from './Insights.module.css';

/** The facts a card has room for, in a fixed order (INS_CHIPS) — the full set is what the dock gets. */
const CHIPS: ReadonlyArray<{ key: string; label: string; pct?: boolean }> = [
  { key: 'prev', label: 'prev' },
  { key: 'now', label: 'now' },
  { key: 'change', label: 'change' },
  { key: 'pctChange', label: 'change', pct: true },
  { key: 'share', label: 'share', pct: true },
  { key: 'total', label: 'total' },
];

/** The first three numeric facts, written for reading: a ratio as a percent (a unit change), the rest grouped. */
export function chipsOf(ins: Pick<Insight, 'facts'>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const c of CHIPS) {
    const v = ins.facts?.[c.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out.push({ label: c.label, value: c.pct ? formatPercent(v, 1) : formatNumber(v) });
    if (out.length === 3) break;
  }
  return out;
}

/** A card's sparkline query — Home seeds it from its overview reply, so the card asks nothing there. */
export const sparkKey = (projectId: string, insightId: string) => ['visual:data', 'insight', projectId, insightId] as const;

const BARS = /column|bar|pareto|waterfall|histogram/;

/**
 * The SVG points of a sparkline: the first series that carries numbers, laid
 * edge to edge in a 100×32 box (the server's values, placed — never summed or
 * rounded; a missing value breaks the line). Exported for its test.
 */
export function sparkGeometry(data: Pick<ChartDataShape, 'series'> | null | undefined): { values: (number | null)[]; min: number; max: number } | null {
  const series = (data?.series ?? []).find((x) => Array.isArray(x.values) && x.values.some((v: unknown) => typeof v === 'number' && Number.isFinite(v)));
  if (!series) return null;
  const values = (series.values as unknown[]).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const nums = values.filter((v): v is number => v !== null);
  return { values, min: Math.min(...nums), max: Math.max(...nums) };
}

/** The insight's own chart at card size, as a trend line or bars — no axes, no labels: the figures are on the chips. */
function SparkSvg({ type, data, label }: { type: string; data: ChartDataShape; label: string }) {
  const g = sparkGeometry(data);
  if (!g || g.values.length < 2) return null;
  const W = 100;
  const H = 32;
  const bars = BARS.test(type);
  // A line spans its own range (the desktop's yZero: false); bars stand on zero.
  const lo = bars ? Math.min(0, g.min) : g.min;
  const hi = bars ? Math.max(0, g.max) : g.max;
  const span = hi - lo || 1;
  const y = (v: number) => H - ((v - lo) / span) * (H - 2) - 1;
  const n = g.values.length;
  if (bars) {
    const w = W / n;
    return (
      <svg className={s.spark} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {g.values.map((v, i) => (v === null ? null : <rect key={i} className={s.sparkBar} x={i * w + w * 0.15} width={w * 0.7} y={Math.min(y(v), y(0))} height={Math.max(0.5, Math.abs(y(v) - y(0)))} />))}
      </svg>
    );
  }
  const step = W / (n - 1);
  let d = '';
  g.values.forEach((v, i) => {
    if (v === null) return;
    d += `${d && g.values[i - 1] !== null ? 'L' : 'M'}${(i * step).toFixed(2)} ${y(v).toFixed(2)} `;
  });
  return (
    <svg className={s.spark} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path className={s.sparkLine} d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Spark({ projectId, ins }: { projectId: string; ins: Insight & { chart: NonNullable<Insight['chart']> } }) {
  // The page's cards go out as one visual:dataBatch (loadVizData), reused while the findings are.
  const q = useQuery({
    queryKey: sparkKey(projectId, ins.id),
    staleTime: STALE_MS,
    queryFn: async () => {
      const r = await loadVizData({ projectId, datasetId: ins.datasetId, encoding: ins.chart.encoding, filters: ins.chart.filters ?? [] });
      if (!r.ok) throw new Error(r.error);
      return r;
    },
  });
  if (q.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the trend">
        <Skeleton className={s.sparkSk} />
      </div>
    );
  }
  // Silent on failure: a card without its sparkline is still a card with a number on it.
  if (q.isError) return null;
  return <SparkSvg type={ins.chart.type || 'line'} data={q.data.data} label={`${ins.title} — trend`} />;
}

export interface CardAction {
  label: string;
  primary?: boolean;
  run: (ins: Insight) => void | Promise<void>;
}

export function InsightCard({
  projectId,
  ins,
  actions,
  onDismiss,
}: {
  projectId: string;
  ins: Insight;
  actions: CardAction[];
  onDismiss: (id: string) => Promise<void>;
}) {
  const chips = chipsOf(ins);
  return (
    <article className={s.card} data-insight-id={ins.id}>
      <header className={s.cardHead}>
        <span className={ins.severity === 'warn' ? `${s.dot} ${s.dotWarn}` : s.dot} aria-hidden="true" />
        <h3 className={s.cardTitle} title={ins.detail}>
          {ins.title}
        </h3>
        <IconButton
          icon="x"
          size="sm"
          label="Dismiss this insight"
          onClick={() => void onDismiss(ins.id).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not dismiss the insight.', { kind: 'error' }))}
        />
      </header>
      {chips.length > 0 && (
        <div className={s.chips}>
          {chips.map((c) => (
            <span key={c.label + c.value} className={s.chip}>
              <span className={s.chipK}>{c.label}</span>
              <span className={s.chipV}>{c.value}</span>
            </span>
          ))}
        </div>
      )}
      {ins.chart && <Spark projectId={projectId} ins={ins as Insight & { chart: NonNullable<Insight['chart']> }} />}
      {actions.length > 0 && (
        <div className={s.actions}>
          {actions.map((a) => (
            <Button key={a.label} size="sm" variant={a.primary ? 'primary' : 'secondary'} onClick={() => void a.run(ins)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </article>
  );
}
