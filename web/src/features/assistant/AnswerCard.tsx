// An answer with a chart — answerCard.ts, ported. Every figure on the card
// (headline values, the chart's data, the caption, the filter labels) is the
// server's. A conversation's answer keeps its card as computed then and brings it
// along (`card`, src/ipc/answerSnapshots.ts), so reopening asks nothing; one it
// did not bring (not kept yet, too big to keep, or the person's access changed)
// is computed now by `answer:refresh` and kept. Its time, "first asked" and
// Refresh are ./AnswerKept. A card of no turn asks `answer:card`. This file
// formats nothing and derives nothing: a KPI is the server's `display` string.
//
// With no model configured the turn has no prose, and the card shows the
// app's facts as bullet points instead — the same content.
//
// The card says how fresh its figures are (`asOf`, L0.2) beside the dataset's
// name — the time the narration was given too.
//
// An answer with NO ROWS because a filter value is not in its column is not a
// dead end: the server's sentence says which value, and "Did you mean" offers
// the nearest stored ones (`noMatch`) in place of an empty chart. A good answer
// can be kept: "Save as visual" (./SaveAsVisual), for a member who may edit.
// An answer run from a "Did you mean" column carries the name that was said
// (`learn`), and the card offers to remember it (./RememberName).
//
// At its own width the card spreads out (the full-width Assistant): a taller
// chart with every category named, bigger figures, the table at length, the
// actions and follow-ups on one row. CSS only, a container query: the same
// reply, nothing derived.
//
// A card whose spec is a working verified question's says so, "✓ Verified · who" (part 3 D9): the server's
// `verified`, worked out at every draw, never the card's own guess.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Chart } from '../../charts/Chart';
import { DataTable } from '../../charts/DataTable';
import type { ChartDataShape } from '../../charts/types';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { AsOfCaption } from '../../ui/AsOf';
import { day } from '../data/format';
import type { AsOf } from '../../ui/asOfView';
import { LiveRefusal } from '../live/LiveOff';
import { liveRefusalOf } from '../live/refusal';
import { DidYouMean, type MeantOption } from './DidYouMean';
import { RememberName, type CardLearn } from './RememberName';
import { SaveAsVerified } from './SaveAsVerified';
import { SaveAsVisual } from './SaveAsVisual';
import { keepInConversation, refreshAnswer } from './api';
import { ACCESS_CHANGED, KeptAsOf, periodText } from './AnswerKept';
import s from './AnswerCard.module.css';

/** A relative period as it resolved when the card was computed (src/ai/answerSnapshot.ts). */
export interface KeptPeriod {
  name: string;
  from: string;
  to: string;
}

/** What the server says about the figures a card kept (src/ai/answerSnapshot.ts `KeptView`). */
export interface Kept {
  /** When they were computed; null: too big to keep, computed on each open ("Updates on open"). */
  asOf: string | null;
  /** When the answer was first given, only when that was before `asOf`. */
  firstAsked?: string;
  periods: KeptPeriod[];
  /** Computed again because the person's access changed since. */
  accessChanged?: true;
}

export interface Card {
  ok: true;
  title: string;
  chartType: string;
  datasetName: string;
  data: ChartDataShape;
  caption: string;
  headline: { label: string; display: string }[];
  bullets: string[];
  chips: { label: string; spec: Record<string, unknown> }[];
  filterLabels: string[];
  notes: string[];
  asOf?: AsOf;
  /** No rows, because a filter value is not in its column: the server's sentence and the stored values it may have meant. */
  noMatch?: { text: string; options: MeantOption[] };
  /** The name its turn can remember, and whether the project already knows it. */
  learn?: CardLearn;
  /** The visual its turn records, handed back only while it exists. */
  savedVisualId?: string;
  /** Its spec is a working verified question's (semantic part 3 D9): worked out by the server at every draw. */
  verified?: { id: string; question: string; by: string; at: string };
  /** A conversation's answer: what it kept. None on a card of no turn. */
  snapshot?: Kept;
}
export type CardReply = Card | { ok: false; reason?: string };

