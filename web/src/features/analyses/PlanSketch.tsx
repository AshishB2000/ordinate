// A drafted sheet's ARRANGEMENT, as a sketch: one plain box per tile on the
// 12-column grid the editor uses, placed from the `layout` the server computed
// (planPreview.ts — the same arrangeSheet the build places the cards with, so
// the sketch is the page). It shows WHERE things go and nothing else: no name,
// no figure. Grid placement is inline, as in editor/Canvas.tsx.

import type { PlanPreview } from './api';
import s from './Draft.module.css';

type Tile = NonNullable<PlanPreview['sheets'][number]['layout']>[number];

/** Chart, KPI, note — the order the words and the key name them in. */
const KINDS = ['visual', 'metric', 'text'] as const;
const NOUN: Record<Tile['kind'], [one: string, many: string]> = { visual: ['chart', 'charts'], metric: ['KPI', 'KPIs'], text: ['note', 'notes'] };

/** "2 charts" — or nothing, when there is none of that kind. */
function count(tiles: Tile[], kind: Tile['kind']): string {
  const n = tiles.filter((t) => t.kind === kind).length;
  return n ? `${n} ${NOUN[kind][n === 1 ? 0 : 1]}` : '';
}

/** The tiles that sit side by side. The layout arrives top to bottom, so a band
 *  ends at the first tile that starts at or below its foot. */
function bands(layout: Tile[]): Tile[][] {
  const out: Tile[][] = [];
  let foot = 0;
  for (const t of layout) {
    if (!out.length || t.y >= foot) out.push([]);
    out[out.length - 1].push(t);
    foot = Math.max(foot, t.y + t.h);
  }
  return out;
}

export function PlanSketch({ layout }: { layout?: Tile[] }) {
  if (!layout?.length) return null; // an older reply carries no layout
  // The picture, in words: what a reader who cannot see it is given instead.
  const words = bands(layout)
    .map((band) => KINDS.map((k) => count(band, k)).filter(Boolean).join(' beside '))
    .join('; then ');
  return (
    <div className={s.sketchRow}>
      <div className={s.sketch} role="img" aria-label={`Layout, top to bottom: ${words}`}>
        {layout.map((t, i) => (
          <span key={i} className={`${s.tile} ${s[`tile_${t.kind}`]}`} style={{ gridColumn: `${t.x + 1} / span ${t.w}`, gridRow: `${t.y + 1} / span ${t.h}` }} />
        ))}
      </div>
      {/* The key says which box is which; the image's label already counts them. */}
      <div className={s.sketchKey} aria-hidden="true">
        <span className={s.interpH}>Layout</span>
        <ul className={s.legend}>
          {KINDS.filter((k) => count(layout, k)).map((k) => (
            <li key={k} className={s.key}>
              <span className={`${s.tile} ${s[`tile_${k}`]}`} />
              {count(layout, k)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
