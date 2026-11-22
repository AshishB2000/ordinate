// A small SVG chart for an answer card (docs/embedded-assistant): bars, or lines for a line or area answer. The server computed every
// number; this only places them. Other chart types are drawn as bars (the table below has every value), which keeps this page's bundle
// small — the app's chart engine is not loaded here.

import type { Card } from './api';

const W = 600;
const H = 240;
const PAD = { l: 44, r: 12, t: 14, b: 52 };
const MAX_LABELS = 24;
const MAX_SERIES = 4;
const COLORS = ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)'];

/** Display only: a number as a short label (the digits are the server's). */
export const show = (n: number): string => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(n);

export function MiniChart({ card }: { card: Card }) {
  const labels = card.data.labels.slice(0, MAX_LABELS);
  const series = card.data.series.filter((s) => s.role !== 'overlay').slice(0, MAX_SERIES);
  if (!labels.length || !series.length) return null;
  const vals = series.flatMap((s) => s.values.slice(0, labels.length).filter((v): v is number => typeof v === 'number'));
  if (!vals.length) return null;
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  const span = hi - lo || 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const y = (v: number): number => PAD.t + ih * (1 - (v - lo) / span);
  const zero = y(0);
  const step = iw / labels.length;
  const line = card.chartType === 'line' || card.chartType === 'area';
  const cut = card.data.labels.length - labels.length;
  const x = (i: number): number => PAD.l + step * (i + 0.5);
  const bw = Math.max(2, Math.min(40, (step * 0.7) / series.length));
  const every = Math.ceil(labels.length / 8);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${card.title}. ${card.caption}`} preserveAspectRatio="xMidYMid meet">
        <line x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} className="axis" />
        <text x={PAD.l - 6} y={y(hi) + 4} textAnchor="end" className="tick">{show(hi)}</text>
        {lo < 0 && <text x={PAD.l - 6} y={y(lo)} textAnchor="end" className="tick">{show(lo)}</text>}
        {line
          ? series.map((s, k) => (
              <polyline key={s.name} className="series" stroke={COLORS[k]} fill="none" points={s.values.slice(0, labels.length).flatMap((v, i) => (typeof v === 'number' ? [`${x(i)},${y(v)}`] : [])).join(' ')} />
            ))
          : series.map((s, k) =>
              s.values.slice(0, labels.length).map((v, i) =>
                typeof v === 'number' ? (
                  <rect key={`${s.name}-${i}`} x={x(i) - (bw * series.length) / 2 + bw * k} y={Math.min(y(v), zero)} width={bw} height={Math.max(1, Math.abs(zero - y(v)))} fill={COLORS[k]} rx={2}>
                    <title>{`${labels[i]} · ${s.name}: ${v}`}</title>
                  </rect>
                ) : null,
              ),
            )}
        {labels.map((l, i) => (i % every === 0 ? <text key={i} x={x(i)} y={H - PAD.b + 16} textAnchor="middle" className="tick">{String(l).slice(0, 14)}</text> : null))}
      </svg>
      {series.length > 1 && (
        <figcaption className="legend">
          {series.map((s, k) => (
            <span key={s.name}><i style={{ background: COLORS[k] }} />{s.name}</span>
          ))}
        </figcaption>
      )}
      {cut > 0 && <p className="cut">{`${cut} more in the table.`}</p>}
    </figure>
  );
}

/** Every value of the card, as a table: the accessible twin of the chart. */
export function CardTable({ card }: { card: Card }) {
  const series = card.data.series.filter((s) => s.role !== 'overlay');
  return (
    <table className="grid">
      <thead>
        <tr><th scope="col" /> {series.map((s) => <th key={s.name} scope="col">{s.name}</th>)}</tr>
      </thead>
      <tbody>
        {card.data.labels.map((l, i) => (
          <tr key={i}>
            <th scope="row">{String(l)}</th>
            {series.map((s) => <td key={s.name}>{typeof s.values[i] === 'number' ? (s.values[i] as number).toLocaleString() : ''}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
