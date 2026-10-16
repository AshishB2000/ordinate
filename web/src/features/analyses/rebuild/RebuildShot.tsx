// The screenshot as the model read it: each tile it found outlined where it
// sits and numbered like its card on the right. The outline's tone is the
// tile's state (ready, needs a column, dropped); pointing at either side lights
// up both. Boxes are percent of the image — geometry, never a figure — placed
// inline, as editor/Canvas.tsx places tiles.

import type { Box } from './api';
import s from './Rebuild.module.css';

export interface ShotTile {
  id: number;
  box: Box | null;
  status: 'ready' | 'unmapped' | 'dropped' | 'reading';
  title: string;
}

export function RebuildShot({ src, tiles, lit, onLight }: { src: string; tiles: ShotTile[]; lit: number | null; onLight: (id: number | null) => void }) {
  return (
    <figure className={s.shotFrame}>
      <img className={s.shotImg} src={src} alt="The dashboard screenshot" draggable={false} />
      {tiles.map((t) =>
        t.box ? (
          <span
            key={t.id}
            className={s.outline}
            data-status={t.status}
            data-lit={lit === t.id || undefined}
            style={{ left: `${t.box.x}%`, top: `${t.box.y}%`, width: `${t.box.w}%`, height: `${t.box.h}%` }}
            onPointerEnter={() => onLight(t.id)}
            onPointerLeave={() => onLight(null)}
            aria-hidden="true"
          >
            <span className={s.outlineNo}>{t.id}</span>
          </span>
        ) : null,
      )}
    </figure>
  );
}
