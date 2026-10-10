// The live pictures on Home's "Jump back in" cards — a lazy chunk, so Home
// paints its cards (glyph tiles) before any chart code loads. A saved visual
// draws the Visuals gallery's own thumbnail (`visual:thumbs`); a dashboard
// draws its first sheet's first two visuals, as its card on Analyses does
// (`analysis:gallery`). Every figure is the server's; any failure leaves the
// card's glyph.

import { useEffect } from 'react';
import type { RecentItem } from '../../api/home';
import { useGallery } from '../analyses/api';
import { VisualTileBody } from '../analyses/VisualTile';
import { Thumb } from '../visuals/Thumb';
import s from './JumpBackIn.module.css';

const NONE: never[] = [];

function DashboardThumb({ it, onDrawn }: { it: RecentItem; onDrawn: () => void }) {
  const q = useGallery(it.projectId);
  const previews = (Array.isArray(q.data) ? q.data : []).find((g) => g.id === it.id)?.previews ?? [];
  const any = previews.length > 0;
  useEffect(() => {
    if (any) onDrawn();
  }, [any, onDrawn]);
  if (!any) return null;
  return (
    <span className={previews.length > 1 ? `${s.dash} ${s.dash2}` : s.dash}>
      {previews.map((v) => (
        <span key={v.id} className={s.dashCell}>
          <VisualTileBody projectId={it.projectId} def={v} filters={NONE} params={NONE} thumb />
        </span>
      ))}
    </span>
  );
}

export default function HomeThumb({ it, onDrawn }: { it: RecentItem; onDrawn: () => void }) {
  if (it.type === 'analysis') return <DashboardThumb it={it} onDrawn={onDrawn} />;
  if (it.type !== 'visual') return null;
  // The gallery's thumbnail reads the id, the chart type and (as its cache key) the time; the rest is the summary's shape.
  const v = { id: it.id, name: it.name, chartType: it.meta?.chartType ?? '', updatedAt: it.updatedAt, datasetId: '', favorite: false };
  return <Thumb projectId={it.projectId} v={v} visible onDrawn={onDrawn} />;
}
