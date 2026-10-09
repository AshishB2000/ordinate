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

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Chart } from '../../charts/Chart';
import { DataTable } from '../../charts/DataTable';
import type { ChartDataShape } from '../../charts/types';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { AsOfCaption } from '../../ui/AsOf';
import type { AsOf } from '../../ui/asOf';
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
}
type Reply = Card | { ok: false; reason?: string };

export function AnswerCard({
  projectId,
  spec,
  narrated,
  onFollowUp,
}: {
  projectId: string;
  spec: { datasetId: string; title?: string } & Record<string, unknown>;
  narrated: boolean;
  onFollowUp: (spec: Record<string, unknown>, label: string) => Promise<void>;
}) {
  const q = useQuery({
    queryKey: ['answer:card', projectId, JSON.stringify(spec)],
    queryFn: async () => (await rpc('answer:card', { projectId, spec })) as Reply,
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
      <div className={s.chart}>
        <Chart type={card.chartType} data={card.data} label={card.title} />
      </div>
      {card.caption && <div className={s.caption}>{card.caption}</div>}
      {card.notes.map((n) => (
        <div key={n} className={s.note}>
          {n}
        </div>
      ))}
      {!narrated && card.bullets.length > 0 && (
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
      <div className={s.actions}>
        <Button size="sm" variant="ghost" aria-expanded={table} onClick={() => setTable(!table)}>
          {table ? 'Hide table' : 'Show table'}
        </Button>
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
  );
}
