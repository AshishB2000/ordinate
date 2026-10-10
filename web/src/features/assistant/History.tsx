// The dock's History: every conversation in the project, behind the header's
// clock. The title's dropdown holds the few most recent; this is the rest —
// searchable by title, grouped by when each was last touched. The list, its
// order and the turn counts are the server's (`copilot:threads`); the search
// filters TITLES only.

import { useState } from 'react';
import { IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Popover, PopoverClose } from '../../ui/Popover';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { threadTitle, turnsLabel, useThreads, type ThreadSummary } from './api';
import s from './History.module.css';

export interface ThreadGroup {
  label: 'Today' | 'Yesterday' | 'Earlier';
  threads: ThreadSummary[];
}

/** Today / Yesterday / Earlier by the viewer's own calendar day; the server's order is kept inside each. */
export function groupThreads(threads: readonly ThreadSummary[], now: Date): ThreadGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const groups: ThreadGroup[] = [
    { label: 'Today', threads: [] },
    { label: 'Yesterday', threads: [] },
    { label: 'Earlier', threads: [] },
  ];
  for (const t of threads) {
    const at = Date.parse(t.updatedAt); // NaN (no date) compares false twice: Earlier
    groups[at >= today ? 0 : at >= yesterday ? 1 : 2].threads.push(t);
  }
  return groups.filter((g) => g.threads.length > 0);
}

export interface HistoryProps {
  projectId: string | null;
  /** The conversation on screen, marked in the list. */
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (id: string) => void;
}

export function History({ projectId, threadId, open, onOpenChange, onOpen }: HistoryProps) {
  const threads = useThreads(projectId, open);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = (threads.data ?? []).filter((t) => threadTitle(t).toLowerCase().includes(needle));
  return (
    <Popover
      title="Conversation history"
      align="end"
      className={s.history}
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery('');
        onOpenChange(o);
      }}
      trigger={<IconButton icon="history" size="sm" label="Conversation history" disabled={!projectId} />}
    >
      <Input size="sm" icon="search" aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className={s.list}>
        {threads.isPending && <SkeletonRows rows={4} label="Loading conversations" />}
        {threads.isError && <ErrorState compact heading={3} title="Conversations could not load" message="Check your connection and try again." onRetry={() => void threads.refetch()} />}
        {threads.data && shown.length === 0 && <p className={s.empty}>{needle ? 'No conversation matches that search.' : 'No conversations yet. Ask something to start one.'}</p>}
        {groupThreads(shown, new Date()).map((g) => (
          <section key={g.label} className={s.group} aria-label={g.label}>
            <h3 className={s.groupLabel}>{g.label}</h3>
            {g.threads.map((t) => (
              <PopoverClose asChild key={t.id}>
                <button type="button" className={s.row} aria-current={t.id === threadId ? 'true' : undefined} onClick={() => onOpen(t.id)}>
                  <span className={s.rowTitle}>{threadTitle(t)}</span>
                  <span className={s.rowMeta}>{turnsLabel(t)}</span>
                </button>
              </PopoverClose>
            ))}
          </section>
        ))}
      </div>
    </Popover>
  );
}
