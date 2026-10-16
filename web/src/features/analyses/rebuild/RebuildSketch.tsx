// The dashboard that will be built, as a sketch: the 12-column grid the server
// arranged (planLayout.arrangeSheet, the same placement the build makes), each
// tile numbered like the outline on the screenshot and its card. A KPI is the
// solid block, a chart the outlined one, a note the dashed one — PlanSketch's
// language, at the width of the panel.

import type { MatchReply } from './api';
import s from './Rebuild.module.css';

type Layout = Extract<MatchReply, { ok: true }>['layout'];

export function RebuildSketch({ layout, lit, onLight }: { layout: Layout; lit: number | null; onLight: (id: number | null) => void }) {
  if (!layout.length) {
    return <p className={s.sketchEmpty}>Nothing is ready to build yet. Map or fix a tile below and it appears here.</p>;
  }
  const kpis = layout.filter((t) => t.kind === 'metric').length;
  const charts = layout.filter((t) => t.kind === 'visual').length;
  const notes = layout.length - kpis - charts;
  const words = [kpis && `${kpis} KPI${kpis === 1 ? '' : 's'}`, charts && `${charts} chart${charts === 1 ? '' : 's'}`, notes && `${notes} note${notes === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(', ');
  return (
    <div className={s.sketch} role="img" aria-label={`The dashboard that will be built: ${words}`}>
      {layout.map((t, i) => (
        <span
          key={i}
          className={s.sketchTile}
          data-kind={t.kind}
          data-lit={t.tileId !== null && lit === t.tileId ? '' : undefined}
          style={{ gridColumn: `${t.x + 1} / span ${t.w}`, gridRow: `${t.y + 1} / span ${t.h}` }}
          onPointerEnter={() => onLight(t.tileId)}
          onPointerLeave={() => onLight(null)}
        >
          {t.tileId !== null && <span className={s.sketchNo}>{t.tileId}</span>}
        </span>
      ))}
    </div>
  );
}
