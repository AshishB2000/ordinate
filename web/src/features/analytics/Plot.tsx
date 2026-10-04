// The workbenches' own plots — a scatter with its fit line, residuals against
// fitted values, a normal QQ plot, a histogram with its normal curve, the
// segments' PCA map (statsCharts.ts, segmentsView.ts). They are not one of the
// 39 chart ids <Chart> draws from `{labels, series}` — each overlays a second
// mark on its own axis — so they take a Chart.js config here, through the
// chart engine's own lazy loader and theme tokens (web/src/charts). Every
// coordinate arrives computed by the server; this maps them to marks.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getCSSVar } from '../../charts/palette';
import { loadChartJs } from '../../charts/loadChartJs';
import { SkeletonBlock } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import s from './Analytics.module.css';

export interface PlotTheme {
  c1: string;
  c2: string;
  line: string;
  muted: string;
  grid: string;
  text: string;
  font: string;
  /** --chart-1..8, for one colour per series. */
  palette: string[];
}

function themeOf(el: Element): PlotTheme {
  return {
    c1: getCSSVar('--chart-1', el) || '#2563eb',
    c2: getCSSVar('--chart-4', el) || '#6366f1',
    line: getCSSVar('--chart-6', el) || '#b45309',
    muted: getCSSVar('--muted', el) || '#6b7280',
    grid: getCSSVar('--border', el) || '#e5e7eb',
    text: getCSSVar('--text', el) || '#18181b',
    font: getCSSVar('--font-ui', el) || 'sans-serif',
    palette: Array.from({ length: 8 }, (_, i) => getCSSVar(`--chart-${i + 1}`, el) || '#2563eb'),
  };
}

/** Two linear (or category x) axes in the workbench's style. */
export function axes(th: PlotTheme, xTitle: string, yTitle: string, xLinear: boolean) {
  const axis = (title: string, linear: boolean) => ({
    type: linear ? 'linear' : 'category',
    title: { display: !!title, text: title, color: th.muted, font: { size: 11, family: th.font } },
    ticks: { color: th.muted, font: { size: 11, family: th.font }, maxTicksLimit: 8 },
    grid: { color: th.grid },
    border: { color: th.grid },
  });
  return { x: axis(xTitle, xLinear), y: axis(yTitle, true) };
}

/** The document's theme, live — a plot rebuilds its colours when it flips. */
function useTheme(): string | undefined {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme);
  useEffect(() => {
    const el = document.documentElement;
    const mo = new MutationObserver(() => setTheme(el.dataset.theme));
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

type Config = { type: string; data: unknown; options?: Record<string, unknown> };
interface Held {
  destroy(): void;
}

/**
 * A Chart.js plot. `config` is called with the theme read off this canvas and
 * must return a new config; `deps` say when to rebuild it.
 */
export function Plot({ label, config, deps }: { label: string; config: (th: PlotTheme) => Config; deps: readonly unknown[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState('');
  const theme = useTheme();
  const build = useRef(config);
  useEffect(() => {
    build.current = config;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let held: Held | null = null;
    let cancelled = false;
    const cfg = build.current(themeOf(canvas));
    loadChartJs(cfg.type)
      .then((ChartJs) => {
        if (cancelled) return;
        cfg.options = { responsive: true, maintainAspectRatio: false, animation: false, ...cfg.options };
        held = new ChartJs(canvas, cfg as never) as unknown as Held;
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFailure(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
    return () => {
      cancelled = true;
      held?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's own list
  }, [theme, ...deps]);

  return (
    <div className={s.plot}>
      <canvas ref={canvasRef} role="img" aria-label={label} />
      {status === 'loading' && (
        <div className={s.plotState}>
          <SkeletonBlock label={`Loading ${label}`} />
        </div>
      )}
      {status === 'error' && (
        <div className={s.plotState}>
          <ErrorState title="The plot could not be drawn" message={failure} compact heading={4} />
        </div>
      )}
    </div>
  );
}

/** A titled frame for a plot (statsCharts.ts swChartFrame). */
export function Figure({ title, note, tall, children }: { title: string; note?: string; tall?: boolean; children: ReactNode }) {
  return (
    <figure className={s.fig}>
      <figcaption className={s.figCap}>
        <span className={s.figTitle}>{title}</span>
        {note && <span className={s.figNote}>{note}</span>}
      </figcaption>
      <div className={tall ? `${s.figBox} ${s.figTall}` : s.figBox}>{children}</div>
    </figure>
  );
}