export function AnswerCard({
  projectId,
  spec,
  learn,
  turn,
  card: kept,
  savedVisualId,
  narrated,
  question,
  onFollowUp,
}: {
  projectId: string;
  spec: { datasetId: string; title?: string } & Record<string, unknown>;
  /** The turn's name to remember (`Turn.learn`); the card's reply says whether it still is one. */
  learn?: { said: string; column: string };
  /** The stored turn this card draws, and the Visual it was saved as — for "Save as visual" (./SaveAsVisual). */
  turn?: { threadId: string; turnId: string };
  /** The card the turn kept, as its conversation brought it (`Turn.card`): drawn with no call. */
  card?: Card;
  savedVisualId?: string;
  narrated: boolean;
  /** What was asked (the turn before): prefills "Save as verified". */
  question?: string;
  onFollowUp: (spec: Record<string, unknown>, label: string) => Promise<void>;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: turn
      ? ['answer:refresh', projectId, turn.threadId, turn.turnId, savedVisualId] // a save asks again, as a card of no turn does
      : ['answer:card', projectId, JSON.stringify(spec), learn?.said, learn?.column, savedVisualId],
    enabled: !kept,
    queryFn: async (): Promise<CardReply> => {
      if (!turn) return (await rpc('answer:card', { projectId, spec, ...(learn ? { learn } : {}), ...(savedVisualId ? { savedVisualId } : {}) })) as CardReply;
      const r = await refreshAnswer(projectId, turn.threadId, turn.turnId);
      if (r.ok && r.snapshot?.asOf) keepInConversation(qc, projectId, turn.turnId, r); // kept now: a remount draws it with no call
      return r;
    },
    // The same card asked again with what its turn now records (a save): keep drawing it meanwhile.
    placeholderData: (previous) => previous,
    // A turn's card computed here is also kept by the server: once, never again on a window focus.
    ...(turn ? { staleTime: Infinity, refetchOnWindowFocus: false } : {}),
  });
  const [table, setTable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const title = typeof spec.title === 'string' && spec.title ? spec.title : 'Answer';

  if (!kept && q.isPending) {
    return (
      <div className={`${s.card} ${s.loading}`} role="status" aria-busy="true" aria-label="Drawing the answer">
        <div className={s.title}>{title}</div>
        <Skeleton className={s.skel} />
      </div>
    );
  }
  const card = kept ?? q.data;
  const failed = !kept && q.isError ? q.error : card;
  // Off for a Live dataset (L2.6): the server's reason and a copy of the dataset it asked.
  const live = liveRefusalOf(failed);
  if (live !== null) {
    return (
      <div className={`${s.card} ${s.error}`}>
        <div className={s.title}>{title}</div>
        <LiveRefusal refusal={failed} projectId={projectId} datasetId={spec.datasetId} />
      </div>
    );
  }
  if (!card || !card.ok) {
    return (
      <div className={`${s.card} ${s.error}`}>
        <div className={s.title}>{title}</div>
        <div className={s.note}>{(card && !card.ok && card.reason) || 'This answer could not be drawn.'}</div>
      </div>
    );
  }
  const snap = card.snapshot;
  return (
    <div className={s.card} data-testid="answer-card">
      <div className={s.head}>
        <div className={s.title}>{card.title || 'Answer'}</div>
        <div className={s.meta}>
          <span className={s.dataset}>{card.datasetName}</span>
          {/* A kept card is dated by when it was computed; one computed now by its data's time, as before. */}
          {snap && <KeptAsOf projectId={projectId} turn={turn} kept={snap} />}
          {!snap?.asOf && <AsOfCaption asOf={card.asOf} className={s.asOf} />}
          {card.verified && (
            <span className={s.verified} title={`Verified ${day.format(new Date(card.verified.at))}: ${card.verified.question}`}>
              ✓ Verified · {card.verified.by}
            </span>
          )}
          {card.filterLabels.map((f) => (
            <span key={f} className={s.filter}>
              {f}
            </span>
          ))}
          {snap?.periods.map((p) => (
            <span key={`${p.name}${p.from}`} className={s.filter}>
              {periodText(p)}
            </span>
          ))}
        </div>
      </div>
      {snap?.accessChanged && (
        <div className={s.changed} role="status" data-testid="answer-access-changed">
          {ACCESS_CHANGED}
        </div>
      )}
      {card.headline.length > 0 && (
        <div className={s.kpis}>
          {card.headline.map((k) => (
            <div key={k.label} className={s.kpi}>
              <div className={s.kpiValue}>{k.display}</div>
              <div className={s.kpiLabel}>{k.label}</div>
            </div>
          ))}
        </div>
      )}
      {card.noMatch ? (
        // Nothing to draw, and the server knows why: its sentence and its options stand where the chart would.
        <div className={s.noMatch} data-testid="answer-no-match">
          <div className={s.noMatchText}>{card.noMatch.text}</div>
          <DidYouMean options={card.noMatch.options} onPick={onFollowUp} />
        </div>
      ) : (
        <div className={s.chart}>
          <Chart type={card.chartType} data={card.data} label={card.title} />
        </div>
      )}
      {card.caption && !card.noMatch && <div className={s.caption}>{card.caption}</div>}
      {card.notes.map((n) => (
        <div key={n} className={s.note}>
          {n}
        </div>
      ))}
      {!narrated && !card.noMatch && card.bullets.length > 0 && (
        <ul className={s.facts}>
          {card.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {table && (
        <div className={s.table}>
          <DataTable data={card.data} label={card.title} />
        </div>
      )}
      {/* An empty answer has no table to show and nothing worth keeping or splitting. */}
      {!card.noMatch && (
        <div className={s.foot}>
          <div className={s.actions}>
            <Button size="sm" variant="ghost" aria-expanded={table} onClick={() => setTable(!table)}>
              {table ? 'Hide table' : 'Show table'}
            </Button>
            <SaveAsVisual projectId={projectId} spec={spec} turn={turn} savedVisualId={card.savedVisualId} />
            {!card.verified && <SaveAsVerified projectId={projectId} spec={spec} question={question ?? ''} />}
            {card.learn && (
              <RememberName
                projectId={projectId}
                datasetId={spec.datasetId}
                learn={card.learn}
                // A kept card's name state comes with its conversation: asked again there, its figures untouched.
                onTaught={() => (kept ? qc.invalidateQueries({ queryKey: ['copilot:history', projectId] }) : q.refetch())}
              />
            )}
          </div>
          {card.chips.length > 0 && (
            <div className={s.chips}>
              {card.chips.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className={s.chip}
                  disabled={busy !== null}
                  aria-busy={busy === c.label || undefined}
                  onClick={() => {
                    setBusy(c.label);
                    void onFollowUp(c.spec, c.label).finally(() => setBusy(null));
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
