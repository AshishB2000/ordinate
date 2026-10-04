// A 96×24 trend line over figures the server computed (legacy alertsInbox.ts
// aiSparkline): drawing only — the points are placed, never summed or rounded.
// Fewer than two numbers is no line, not a flat one.

const W = 96;
const H = 24;

export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const pts = values.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  // A flat series draws down the middle rather than onto the baseline.
  const span = max - min || 1;
  const step = W / (pts.length - 1);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
