// Where an answer's figures come from, and where else they are shown (docs/assistant/00-design.md, The flow, step 7):
// "Answered from ▾" and "Also on ▸" in the card's meta row. Every word in them is the server's
// (src/ipc/answerSources.ts): the dataset's name and the page it opens, what the answer reads, its filters, the time of
// its figures, its verified question, and only for an editor where the rows come from. "Also on" asks `answer:alsoOn`
// when it opens, never when the card draws.

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../api/client';
import { AsOfCaption } from '../../ui/AsOf';
import { Badge } from '../../ui/Badge';
import type { AsOf } from '../../ui/asOfView';
import { Icon } from '../../ui/icons/Icon';
import { Popover, PopoverClose } from '../../ui/Popover';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import type { Card } from './AnswerCard';
import { periodText } from './AnswerKept';
import s from './AnswerSources.module.css';

/** `answer:alsoOn` (src/ipc/answerSources.ts `AlsoOn`). */
export type AlsoOnReply = { ok: true; dashboards: { id: string; name: string; draft?: true }[]; more: number } | { ok: false; reason?: string };

const NOT_FOUND = 'Could not find the dashboards that use this dataset.';

/** The trigger both menus share: small, in the meta row, a chevron saying which way it opens. */
function Trigger({ label, children, icon, testId, ...rest }: { label: string; children: ReactNode; icon: 'chevron-down' | 'chevron-right'; testId: string }) {
  return (
    <button type="button" className={s.trigger} aria-label={label} data-testid={testId} {...rest}>
      {children}
      <Icon name={icon} size={12} />
    </button>
  );
}

/** "Answered from Sales ▾": the dataset, its source for an editor, what the answer reads, its filters, time and verified question. */
export function AnsweredFrom({ projectId, card, table = false }: { projectId: string; card: Card; table?: boolean }) {
  const live = card.asOf?.mode === 'live';
  const keptAt = card.snapshot?.asOf;
  // A kept card's figures are as of when they were computed; one computed now, as of its data.
  const at: AsOf | undefined = keptAt ? { at: keptAt, mode: live ? 'live' : 'extract' } : card.asOf;
  const filters = [...card.filterLabels, ...(card.snapshot?.periods ?? []).map(periodText)];
  const page = card.answeredFrom?.datasetId;
  return (
    <Popover
      title={`Answered from ${card.datasetName}`}
      trigger={
        <Trigger label={`Answered from ${card.datasetName}`} icon="chevron-down" testId="answered-from">
          <span className={s.word}>Answered from</span>
          <span className={s.name}>{card.datasetName}</span>
        </Trigger>
      }
    >
      <dl className={s.facts}>
        <div className={s.fact}>
          <dt>{table ? 'Table' : 'Dataset'}</dt>
          <dd className={s.dataset}>
            {page && !table ? (
              <PopoverClose asChild>
                <Link className={s.link} to={`/data/${projectId}/${page}`}>
                  <Icon name="database" size={16} />
                  {card.datasetName}
                </Link>
              </PopoverClose>
            ) : (
              <span>{card.datasetName}</span>
            )}
            {live && <Badge tone="accent">Live</Badge>}
          </dd>
        </div>
        {card.answeredFrom?.origin && (
          <div className={s.fact}>
            <dt>Rows from</dt>
            <dd>{card.answeredFrom.origin}</dd>
          </div>
        )}
        {card.uses && card.uses.length > 0 && (
          <div className={s.fact}>
            <dt>Uses</dt>
            <dd>{card.uses.join(', ')}</dd>
          </div>
        )}
        <div className={s.fact}>
          <dt>Filters</dt>
          <dd>{filters.length ? filters.join(' · ') : 'None'}</dd>
        </div>
        {at && (
          <div className={s.fact}>
            <dt>Figures</dt>
            <dd>
              <AsOfCaption asOf={at} />
            </dd>
          </div>
        )}
        {card.verified && (
          <div className={s.fact}>
            <dt>Verified question</dt>
            <dd>{card.verified.question}</dd>
          </div>
        )}
      </dl>
    </Popover>
  );
}

/** "Also on ▸": the dashboards this person may open that show the same dataset, at most five and how many more. */
export function AlsoOn({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['answer:alsoOn', projectId, datasetId],
    enabled: open, // asked when the menu opens: a card draws with no call
    queryFn: async () => {
      const r = (await rpc('answer:alsoOn', { projectId, datasetId })) as AlsoOnReply;
      if (!r.ok) throw new Error(r.reason || NOT_FOUND);
      return r;
    },
  });
  return (
    <Popover
      title="Also on"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Trigger label="Also on dashboards" icon="chevron-right" testId="also-on">
          <span className={s.word}>Also on</span>
        </Trigger>
      }
    >
      <h3 className={s.heading}>Also on these dashboards</h3>
      {q.isPending && <SkeletonRows rows={3} label="Finding dashboards" />}
      {q.isError && <ErrorState compact heading={3} title="Dashboards could not load" message={q.error.message || NOT_FOUND} onRetry={() => void q.refetch()} />}
      {q.data && q.data.dashboards.length === 0 && <p className={s.empty}>Not on any dashboard yet</p>}
      {q.data && q.data.dashboards.length > 0 && (
        <ul className={s.rows}>
          {q.data.dashboards.map((d) => (
            <li key={d.id}>
              <PopoverClose asChild>
                <Link className={s.row} to={`/analyses/${projectId}/${d.id}`}>
                  <Icon name="layout-dashboard" size={16} />
                  <span className={s.rowName}>{d.name}</span>
                  {d.draft && <Badge>Draft</Badge>}
                </Link>
              </PopoverClose>
            </li>
          ))}
        </ul>
      )}
      {q.data && q.data.more > 0 && <p className={s.more}>and {q.data.more} more</p>}
    </Popover>
  );
}
