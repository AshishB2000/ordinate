// The sheet's TAKEAWAY: one sentence under the dashboard's title, as the
// published page carries it — the app's caption (src/analysis/captions.ts) of
// the sheet's lead chart, the first visual card in reading order, under the
// sheet's filters (`analysis:takeaway`). The server wrote every word and figure;
// this picks the lead card and sets the figures in bold.

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import type { Card } from '../api';
import { useEditor } from './context';
import s from './Canvas.module.css';

/** The lead chart: the first visual card in reading order, top to bottom then left to right, not inside a group. */
export function leadVisual(cards: readonly Card[]): string | undefined {
  const charts = cards.filter((c) => c.type === 'visual' && c.visualId && !c.parentId);
  charts.sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  return charts[0]?.visualId;
}

/** A figure inside the sentence: "38.9M", "1.3×", "−4.2%". */
const FIGURE = /([−+-]?\d[\d.,]*(?:\s?[%×KMBT])?)/;

/** The sentence with its figures in bold — the split keeps every character, so the words are the server's. */
export function Emphasised({ text }: { text: string }) {
  return <>{text.split(FIGURE).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}</>;
}

export function Takeaway() {
  const ed = useEditor();
  const visualId = leadVisual(ed.cards);
  const q = useQuery({
    queryKey: ['analysis:takeaway', ed.projectId, visualId, ed.filters, ed.params],
    enabled: !!visualId,
    queryFn: async () => (await rpc('analysis:takeaway', { projectId: ed.projectId, visualId: visualId as string, filters: ed.filters, params: ed.params })) as { ok: boolean; text?: string },
  });
  const text = q.data?.ok ? q.data.text : '';
  if (!visualId || !text) return null;
  return (
    <p className={s.takeaway} data-testid="takeaway">
      <Emphasised text={text} />
    </p>
  );
}
