// The live pictures on Home's "Jump back in" cards — a lazy chunk, so Home
// paints its cards (glyph tiles) before any chart code loads. A saved visual
// draws the Visuals gallery's own thumbnail; a dashboard draws its first two
// visual cards the same way, from the ids `recent:list` carries for it. So
// every picture on the page rides ONE batched `visual:thumbs` call. Every
// figure is the server's; any failure leaves the card's glyph. Drawn
// `accentOnly`: Home's pictures are silhouettes in the member's accent, so the
// page never clashes with the canvas or highlight they picked — the visuals keep
// their own colours everywhere else.

import type { RecentItem } from '../../api/home';
import { useThumb, type VisualSummary } from '../visuals/api';
import { NO_THUMB, Thumb } from '../visuals/Thumb';
import s from './JumpBackIn.module.css';

/** What the gallery's thumbnail reads of a summary: the id, the chart type and (its cache key) a time. */
const summary = (it: RecentItem, id: string, chartType: string): VisualSummary => ({ id, name: it.name, chartType, updatedAt: it.updatedAt, datasetId: '', favorite: false });

/** One of a dashboard's visuals. No cell until there is a picture for it: a hole, a table or a failure draws nothing. */
function DashCell({ it, id, onDrawn }: { it: RecentItem; id: string; onDrawn: () => void }) {
  const v = summary(it, id, '');
  const t = useThumb(it.projectId, v, true).data; // the same cached answer Thumb reads below
  if (!t || !t.ok || !t.data || NO_THUMB.has(t.chartType)) return null;
  return (
    <span className={s.dashCell}>
      <Thumb projectId={it.projectId} v={v} visible onDrawn={onDrawn} accentOnly />
    </span>
  );
}

export default function HomeThumb({ it, onDrawn }: { it: RecentItem; onDrawn: () => void }) {
  if (it.type === 'visual') return <Thumb projectId={it.projectId} v={summary(it, it.id, it.meta?.chartType ?? '')} visible onDrawn={onDrawn} accentOnly />;
  const ids = it.type === 'analysis' ? (it.meta?.previewIds ?? []) : [];
  if (!ids.length) return null;
  return (
    <span className={s.dash}>
      {ids.map((id, i) => (
        // A sheet may show one visual twice, so the id alone is not a key.
        <DashCell key={`${i}:${id}`} it={it} id={id} onDrawn={onDrawn} />
      ))}
    </span>
  );
}
