// A dashboard card's picture (anList.ts): its first sheet's first one or two visuals, drawn by the shared chart engine
// from the server's figures (batched through `analysis:tiles`), or the section's bar motif when it has none. The
// Analyses gallery and the Dashboards page draw the same one.

import type { GalleryItem } from './api';
import { VisualTileBody } from './VisualTile';
import s from './Analyses.module.css';

const NO_FILTERS: never[] = [];
const NO_PARAMS: never[] = [];

export function GalleryPreview({ projectId, item }: { projectId: string; item: GalleryItem }) {
  if (!item.previews.length) {
    // A first sheet with no visual cards gets the section's own bar motif.
    return (
      <span className={`${s.prev} ${s.prevNone}`} aria-hidden="true">
        <span className={s.bars}>
          <span className={s.bar2} />
          <span className={s.bar4} />
          <span className={s.bar3} />
        </span>
      </span>
    );
  }
  return (
    <span className={item.previews.length > 1 ? `${s.prev} ${s.prev2}` : s.prev} aria-hidden="true">
      {item.previews.map((v) => (
        <span key={v.id} className={s.thumb}>
          <VisualTileBody projectId={projectId} def={v} filters={NO_FILTERS} params={NO_PARAMS} thumb />
        </span>
      ))}
    </span>
  );
}
