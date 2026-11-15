// An answer the chart form could not express (the SQL lane, docs/assistant/00-design.md "Two ways to answer"): a table
// the Query tab's gate ran from SQL the AI wrote. Every cell, the caption and the bullets are the server's (DuckDB's
// figures, the app's words); nothing here computes. It is marked "Not checked · SQL written by the AI" until an editor
// verifies it ("✓ Verified · who", worked out by the server at every draw). "Show SQL" shows the statement, which names
// only datasets (never a dataset's source), to everyone the answer is shown to: the person who asked could read those
// datasets whole, and so can anyone shown its kept table. A label column and one number come with a simple chart.
// It is not a chart: it cannot be saved as a visual, put on a dashboard or alerted on, and says so where those would be.
//
// Like ./AnswerCard, a conversation's answer brings the table it kept (`card`), dated with Refresh (./AnswerKept); one it
// did not bring (too big to keep, or the person's access changed) runs again through `answer:refresh` and is kept.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { rpc } from '../../api/client';
import { Chart } from '../../charts/Chart';
import type { ChartDataShape } from '../../charts/types';
import { DataGrid } from '../../ui/DataGrid/DataGrid';
import type { GridColumn } from '../../ui/DataGrid/DataGrid';
import type { Cell } from '../../ui/DataGrid/pageCache';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { day } from '../data/format';
import { LiveRefusal } from '../live/LiveOff';
import { liveRefusalOf } from '../live/refusal';
import { ACCESS_CHANGED, KeptAsOf } from './AnswerKept';
import type { Card, Kept } from './AnswerCard';
import { SaveAsVerified } from './SaveAsVerified';
import { keepInConversation } from './api';
import s from './AnswerCard.module.css';
import q from './AnswerSql.module.css';

