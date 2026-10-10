// Subscribe — a dashboard, or chosen cards of it, posted to Slack / Teams on a
// schedule. Four steps on the left (What, When, Where, Message) and, beside
// them the whole time, the message as the server would send it now: every edit
// that changes it asks `subscription:preview` again (debounced), so what the
// author reads here is what the channel will get.
//
// Opened from a dashboard (the dashboard is fixed), from the Subscriptions
// list for a new one (the dashboard is the first choice of What), or on a saved
// subscription to edit it. A lazy chunk: nothing loads until it is opened.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { galleryQuery } from '../analyses/api';
import { MessagePreview } from './MessagePreview';
import { MessageStep, WhatStep, WhenStep, WhereStep } from './Steps';
import { draftOf, newDraft, reason, useChannels, usePreview, useSubscriptionWrites, type Draft, type Subscription } from './api';
import s from './Subscribe.module.css';

const STEPS = [
  { id: 'what', label: 'What', sub: 'Cards' },
  { id: 'when', label: 'When', sub: 'Schedule' },
  { id: 'where', label: 'Where', sub: 'Channels' },
  { id: 'message', label: 'Message', sub: 'Wording' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

export interface SubscribeDialogProps {
  projectId: string;
  /** Opened from a dashboard: it is fixed. */
  dashboard?: { id: string; name: string };
  /** Editing a saved subscription. */
  existing?: Subscription;
  onClose: () => void;
}

export default function SubscribeDialog({ projectId, dashboard, existing, onClose }: SubscribeDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => (existing ? draftOf(existing) : newDraft(dashboard?.id ?? '', dashboard ? `${dashboard.name} — weekdays` : '')));
  const [step, setStep] = useState<StepId>('what');
  const locked = !!dashboard || !!existing;
  // The dashboard picker's list — only when there is a dashboard to pick.
  const gallery = useQuery({ ...galleryQuery(projectId), enabled: !locked });
  const channels = useChannels();
  // Channels do not change the message: keeping them out of the preview's key saves a round trip per tick.
  const previewDraft = useMemo(() => (draft.analysisId ? { ...draft, channelIds: [], name: draft.name.trim() || 'Subscription' } : null), [draft]);
  const preview = usePreview(projectId, previewDraft);
  const { save } = useSubscriptionWrites(projectId);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const dashboardName = dashboard?.name ?? existing?.dashboard ?? gallery.data?.find((d) => d.id === draft.analysisId)?.name ?? '';
  const chosen = channels.data?.channels.filter((c) => draft.channelIds.includes(c.id)) ?? [];
  const problems: Record<StepId, string | null> = {
    what: !draft.analysisId ? 'Choose a dashboard.' : draft.content.mode === 'cards' && draft.content.cardIds.length === 0 ? 'Tick at least one card.' : null,
    when: null,
    where: chosen.length === 0 ? 'Choose at least one channel.' : null,
    message: !draft.name.trim() ? 'Give the subscription a name.' : null,
  };
  const firstProblem = STEPS.find((x) => problems[x.id]);
  const at = STEPS.findIndex((x) => x.id === step);

  const submit = () => {
    if (firstProblem) {
      setStep(firstProblem.id);
      toast(problems[firstProblem.id] as string, { kind: 'error' });
      return;
    }
    save.mutate(
      { ...(existing ? { id: existing.id } : {}), subscription: { ...draft, name: draft.name.trim(), channelIds: chosen.map((c) => c.id) } },
      {
        onSuccess: (r) => {
          toast(existing ? 'Subscription saved' : `Subscribed — next: ${r.subscription.nextRuns[0]?.text ?? r.subscription.scheduleText}`, { kind: 'success' });
          onClose();
        },
        onError: (e) => toast(reason(e, 'The subscription could not be saved.'), { kind: 'error' }),
      },
    );
  };

  return (
    <Dialog
      open
      size="xxl"
      onOpenChange={(o) => !o && onClose()}
      title={existing ? `Edit ${existing.name}` : dashboard ? `Subscribe to ${dashboard.name}` : 'New subscription'}
      description="Post this dashboard’s figures to Slack or Teams on a schedule. The server sends it; nobody needs to be signed in."
      footer={
        <>
          <span className={s.footNote}>{firstProblem ? problems[firstProblem.id] : preview.data ? preview.data.scheduleText : ''}</span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {at > 0 && (
            <Button icon="chevron-left" onClick={() => setStep(STEPS[at - 1].id)}>
              Back
            </Button>
          )}
          {at < STEPS.length - 1 && (
            <Button iconEnd="chevron-right" onClick={() => setStep(STEPS[at + 1].id)}>
              Next
            </Button>
          )}
          <Button variant="primary" icon="send" loading={save.isPending} disabled={!!firstProblem} onClick={submit}>
            {existing ? 'Save' : 'Subscribe'}
          </Button>
        </>
      }
    >
      <div className={s.layout}>
        <div className={s.left}>
          <ol className={s.steps} aria-label="Steps">
            {STEPS.map((x, i) => {
              const done = !problems[x.id] && i < at;
              return (
                <li key={x.id}>
                  <button type="button" className={x.id === step ? `${s.stepBtn} ${s.stepOn}` : s.stepBtn} aria-current={x.id === step ? 'step' : undefined} onClick={() => setStep(x.id)}>
                    <span className={done ? `${s.stepNo} ${s.stepDone}` : s.stepNo} aria-hidden="true">
                      {done ? <Icon name="check" size={12} /> : i + 1}
                    </span>
                    <span className={s.stepText}>
                      <span className={s.stepLabel}>{x.label}</span>
                      <span className={s.stepSub}>{x.sub}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className={s.stepBody} role="group" aria-label={STEPS[at].label}>
            {step === 'what' && <WhatStep draft={draft} set={set} preview={preview.data} dashboards={gallery.data} locked={locked} />}
            {step === 'when' && <WhenStep draft={draft} set={set} preview={preview.data} />}
            {step === 'where' && (
              <WhereStep draft={draft} set={set} channels={channels.data} pending={channels.isPending} error={channels.isError ? channels.error.message : null} onRetry={() => void channels.refetch()} />
            )}
            {step === 'message' && <MessageStep draft={draft} set={set} preview={preview.data} dashboardName={dashboardName} />}
          </div>
        </div>
        {draft.analysisId ? (
          <MessagePreview
            preview={preview.data}
            pending={preview.isPending || preview.isFetching}
            error={preview.isError ? preview.error.message : null}
            onRetry={() => void preview.refetch()}
            prefer={chosen[0]?.kind}
          />
        ) : (
          <div className={s.noPreview}>
            <Icon name="send" size={20} />
            <span>Choose a dashboard and its message appears here, as Slack and Teams will show it.</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
