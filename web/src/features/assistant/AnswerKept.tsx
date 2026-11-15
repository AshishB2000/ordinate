// What an answer card says about the figures it kept (src/ai/answerSnapshot.ts, docs/assistant/00-design.md
// "Answers keep the figures they had"). An answer keeps its card as the server computed it, so reopening the
// conversation shows the figures it had, dated: "As of 9:10 AM · first asked Nov 1", with Refresh, which has the
// server compute it now and keep that instead. A card too big to keep says "Updates on open" (not "Live", the word for a warehouse dataset): it is computed on each open.
// A relative period names its days ("Yesterday: Oct 31, 2026"), and a card the server computed again because the
// person's access changed says so. Every time and day here is the server's; this only formats them.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { AsOfCaption } from '../../ui/AsOf';
import { day, dayInYear } from '../data/format';
import { keepInConversation, refreshAnswer } from './api';
import type { Kept, KeptPeriod } from './AnswerCard';
import s from './AnswerCard.module.css';

const FAILED = 'Could not refresh this answer.';
export const ACCESS_CHANGED = 'Your access changed since this answer, so it shows today’s figures.';
const LIVE_TITLE = 'Too large to keep with the conversation, so it is computed each time it opens';

// ISO days are calendar days, not instants: formatted in UTC so no time zone moves them.
const isoDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "Yesterday: Oct 31, 2026", "Last quarter: Jul 1 – Sep 30, 2026". */
export function periodText(p: KeptPeriod): string {
  const [from, to] = [new Date(`${p.from}T00:00:00Z`), new Date(`${p.to}T00:00:00Z`)];
  return `${p.name}: ${p.from === p.to ? isoDay.format(from) : isoDay.formatRange(from, to)}`;
}

/** The card's time, "first asked" and Refresh, in its meta row; "Updates on open" for a card not kept. */
export function KeptAsOf({ projectId, turn, kept }: { projectId: string; turn?: { threadId: string; turnId: string }; kept: Kept }) {
  const qc = useQueryClient();
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }>({ kind: 'idle' });
  if (kept.asOf === null) {
    return (
      <span className={s.live} title={LIVE_TITLE} data-testid="answer-live">
        Updates on open
      </span>
    );
  }
  const asOf = kept.asOf;
  const first = kept.firstAsked ? new Date(kept.firstAsked) : null;
  const sameYear = !!first && first.getFullYear() === new Date(asOf).getFullYear();

  async function refresh(at: { threadId: string; turnId: string }): Promise<void> {
    setState({ kind: 'busy' });
    try {
      const r = await refreshAnswer(projectId, at.threadId, at.turnId);
      if (!r.ok) return setState({ kind: 'error', message: r.reason || FAILED });
      keepInConversation(qc, projectId, at.turnId, r); // the card draws the new one; the old stays on a failure
      setState({ kind: 'idle' });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error && e.message ? e.message : FAILED });
    }
  }

  return (
    <>
      <span className={s.kept} data-testid="answer-kept">
        <AsOfCaption asOf={{ at: asOf, mode: 'extract' }} />
        {first && <span>· first asked {(sameYear ? day : dayInYear).format(first)}</span>}
      </span>
      {turn && (
        <Button size="sm" variant="ghost" icon="refresh" className={s.refresh} loading={state.kind === 'busy'} onClick={() => void refresh(turn)}>
          {state.kind === 'busy' ? 'Refreshing…' : 'Refresh'}
        </Button>
      )}
      {state.kind === 'error' && (
        <span className={s.saveError} role="alert">
          {state.message}
        </span>
      )}
    </>
  );
}
