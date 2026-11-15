// The dock's History: every conversation in the project, behind the header's
// clock. The title's dropdown holds the few most recent; this is the rest —
// searchable by title, grouped by when each was last touched. The list, its
// order and the turn counts are the server's (`copilot:threads`), a page at a
// time with "Load more" under it (`MoreThreads`, the wide page's list too); the
// search filters the TITLES loaded so far.

import { useRef, useState } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Popover, PopoverClose } from '../../ui/Popover';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { threadTitle, turnsLabel, useThreads, type Threads, type ThreadSummary } from './api';
import { agentName } from './agents';
import type { ThreadAct } from './ThreadActions';
import a from './Agent.module.css';
import s from './DockList.module.css';

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

/** Under a list of conversations: "Load more" while the server has older ones, and that page's own loading and error states. */
export function MoreThreads({ threads, className }: { threads: Threads; className?: string }) {
  if (threads.isFetchingNextPage) return <SkeletonRows rows={3} label="Loading more conversations" />;
  if (threads.isFetchNextPageError) {
    return <ErrorState compact heading={3} title="More conversations could not load" message="Check your connection and try again." onRetry={() => void threads.fetchNextPage()} />;
  }
  if (!threads.hasNextPage) return null;
  return (
    <Button size="sm" variant="ghost" icon="chevron-down" block className={className} onClick={() => void threads.fetchNextPage()}>
      Load more
    </Button>
  );
}

/** What a list of conversations says when it shows none: a search that matched nothing (older ones may be unloaded yet), or no conversation at all. */
export function noneText(needle: string, more: boolean): string {
  if (!needle) return 'No conversations yet. Ask something to start one.';
  return more ? 'None of these match. Load more to search older ones.' : 'No conversation matches that search.';
}

export interface HistoryProps {
  projectId: string | null;
  /** The conversation on screen, marked in the list. */
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (id: string) => void;
  /** Rename or delete a row's conversation (ThreadActions.tsx asks, then does it). */
  onAct: (act: ThreadAct) => void;
  /** This person may use an Assistant agent: every row names who it was with, the Project assistant too. */
  showAgents?: boolean;
}

/** Which Assistant a conversation was with (docs/assistant-agents, "History"). */
export function AgentTag({ t, line }: { t: ThreadSummary; /** Under the title (the page's column), not a pill beside it. */ line?: boolean }) {
  const on = !!t.agentId && !t.agentGone;
  return (
    <span className={[line ? a.lineAgent : a.rowAgent, on && (line ? a.lineAgentOn : a.rowAgentOn)].filter(Boolean).join(' ')} data-testid="history-agent">
      {agentName(t)}
    </span>
  );
}

export function History({ projectId, threadId, open, onOpenChange, onOpen, onAct, showAgents }: HistoryProps) {
  const threads = useThreads(projectId, open);
  const [query, setQuery] = useState('');
  // A row's action closes this and opens a dialog: focus belongs to the dialog's
  // field then, not back on the clock (which would pull it out from under the dialog).
  const handingOff = useRef(false);
  const act = (a: ThreadAct) => {
    handingOff.current = true;
    onAct(a);
  };
  const needle = query.trim().toLowerCase();
  const shown = (threads.data ?? []).filter((t) => threadTitle(t).toLowerCase().includes(needle));
  return (
    <Popover
      title="Conversation history"
      align="end"
      className={s.popover}
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery('');
        onOpenChange(o);
      }}
      onCloseAutoFocus={(e) => {
        if (handingOff.current) e.preventDefault();
        handingOff.current = false;
      }}
      trigger={<IconButton icon="history" size="sm" label="Conversation history" disabled={!projectId} />}
    >
      <Input size="sm" icon="search" aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className={s.list}>
        {threads.isPending && <SkeletonRows rows={4} label="Loading conversations" />}
        {threads.isError && !threads.isFetchNextPageError && (
          <ErrorState compact heading={3} title="Conversations could not load" message="Check your connection and try again." onRetry={() => void threads.refetch()} />
        )}
        {threads.data && shown.length === 0 && <p className={s.empty}>{noneText(needle, threads.hasNextPage)}</p>}
        {groupThreads(shown, new Date()).map((g) => (
          <section key={g.label} className={s.group} aria-label={g.label}>
            <h3 className={s.groupLabel}>{g.label}</h3>
            {g.threads.map((t) => (
              // The row opens the conversation; its two actions sit beside it (a button cannot hold buttons) and show on hover or focus.
              <div key={t.id} className={s.rowWrap} data-testid="history-row">
                <PopoverClose asChild>
                  <button type="button" className={s.row} aria-current={t.id === threadId ? 'true' : undefined} onClick={() => onOpen(t.id)}>
                    <span className={s.rowTitle}>{threadTitle(t)}</span>
                    {(showAgents || t.agentId) && <AgentTag t={t} />}
                    <span className={s.rowMeta}>{turnsLabel(t)}</span>
                  </button>
                </PopoverClose>
                <span className={s.rowActions}>
                  <PopoverClose asChild>
                    <IconButton icon="pencil" size="sm" label={`Rename ${threadTitle(t)}`} onClick={() => act({ kind: 'rename', thread: { id: t.id, title: threadTitle(t) } })} />
                  </PopoverClose>
                  <PopoverClose asChild>
                    <IconButton icon="trash" size="sm" label={`Delete ${threadTitle(t)}`} onClick={() => act({ kind: 'delete', thread: { id: t.id, title: threadTitle(t) } })} />
                  </PopoverClose>
                </span>
              </div>
            ))}
          </section>
        ))}
        <MoreThreads threads={threads} className={s.more} />
      </div>
    </Popover>
  );
}
