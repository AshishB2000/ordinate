// <Chart> — the one component that owns a Chart.js instance (or a word cloud,
// which stands in for one). Created on mount, updated in place when the data,
// the overrides or the theme change, destroyed on unmount. The config comes
// from buildChart (pure); this file is lifecycle only and computes nothing.
//
// Sizing: the parent decides the box; the chart fills it. Chart.js's own
// `responsive` mode already observes that box; the ResizeObserver here is for
// the word cloud, which is not Chart.js, and keeps any held chart in step.

import { useEffect, useRef, useState } from 'react';
import { SkeletonBlock } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/States';
import { buildChart } from './build';
import s from './Chart.module.css';
import { loadChartJs } from './loadChartJs';
import { resolveChartType } from './typeSpec';
import type { ChartDataShape, Cx, Overrides } from './types';
import { buildWordCloud } from './wordCloud';

/** What <Chart> holds: a Chart.js instance, or the word cloud's look-alike. */
export interface ChartHandle {
  canvas: HTMLCanvasElement;
  config: { type: string; plugins?: Cx[] };
  data: Cx;
  options: Cx;
  update(mode?: string): void;
  resize(): void;
  destroy(): void;
}

type Status = 'loading' | 'ready' | 'empty' | 'error';

/** The document's effective theme (<html data-theme>), live — chart colours are read from it at build time. */
export function useDocumentTheme(): string | undefined {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme);
  useEffect(() => {
    const el = document.documentElement;
    const mo = new MutationObserver(() => setTheme(el.dataset.theme));
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/**
 * Swap a live Chart.js chart onto a new config of the SAME Chart.js type and
 * animate to it. Inline plugins close over the data they label, so they are
 * replaced too; the two that hold DOM listeners (annotations, events) attach
 * in afterInit and detach in afterDestroy, which Chart.js only calls at create
 * and destroy — so they are called here for the plugins going and coming.
 */
function updateInPlace(chart: ChartHandle, config: { data: Cx; options: Cx; plugins: Cx[] }): void {
  const plugins: Cx[] = chart.config.plugins ?? [];
  for (const p of plugins) p.afterDestroy?.(chart);
  plugins.splice(0, plugins.length, ...config.plugins);
  chart.data = config.data;
  chart.options = config.options;
  chart.update();
  for (const p of config.plugins) p.afterInit?.(chart);
}

export function Chart({
  type,
  data,
  overrides,
  label,
  className,
  onChart,
}: {
  /** An Ordinate chart id (vizLabels.ts). */
  type: string;
  /** The server's `{labels, series}` (visual:data). */
  data: ChartDataShape;
  overrides?: Overrides;
  /** The canvas' accessible name. */
  label?: string;
  className?: string;
  /** The live instance, for an export or a drill-through; null when there is none. */
  onChart?: (chart: ChartHandle | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const held = useRef<ChartHandle | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [failure, setFailure] = useState('');
  const theme = useDocumentTheme();
  const onChartRef = useRef(onChart);
  useEffect(() => {
    onChartRef.current = onChart;
  });

  // Create / update. A newer render cancels an older one still loading Chart.js.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const release = () => {
      held.current?.destroy();
      held.current = null;
    };
    const spec = resolveChartType(type);
    const ready = spec.isWordCloud ? Promise.resolve(null) : loadChartJs(spec.chartType);
    ready
      .then((ChartJs) => {
        if (cancelled) return;
        const built = buildChart(canvas, data, type, overrides);
        if (!built) {
          release();
          setStatus('empty');
        } else if (built.kind === 'wordCloud') {
          release();
          held.current = buildWordCloud(canvas, built.labels, built.series, built.overrides, built.theme) as ChartHandle;
          setStatus('ready');
        } else if (held.current && held.current.config.type === built.config.type) {
          updateInPlace(held.current, built.config);
          setStatus('ready');
        } else {
          release();
          held.current = new ChartJs!(canvas, built.config as never) as unknown as ChartHandle;
          setStatus('ready');
        }
        onChartRef.current?.(held.current);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        release();
        setFailure(err instanceof Error ? err.message : String(err));
        setStatus('error');
        onChartRef.current?.(null);
      });
    return () => {
      cancelled = true;
    };
  }, [type, data, overrides, theme]);

  // Destroy on unmount; keep a held chart sized to its box.
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ro = host ? new ResizeObserver(() => held.current?.resize()) : null;
    if (host) ro?.observe(host);
    return () => {
      ro?.disconnect();
      held.current?.destroy();
      held.current = null;
      onChartRef.current?.(null);
    };
  }, []);

  return (
    <div className={[s.wrap, s.fresh, className].filter(Boolean).join(' ')}>
      {/* Hidden under the empty / error states (a destroyed word cloud leaves its words); blank while loading anyway. */}
      <canvas ref={canvasRef} role="img" aria-label={label ?? 'Chart'} className={status === 'empty' || status === 'error' ? s.hidden : undefined} />
      {status === 'loading' && (
        <div className={s.state}>
          <SkeletonBlock label="Loading chart" />
        </div>
      )}
      {status === 'empty' && (
        <div className={s.state}>
          <EmptyState icon="chart-bar" title="Nothing to draw" compact heading={3}>
            Couldn&apos;t draw a chart from this data.
          </EmptyState>
        </div>
      )}
      {status === 'error' && (
        <div className={s.state}>
          <ErrorState title="The chart could not be drawn" message={failure} compact heading={3} />
        </div>
      )}
    </div>
  );
}
