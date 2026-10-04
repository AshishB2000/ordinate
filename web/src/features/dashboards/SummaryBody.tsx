// The Summary card (legacy summaryCard.ts): three to five sentences about the
// dashboard's OWN tiles under the reader's filters, parameters and As of —
// every one composed by the server (summary:compute) from figures it computed.
// A sentence about a tile jumps to it. "Rewrite" asks a model to narrate the
// same facts; the server refuses a rewrite that cites a figure it did not
// compute, and the card keeps its sentences.

import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon, type IconName } from '../../ui/icons/Icon';
import type { EditorApi } from '../analyses/editor/context';
import { reason, useSummary, type SummarySentence } from './api';
import s from './Dashboards.module.css';

const KIND_ICON: Record<SummarySentence['kind'], IconName> = { kpi: 'trending-up', driver: 'activity', insight: 'sparkles', quality: 'circle-check', alert: 'bell' };
const KIND_WORD: Record<SummarySentence['kind'], string> = { kpi: 'KPI', driver: 'driver', insight: 'insight', quality: 'quality', alert: 'alert' };

/** Show a card: its sheet, scrolled into view, pulsed for a moment (sumJump). */
export function jumpToCard(ed: EditorApi, cardId: string): void {
  const i = ed.doc.sheets.findIndex((p) => p.cards.some((c) => c.id === cardId));
  if (i >= 0 && i !== ed.sheet) ed.setSheet(i);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add(s.pulse);
      setTimeout(() => el.classList.remove(s.pulse), 1600);
    }),
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function SummaryBody({ ed, cardId }: { ed: EditorApi; cardId: string }) {
  const req = {
    projectId: ed.projectId,
    analysisId: ed.analysisId,
    name: ed.doc.name,
    pages: ed.doc.sheets,
    filters: ed.filters,
    params: ed.params,
    asOf: ed.view.asOf,
  };
  const q = useSummary(req);
  // Prose is kept while the sentences it narrates are the same (summaryCard.ts sumProse).
  const [prose, setProse] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isPending) return <SkeletonRows rows={4} label="Summarising this dashboard" />;
  if (q.isError) return <ErrorState compact heading={3} title="Could not summarise this dashboard" message={q.error.message} onRetry={() => void q.refetch()} />;
  const { sentences, computedAt, canRewrite, rewriteReason } = q.data;
  if (!sentences.length) {
    return (
      <EmptyState compact heading={3} icon="file-text" title="Nothing to summarise yet">
        Add a KPI card or a chart, and this card says what they show.
      </EmptyState>
    );
  }
  const key = sentences.map((x) => x.text).join('\n');
  const shown = prose && prose.key === key ? prose.text : null;
  const rewrite = async () => {
    setBusy(true);
    try {
      const r = (await rpc('summary:rewrite', req)) as { ok: boolean; text?: string; error?: string };
      if (r.ok && r.text) setProse({ key, text: r.text });
      else toast(reason(r, 'Could not rewrite the summary.'), { kind: 'error' });
    } catch (err) {
      toast(reason(err, 'Could not rewrite the summary.'), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.summary} data-summary={cardId}>
      {shown ? (
        <p className={s.prose}>{shown}</p>
      ) : (
        <ol className={s.sentences}>
          {sentences.map((x, i) => (
            <li key={i} className={`${s.sentence} ${x.tone === 'bad' ? s.bad : x.tone === 'good' ? s.good : ''}`}>
              <Icon name={x.kind === 'kpi' && x.tone === 'bad' ? 'arrow-down' : KIND_ICON[x.kind]} size={12} />
              {x.cardId ? (
                <button type="button" className={s.sentenceBtn} title={`Show the ${KIND_WORD[x.kind]} tile`} onClick={() => jumpToCard(ed, x.cardId as string)}>
                  {x.text}
                </button>
              ) : (
                <span>{x.text}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className={s.summaryFoot}>
        <span className={s.stamp}>
          Updated {time(computedAt)}
          {ed.view.asOf ? ` · data as of ${new Date(ed.view.asOf).toLocaleString()}` : ''}
          {shown ? ' · rewritten by the Assistant from these figures' : ''}
        </span>
        {shown ? (
          <Button size="sm" variant="ghost" onClick={() => setProse(null)}>
            Show the sentences
          </Button>
        ) : canRewrite ? (
          <Button size="sm" variant="ghost" icon="sparkles" loading={busy} onClick={() => void rewrite()}>
            {busy ? 'Rewriting…' : 'Rewrite'}
          </Button>
        ) : (
          <span className={s.stamp} title={rewriteReason}>
            Rewrite needs a model
          </span>
        )}
      </div>
    </div>
  );
}

/** "More → Summary" (sumAddToTop): a full-width card at the top; everything else moves down. */
export function addSummary(ed: EditorApi): void {
  if (ed.cards.some((c) => c.type === 'summary')) return void toast('This sheet already has a summary');
  const id = crypto.randomUUID();
  ed.edit('Add summary', (d) => {
    const sh = d.sheets[ed.sheet];
    for (const c of sh.cards) if (c.type !== 'control') c.layout = { ...c.layout, y: c.layout.y + 4 };
    sh.cards.unshift({ id, type: 'summary', layout: { x: 0, y: 0, w: 12, h: 4 } });
  });
  ed.select(id);
}