/** src/ai/answerSql.ts `SqlCard`, as delivered (src/ipc/answerSnapshots.ts). */
export interface SqlCard {
  ok: true;
  kind: 'sql';
  title: string;
  sql: string;
  datasets: string[];
  columns: GridColumn[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  caption: string;
  bullets: string[];
  chart?: { type: string; data: ChartDataShape };
  verified?: { id: string; question: string; by: string; at: string };
  snapshot?: Kept;
}

/** What an SQL answer turn stores (src/ai/answerSql.ts `SqlTurn`): the statement, the datasets it read, its title. */
export interface SqlTurn { text: string; datasetIds: string[]; title: string }

export const isSqlCard = (c: Card | SqlCard | undefined): c is SqlCard => !!c && 'kind' in c && c.kind === 'sql';

export const NOT_CHECKED = 'Not checked · SQL written by the AI';
export const NOT_A_CHART = 'Not a chart: an SQL answer can’t be saved as a visual, added to a dashboard or used for an alert.';

export function AnswerSql({ projectId, turn, sql, card: kept, question }: {
  projectId: string;
  /** The stored turn this card draws: Refresh, and a card its conversation did not bring. */
  turn?: { threadId: string; turnId: string };
  sql: SqlTurn;
  /** The table the turn kept, as its conversation brought it: drawn with no call. */
  card?: Card | SqlCard;
  /** What was asked (the turn before): prefills Verify. */
  question?: string;
}) {
  const qc = useQueryClient();
  const brought = isSqlCard(kept) ? kept : undefined;
  const r = useQuery({
    queryKey: ['answer:refresh', projectId, turn?.threadId, turn?.turnId],
    enabled: !brought && !!turn,
    queryFn: async () => {
      const at = turn as { threadId: string; turnId: string }; // enabled only with one
      const reply = (await rpc('answer:refresh', { projectId, threadId: at.threadId, turnId: at.turnId })) as SqlCard | { ok: false; reason?: string; code?: string };
      // Kept in the conversation's copy of the turn, in the field a chart's card uses (isSqlCard tells them apart): a remount draws it with no call.
      if (reply.ok && reply.snapshot?.asOf) keepInConversation(qc, projectId, at.turnId, reply as unknown as Card);
      return reply;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [open, setOpen] = useState(false);
  const [table, setTable] = useState(false);
  const card = brought ?? (r.data && r.data.ok ? r.data : undefined);
  const rows = card?.rows;
  const source = useMemo(() => async (offset: number, limit: number) => ({ rows: (rows ?? []).slice(offset, offset + limit), total: rows?.length ?? 0 }), [rows]);

  if (!card && r.isPending && turn) {
    return (
      <div className={`${s.card} ${s.loading}`} role="status" aria-busy="true" aria-label="Running the answer’s SQL">
        <div className={s.title}>{sql.title}</div>
        <Skeleton className={s.skel} />
      </div>
    );
  }
  if (!card) {
    const failed = r.isError ? r.error : r.data;
    if (liveRefusalOf(failed) !== null) {
      return (
        <div className={`${s.card} ${s.error}`}>
          <div className={s.title}>{sql.title}</div>
          <LiveRefusal refusal={failed} projectId={projectId} datasetId={sql.datasetIds[0]} />
        </div>
      );
    }
    const reason = r.data && !r.data.ok ? r.data.reason : undefined;
    return (
      <div className={`${s.card} ${s.error}`} data-testid="answer-sql">
        <div className={s.title}>{sql.title}</div>
        <div className={s.note}>{reason || 'This answer’s SQL could not be run.'}</div>
      </div>
    );
  }
  const snap = card.snapshot;
  return (
    <div className={s.card} data-testid="answer-sql">
      <div className={s.head}>
        <div className={s.title}>{card.title || sql.title}</div>
        <div className={s.meta}>
          <span className={s.dataset}>{card.datasets.join(', ')}</span>
          {snap && <KeptAsOf projectId={projectId} turn={turn} kept={snap} />}
          {card.verified ? (
            <span className={s.verified} title={`Verified ${day.format(new Date(card.verified.at))}: ${card.verified.question}`}>
              ✓ Verified · {card.verified.by}
            </span>
          ) : (
            <span className={q.unchecked} title="Ordinate checked that it is safe to run, not that it is right" data-testid="answer-sql-unchecked">
              {NOT_CHECKED}
            </span>
          )}
        </div>
      </div>
      {snap?.accessChanged && (
        <div className={s.changed} role="status">
          {ACCESS_CHANGED}
        </div>
      )}
      {card.chart && (
        <div className={s.chart}>
          <Chart type={card.chart.type} data={card.chart.data} label={card.title} />
        </div>
      )}
      {(!card.chart || table) &&
        (card.columns.length ? (
          <div className={q.grid}>
            <DataGrid columns={card.columns} source={source} label={card.title || 'Answer'} emptyTitle="No rows" emptyBody="The SQL ran and returned no rows." />
          </div>
        ) : (
          <div className={s.note}>The SQL ran and returned no columns.</div>
        ))}
      {card.caption && <div className={s.caption}>{card.caption}</div>}
      {card.bullets.length > 0 && (
        <ul className={s.facts}>
          {card.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {open && (
        <pre className={q.sql} aria-label="The SQL" data-testid="answer-sql-text">
          {card.sql}
        </pre>
      )}
      <div className={s.foot}>
        <div className={s.actions}>
          <Button size="sm" variant="ghost" icon={open ? 'chevron-down' : 'chevron-right'} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide SQL' : 'Show SQL'}
          </Button>
          {card.chart && (
            <Button size="sm" variant="ghost" aria-expanded={table} onClick={() => setTable(!table)}>
              {table ? 'Hide table' : 'Show table'}
            </Button>
          )}
          {!card.verified && <SaveAsVerified projectId={projectId} sql={card.sql} question={question ?? ''} label="Verify" />}
          <span className={q.notChart}>{NOT_A_CHART}</span>
        </div>
      </div>
    </div>
  );
}
