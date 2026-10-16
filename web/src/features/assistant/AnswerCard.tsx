// An answer with a chart — answerCard.ts, ported. The turn stores only the
// SPEC; every figure on the card (headline values, the chart's data, the
// caption, the filter labels) comes back from `answer:card`, recomputed on
// every render, so a refreshed dataset moves an old answer with it. This file
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

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Chart } from '../../charts/Chart';
import { DataTable } from '../../charts/DataTable';
import type { ChartDataShape } from '../../charts/types';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { AsOfCaption } from '../../ui/AsOf';
import type { AsOf } from '../../ui/asOfView';
import { LiveRefusal } from '../live/LiveOff';
import { liveRefusalOf } from '../live/refusal';
import { DidYouMean, type MeantOption } from './DidYouMean';
import { RememberName, type CardLearn } from './RememberName';
import { SaveAsVisual } from './SaveAsVisual';
import s from './AnswerCard.module.css';

interface Card {
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
}
type Reply = Card | { ok: false; reason?: string };

export function AnswerCard({
  projectId,
  spec,
  learn,
  turn,
  savedVisualId,
  narrated,
  onFollowUp,
}: {
  projectId: string;
  spec: { datasetId: string; title?: string } & Record<string, unknown>;
  /** The turn's name to remember (`Turn.learn`); the card's reply says whether it still is one. */
  learn?: { said: string; column: string };
  /** The stored turn this card draws, and the Visual it was saved as — for "Save as visual" (./SaveAsVisual). */
  turn?: { threadId: string; turnId: string };
  savedVisualId?: string;
  narrated: boolean;
  onFollowUp: (spec: Record<string, unknown>, label: string) => Promise<void>;
}) {
  const q = useQuery({
    queryKey: ['answer:card', projectId, JSON.stringify(spec), learn?.said, learn?.column],
    queryFn: async () => (await rpc('answer:card', { projectId, spec, ...(learn ? { learn } : {}) })) as Reply,
  });
  const [table, setTable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const title = typeof spec.title === 'string' && spec.title ? spec.title : 'Answer';

  if (q.isPending) {
    return (
      <div className={`${s.card} ${s.loading}`} role="status" aria-busy="true" aria-label="Drawing the answer">
        <div className={s.title}>{title}</div>
        <Skeleton className={s.skel} />
      </div>
    );
  }
  const card = q.data;
  // Off for a Live dataset (L2.6): the server's reason and a copy of the dataset it asked.
  const live = liveRefusalOf(q.isError ? q.error : card);
  if (live !== null) {
    return (
      <div className={`${s.card} ${s.error}`}>
        <div className={s.title}>{title}</div>
        <LiveRefusal message={live} projectId={projectId} datasetId={spec.datasetId} />
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
  return (
    <div className={s.card} data-testid="answer-card">
      <div className={s.head}>
        <div className={s.title}>{card.title || 'Answer'}</div>
        <div className={s.meta}>
          <span className={s.dataset}>{card.datasetName}</span>
          <AsOfCaption asOf={card.asOf} className={s.asOf} />
          {card.filterLabels.map((f) => (
            <span key={f} className={s.filter}>
              {f}
            </span>
          ))}
        </div>
      </div>
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
        <div className={s.actions}>
          <Button size="sm" variant="ghost" aria-expanded={table} onClick={() => setTable(!table)}>
            {table ? 'Hide table' : 'Show table'}
          </Button>
          <SaveAsVisual projectId={projectId} spec={spec} turn={turn} savedVisualId={savedVisualId} />
          {card.learn && <RememberName projectId={projectId} datasetId={spec.datasetId} learn={card.learn} onTaught={() => q.refetch()} />}
        </div>
      )}
      {!card.noMatch && card.chips.length > 0 && (
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
  );
}
