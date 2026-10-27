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

/**
 * A figure inside the sentence — "$2.1M", "2,612", "83%", "1.3×", "−4.1%": a number with a currency, a separator
 * or a unit; never a bare year ("Jan 2024") or a digit inside a word. The published page's own rule
 * (src/publish/site/publishWords.ts PK_FIGURE), so the two headers bold the same figures.
 */
const FIGURE = /(?<![\p{L}\p{N}_.,])[−+-]?(?:[$€£¥]\d+(?:[.,]\d+)*(?:[KMBT](?!\p{L})|%|×)?|\d+(?:[.,]\d+)+(?:[KMBT](?!\p{L})|%|×)?|\d+(?:[KMBT](?!\p{L})|%|×))/gu;

/** The sentence with its figures in bold — every character kept, so the words are the server's. */
export function Emphasised({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(FIGURE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<strong key={m.index}>{m[0]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
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
