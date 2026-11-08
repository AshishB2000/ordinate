// The Assistant full width (/assistant): the SAME Assistant as the dock — its
// conversations, transcript, answer cards, composer, verified answers and
// suggestions (useConversation.ts, Conversation.tsx) — given the page, so a
// wide chart is not squeezed into 340px. Not a second assistant: the dock's
// expand button opens its conversation here, and "Back to the side panel"
// hands this one back to the dock. While this page is on screen the dock is
// not drawn beside it (DockParts.tsx).
//
// Its chrome: a header (the conversation's name, the model, new, ⋯, back) and
// the project's conversations down the left, searchable by title and grouped
// by the day each was last touched (History.tsx groupThreads). Below 900px the
// column gives way to the dock's own dropdown in the header. The open
// conversation is in the URL (`?thread=`), so a reload or a way back to it
// opens it again; an id that is not one is ignored.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { useMe } from '../auth/api';
import { displayName, greeting, plural } from '../home/homeText';
import { useCurrentProject } from '../projects/current';
import { threadTitle, useThreads } from './api';
import { ConversationBody, ConversationDialogs } from './Conversation';
import { DockMenu, ModelPicker, ThreadMenu, useBackToDock } from './DockParts';
import { UUID } from './dockRoute';
import { rememberPageThread } from './dockState';
import { groupThreads, History } from './History';
import { useConversation, type Conversation } from './useConversation';
import w from './Wide.module.css';

/** The project's conversations, newest-touched first (the server's order), the open one marked. Titles only are searched. */
function Conversations({ c }: { c: Conversation }) {
  const threads = useThreads(c.pid, true);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = (threads.data ?? []).filter((t) => threadTitle(t).toLowerCase().includes(needle));
  return (
    <aside className={w.list} aria-label="Conversations">
      <div className={w.search}>
        <Input icon="search" aria-label="Search conversations" placeholder="Search conversations" value={query} disabled={!c.pid} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {(c.project.loading || (c.pid && threads.isPending)) && <SkeletonRows rows={6} label="Loading conversations" />}
      {threads.isError && <ErrorState compact heading={3} title="Conversations could not load" message="Check your connection and try again." onRetry={() => void threads.refetch()} />}
      {(threads.data || (!c.pid && !c.project.loading)) && shown.length === 0 && (
        <div className={w.listEmpty}>
          <Icon name={needle ? 'search' : 'message-square'} size={20} />
          <p className={w.listEmptyTitle}>{needle ? 'No conversation matches that search' : 'No conversations yet'}</p>
          <p>{needle ? 'Titles are searched, not what was said.' : 'Ask something and it is kept here, to come back to.'}</p>
        </div>
      )}
      {groupThreads(shown, new Date()).map((g) => (
        <section key={g.label} className={w.group} aria-label={g.label}>
          <h2 className={w.groupLabel}>{g.label}</h2>
          {g.threads.map((t) => (
            <button key={t.id} type="button" className={w.row} aria-current={t.id === c.shownThread ? 'true' : undefined} title={threadTitle(t)} onClick={() => c.switchThread(t.id)}>
              {threadTitle(t)}
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}

export default function AssistantPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('thread') ?? '';
  const c = useConversation('page', UUID.test(asked) ? { projectId: null, id: asked } : null);
  const me = useMe();
  const row = useCurrentProject().projects.find((p) => p.id === c.pid);
  const back = useBackToDock();

  // The open conversation: in the URL (replacing, so Back still leaves the page), and kept for the dock.
  const { pid, shownThread } = c;
  useEffect(() => {
    if (!pid || !shownThread) return;
    rememberPageThread(pid, shownThread);
    if (params.get('thread') !== shownThread) setParams({ thread: shownThread }, { replace: true });
  }, [pid, shownThread, params, setParams]);

  const intro = (
    <div className={w.intro}>
      <p className={w.greet}>{greeting(displayName(me.data?.user?.email), new Date().getHours())}</p>
      <p className={w.line}>
        {row ? `${row.name} · ${plural(row.datasets, 'dataset')} · ${plural(row.dashboards, 'dashboard')}. ` : ''}
        Ask a question, or say what to build.
      </p>
    </div>
  );

  return (
    <>
      <section className={w.page} ref={c.panel} tabIndex={-1} aria-labelledby="assistant-h">
        <header className={w.head}>
          <div className={w.crumb}>
            <Icon name="sparkles" />
            <h1 id="assistant-h" className={w.name}>
              Assistant
            </h1>
            <span className={w.sep} aria-hidden="true">
              /
            </span>
            <span className={w.title} data-testid="assistant-title">
              {c.title}
            </span>
            {/* Narrow: no column of conversations, so the name is the dock's dropdown of them. */}
            <span className={w.titleMenu}>
              <ThreadMenu projectId={c.pid} threadId={c.shownThread} title={c.title} onOpen={c.switchThread} onAll={() => c.setHistoryOpen(true)} />
            </span>
          </div>
          <span className={w.model}>
            <ModelPicker status={c.status.data} />
          </span>
          <Button size="sm" icon="plus" aria-label="New conversation" disabled={!c.pid || !!c.pending} onClick={() => void c.startNew()}>
            <span className={w.newLabel}>New conversation</span>
          </Button>
          <span className={w.narrowOnly}>
            <History projectId={c.pid} threadId={c.shownThread} open={c.historyOpen} onOpenChange={c.setHistoryOpen} onOpen={c.switchThread} onAct={c.setAct} />
          </span>
          <DockMenu status={c.status.data} isAdmin={c.isAdmin} turns={c.turns} thread={c.shownThread && !c.pending ? { id: c.shownThread, title: c.title } : null} onAct={c.setAct} />
          <IconButton icon="minimize" size="sm" label="Back to the side panel" onClick={back} />
        </header>
        <div className={w.body}>
          <Conversations c={c} />
          <ConversationBody c={c} layout="page" intro={intro} />
        </div>
      </section>
      <ConversationDialogs c={c} />
    </>
  );
}
