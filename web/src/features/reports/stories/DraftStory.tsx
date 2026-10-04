// "Draft with the Assistant" (storyList.ts stDraftFromList + storyPropose.ts):
// ask what the story is about; the model proposes STRUCTURE, the server
// validates and previews it (`story:draft`) — sections, their KPIs, their charts
// drawn from app-computed data, their notes — and nothing is created until
// Build (`story:build`). Then the new story opens.

import { useState } from 'react';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Textarea } from '../../../ui/Field';
import { EmptyState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import type { DraftReply, PlanPreview } from '../../analyses/api';
import { DrawnVisual } from '../../analyses/VisualTile';
import { failure } from '../api';
import pk from './Pickers.module.css';

export function DraftStory({ projectId, onClose, onBuilt }: { projectId: string; onClose: () => void; onBuilt: (id: string) => void }) {
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<PlanPreview | null>(null);
  const [notReady, setNotReady] = useState(false);

  const draft = async () => {
    setBusy(true);
    try {
      const r = (await rpc('story:draft', { projectId, intent: intent.trim() })) as DraftReply;
      if (!r.ok) {
        if (r.notReady) setNotReady(true);
        else toast(failure(r, 'Could not draft a story.'), { kind: 'error' });
      } else setPlan(r);
    } catch (err) {
      toast(failure(err, 'Could not draft a story.'), { kind: 'error' });
    }
    setBusy(false);
  };
  const build = async () => {
    if (!plan?.plan) return;
    setBusy(true);
    try {
      const r = (await rpc('story:build', { projectId, plan: plan.plan })) as { ok: boolean; story?: { id: string }; error?: string };
      if (!r.ok || !r.story) throw new Error(failure(r, 'Could not build that story.'));
      onClose();
      onBuilt(r.story.id);
    } catch (err) {
      toast(failure(err, 'Could not build that story.'), { kind: 'error' });
      setBusy(false);
    }
  };

  if (notReady) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title="The Assistant is not set up">
        <EmptyState compact heading={3} icon="sparkles" title="Connect a model first">
          An organization admin connects an AI provider in Admin → Assistant. You can still write a story yourself.
        </EmptyState>
      </Dialog>
    );
  }
  if (!plan) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Draft a story with the Assistant"
        description="It proposes the outline — sections, charts and metrics. You review it before anything is created; every figure is computed by the app."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" icon="sparkles" loading={busy} disabled={!intent.trim()} onClick={() => void draft()}>
              Draft
            </Button>
          </>
        }
      >
        <Textarea label="What should the story be about?" value={intent} onChange={(e) => setIntent(e.target.value)} rows={3} maxLength={2000} autoFocus placeholder="How revenue moved this quarter, and where" />
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={plan.name || 'Suggested story'}
      description={plan.rationale}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Dismiss
          </Button>
          <Button variant="primary" loading={busy} disabled={!plan.sheets.length} onClick={() => void build()}>
            Build story
          </Button>
        </>
      }
    >
      <ol className={pk.planList}>
        {(plan.sheets as Array<PlanPreview['sheets'][number] & { texts?: Array<{ heading?: string; text?: string }> }>).map((sh, i) => (
          <li key={i} className={pk.planSection}>
            <h3 className={pk.planH}>{sh.name || 'Section'}</h3>
            {!!sh.metrics?.length && (
              <div className={pk.planKpis}>
                {sh.metrics.map((m, j) => (
                  <span key={j} className={pk.planKpi}>
                    <strong>{m.label || m.column}</strong> {m.aggregation} of {m.column}
                  </span>
                ))}
              </div>
            )}
            {!!sh.visuals?.length && (
              <div className={pk.planCharts}>
                {sh.visuals.map((v, j) => (
                  <figure key={j} className={pk.planChart}>
                    <figcaption>{v.title || v.name}</figcaption>
                    <div className={pk.planDraw}>
                      {v.data ? <DrawnVisual type={v.chartType || 'column'} data={v.data} label={v.title || v.name || 'Chart'} projectId={projectId} thumb /> : <p>{v.note}</p>}
                    </div>
                  </figure>
                ))}
              </div>
            )}
            {(sh.texts ?? []).map((t, j) => {
              const note = [t.heading, t.text].filter(Boolean).join(' — ');
              return note ? <p key={j} className={pk.planNote}>{note}</p> : null;
            })}
          </li>
        ))}
      </ol>
      {!!plan.dropped?.length && (
        <div className={pk.dropped}>
          <strong>Left out</strong>
          <ul>
            {plan.dropped.map((d, i) => (
              <li key={i}>{d.message || d.where}</li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
