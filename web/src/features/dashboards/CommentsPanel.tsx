// Comments (legacy commentPanel.ts + commentDoors.ts): the side panel, either
// ONE target's threads (a card, the dashboard) or every thread on the open
// dashboard, its cards and the visuals they draw, with Open / Resolved / All.
// Bodies are Markdown (the text card's subset, never HTML). The author on every
// comment is the signed-in user — the server writes it from the session; the
// browser never sends a name — and only the author may edit or delete.

import { useState, type ReactNode } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Drawer } from '../../ui/Dialog';
import { Textarea } from '../../ui/Field';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { ago } from '../../app/when';
import type { Card } from '../analyses/api';
import type { EditorApi } from '../analyses/editor/context';
import type { CommentTarget } from './useViewer';
import { MarkdownView } from './Markdown';
import { reason, threadsOn, useCommentWrite, useComments, useCommentsLive, type Comment, type TargetKind } from './api';
import { jumpToCard } from './SummaryBody';
import s from './Comments.module.css';

const plain = (name: string) => ({ text: `{{${name}}}` });

function Avatar({ name }: { name: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className={s.avatar} style={{ background: `hsl(${h} 55% 45%)` }} aria-hidden="true">
      {(name[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** An open dashboard, for the panel's "all threads" mode and its jumps. */
export interface DashboardScope {
  analysisId: string;
  cards: ReadonlySet<string>;
  visuals: ReadonlySet<string | undefined>;
  jump(cardId: string): void;
}

/** Every thread the open dashboard owns: its own, its cards', and the visuals its cards draw. */
function dashboardThreads(list: Comment[], d: DashboardScope): Comment[] {
  return list.filter(
    (c) => !c.deletedAt && ((c.target.kind === 'analysis' && c.target.id === d.analysisId) || (c.target.kind === 'card' && d.cards.has(c.target.id)) || (c.target.kind === 'visual' && d.visuals.has(c.target.id))),
  );
}

/** A target's pins, numbered in creation order (commentStore.ts cmtPins) — drawn by the chart engine's annotations. */
export function pinsOn(list: Comment[] | undefined, kind: TargetKind, id: string) {
  return threadsOn(list, kind, id)
    .filter((c) => c.target.point?.label !== undefined)
    .map((c, i) => ({ n: i + 1, id: c.id, label: String(c.target.point?.label), ...(c.target.point?.series ? { series: String(c.target.point.series) } : {}), ...(c.resolvedAt ? { resolved: true } : {}) }));
}

/** `?comment=<kind>:<id>` — a link (Home's "Recent comments") that opens a thread on arrival. */
export function linkedThread(): { kind: TargetKind; id: string } | null {
  const v = new URLSearchParams(window.location.search).get('comment') ?? '';
  const m = /^(analysis|card|visual|dataset|story):([0-9a-f-]{36})$/i.exec(v);
  return m ? { kind: m[1] as TargetKind, id: m[2]!.toLowerCase() } : null;
}

/**
 * A page head's door — the visual builder, a dataset, a story (commentDoors.ts
 * cmtHeadButton): the open-thread count, and that record's threads in the panel.
 */
export function CommentDoor({ projectId, kind, id, disabledReason }: { projectId: string; kind: TargetKind; id: string | undefined; disabledReason?: string }) {
  const q = useComments(projectId);
  useCommentsLive(projectId);
  const [open, setOpen] = useState(() => {
    const l = linkedThread();
    return !!id && !!l && l.kind === kind && l.id === id;
  });
  const threads = id ? threadsOn(q.data?.comments, kind, id) : [];
  const n = threads.filter((c) => !c.resolvedAt).length;
  const label = !id ? (disabledReason ?? 'Comments') : n ? `${n} open comment${n === 1 ? '' : 's'}` : threads.length ? 'Comments — all resolved' : 'Comments';
  return (
    <>
      <Button size="sm" variant="ghost" icon="message-square" disabled={!id} title={label} aria-label={label} onClick={() => setOpen(true)}>
        {n > 0 ? String(n) : 'Comments'}
      </Button>
      {open && id && <CommentsDrawer projectId={projectId} target={{ kind, id }} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A card head's door: the open-thread count, the panel on click. */
export function CommentButton({ ed, card }: { ed: EditorApi; card: Card }) {
  const q = useComments(ed.projectId);
  const threads = threadsOn(q.data?.comments, 'card', card.id);
  const open = threads.filter((c) => !c.resolvedAt).length;
  const label = open ? `${open} open comment${open === 1 ? '' : 's'}` : threads.length ? 'Comments — all resolved' : 'Comment on this';
  return (
    <button type="button" className={open ? `${s.cmtBtn} ${s.cmtOn}` : s.cmtBtn} aria-label={label} title={label} onClick={() => ed.view.openComments({ kind: 'card', id: card.id })}>
      <Icon name="message-square" size={12} />
      {open > 0 && <span className={s.cmtCount}>{open}</span>}
    </button>
  );
}

function Thread({ c, projectId, onJump, targetName }: { c: Comment; projectId: string; onJump?: () => void; targetName?: string }) {
  const write = useCommentWrite(projectId);
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const run = (v: Parameters<typeof write.mutate>[0], after?: () => void) =>
    write.mutate(v, { onSuccess: after, onError: (e) => toast(reason(e, 'Could not save the comment.'), { kind: 'error' }) });
  const pid = projectId;
  return (
    <li className={c.resolvedAt ? `${s.thread} ${s.resolved}` : s.thread} aria-label={`Comment by ${c.author}`}>
      <div className={s.threadHead}>
        <Avatar name={c.author} />
        <span className={s.author}>{c.author}</span>
        <span className={s.when}>
          {ago(c.createdAt)}
          {c.updatedAt ? ' · edited' : ''}
        </span>
        {c.resolvedAt && <span className={s.badge}>Resolved</span>}
      </div>
      {c.target.point?.label && <div className={s.pin}>On {c.target.point.label}</div>}
      {onJump && targetName && (
        <button type="button" className={s.onTarget} onClick={onJump}>
          on {targetName}
        </button>
      )}
      {editing !== null ? (
        <form
          className={s.composer}
          onSubmit={(e) => {
            e.preventDefault();
            if (editing.trim()) run({ channel: 'comment:edit', input: { projectId: pid, id: c.id, body: editing.trim() } }, () => setEditing(null));
          }}
        >
          <Textarea label="Edit comment" value={editing} onChange={(e) => setEditing(e.target.value)} rows={3} autoFocus />
          <div className={s.composerRow}>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!editing.trim()}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <div className={s.cmtBody}>
          <MarkdownView text={c.body} token={plain} />
        </div>
      )}
      {c.replies
        .filter((r) => !r.deletedAt)
        .map((r) => (
          <div key={r.id} className={s.reply}>
            <div className={s.threadHead}>
              <Avatar name={r.author} />
              <span className={s.author}>{r.author}</span>
              <span className={s.when}>{ago(r.createdAt)}</span>
              {r.mine && <IconButton icon="trash" size="sm" label="Delete reply" onClick={() => run({ channel: 'comment:deleteReply', input: { projectId: pid, id: c.id, replyId: r.id } })} />}
            </div>
            <div className={s.cmtBody}>
              <MarkdownView text={r.body} token={plain} />
            </div>
          </div>
        ))}
      <div className={s.threadActions}>
        {c.resolvedAt ? (
          <Button size="sm" variant="ghost" icon="rotate-ccw" onClick={() => run({ channel: 'comment:reopen', input: { projectId: pid, id: c.id } })}>
            Reopen
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon="check" onClick={() => run({ channel: 'comment:resolve', input: { projectId: pid, id: c.id } })}>
            Resolve
          </Button>
        )}
        {c.mine && editing === null && (
          <Button size="sm" variant="ghost" icon="pencil" onClick={() => setEditing(c.body)}>
            Edit
          </Button>
        )}
        {c.mine && (
          <Button
            size="sm"
            variant={armed ? 'danger' : 'ghost'}
            icon="trash"
            onClick={() => {
              if (!armed) {
                setArmed(true);
                setTimeout(() => setArmed(false), 4000);
                return;
              }
              run({ channel: 'comment:delete', input: { projectId: pid, id: c.id } });
            }}
          >
            {armed ? 'Delete thread?' : 'Delete'}
          </Button>
        )}
      </div>
      {!c.resolvedAt && (
        <form
          className={s.replyForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) run({ channel: 'comment:reply', input: { projectId: pid, id: c.id, body: reply.trim() } }, () => setReply(''));
          }}
        >
          <Textarea
            label="Reply"
            value={reply}
            rows={1}
            placeholder="Reply…"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
          />
          {reply.trim() && (
            <Button size="sm" type="submit">
              Reply
            </Button>
          )}
        </form>
      )}
    </li>
  );
}

/** The open dashboard's panel: its target is the viewer's (a card door, the head's Comments, a pin). */
export function CommentsPanel({ ed }: { ed: EditorApi }) {
  const target = ed.view.comments;
  if (!target) return null;
  const scope: DashboardScope = {
    analysisId: ed.analysisId,
    cards: new Set(ed.doc.sheets.flatMap((p) => p.cards.map((c) => c.id))),
    visuals: new Set(ed.doc.sheets.flatMap((p) => p.cards.map((c) => c.visualId))),
    jump: (cardId) => jumpToCard(ed, cardId),
  };
  const card = target !== 'all' && target.kind === 'card' ? ed.doc.sheets.flatMap((p) => p.cards).find((c) => c.id === target.id) : undefined;
  return <CommentsDrawer projectId={ed.projectId} target={target} dashboard={scope} title={target === 'all' ? 'Comments on this dashboard' : card ? 'Comments on this card' : undefined} onClose={() => ed.view.openComments(null)} />;
}

const KIND_TITLE: Record<TargetKind, string> = { analysis: 'Comments on this dashboard', card: 'Comments on this card', visual: 'Comments on this visual', dataset: 'Comments on this dataset', story: 'Comments on this story' };

export function CommentsDrawer({ projectId, target, dashboard, title: titleIn, onClose }: { projectId: string; target: NonNullable<CommentTarget>; dashboard?: DashboardScope; title?: string; onClose: () => void }) {
  const q = useComments(projectId);
  const write = useCommentWrite(projectId);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  // A ⌘-click on a mark pins the new comment to that point; × posts it on the card instead.
  const [pin, setPin] = useState(target !== 'all' ? target.point : undefined);
  const all = target === 'all' && !!dashboard;
  const list = q.data?.comments ?? [];
  const one = target === 'all' ? { kind: 'analysis' as const, id: dashboard?.analysisId ?? '' } : target;
  const threads = all && dashboard ? dashboardThreads(list, dashboard) : threadsOn(list, one.kind, one.id);
  const counts = { open: threads.filter((c) => !c.resolvedAt).length, resolved: threads.filter((c) => c.resolvedAt).length, all: threads.length };
  const shown = all ? threads.filter((c) => (filter === 'all' ? true : filter === 'open' ? !c.resolvedAt : !!c.resolvedAt)) : [...threads.filter((c) => !c.resolvedAt), ...threads.filter((c) => c.resolvedAt)];
  const name = (c: Comment) => q.data?.targets[`${c.target.kind}:${c.target.id}`]?.name;
  const title = titleIn ?? KIND_TITLE[one.kind];
  const composeTarget = target === 'all' ? one : { kind: target.kind, id: target.id, ...(pin ? { point: pin } : {}) };
  const post = () => {
    if (!draft.trim()) return;
    write.mutate(
      { channel: 'comment:add', input: { projectId, target: composeTarget, body: draft.trim() } },
      { onSuccess: () => setDraft(''), onError: (e) => toast(reason(e, 'Could not save the comment.'), { kind: 'error' }) },
    );
  };
  let body: ReactNode;
  if (q.isPending) body = <SkeletonRows rows={3} label="Loading comments" />;
  else if (q.isError) body = <ErrorState compact heading={3} title="Could not read the comments" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (!shown.length) {
    body =
      all && filter === 'resolved' ? (
        <EmptyState compact heading={3} icon="circle-check" title="Nothing resolved yet">
          Threads you resolve move here, and can be reopened.
        </EmptyState>
      ) : all && filter === 'open' && counts.resolved ? (
        <EmptyState compact heading={3} icon="check" title="All caught up">
          Every thread on this dashboard is resolved.
        </EmptyState>
      ) : (
        <EmptyState compact heading={3} icon="message-square" title="No comments yet — start the discussion">
          Ask a question, flag a number or leave a note for whoever opens this next.
        </EmptyState>
      );
  } else {
    body = (
      <ul className={s.threads} aria-label="Threads">
        {shown.map((c) => (
          <Thread
            key={c.id}
            c={c}
            projectId={projectId}
            targetName={all && c.target.kind !== 'analysis' ? name(c) : undefined}
            onJump={all && dashboard && c.target.kind === 'card' ? () => dashboard.jump(c.target.id) : undefined}
          />
        ))}
      </ul>
    );
  }
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      footer={
        <form
          className={s.composer}
          onSubmit={(e) => {
            e.preventDefault();
            post();
          }}
        >
          {pin && (
            <span className={s.pinChip}>
              <Icon name="map-pin" size={12} /> Pinned to {pin.label}
              {pin.series ? ` · ${pin.series}` : ''}
              <IconButton icon="x" size="sm" label="Unpin" onClick={() => setPin(undefined)} />
            </span>
          )}
          <Textarea
            label="New comment"
            value={draft}
            rows={3}
            placeholder={all ? 'Comment on this dashboard' : pin ? 'What about this point?' : 'Add a comment'}
            hint="Markdown works. ⌘↩ to post."
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                post();
              }
            }}
          />
          <div className={s.composerRow}>
            <Button variant="primary" type="submit" disabled={!draft.trim()} loading={write.isPending}>
              Post
            </Button>
          </div>
        </form>
      }
    >
      {all && (
        <div className={s.cmtFilter} role="radiogroup" aria-label="Show">
          {(['open', 'resolved', 'all'] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? `${s.seg} ${s.segOn}` : s.seg} onClick={() => setFilter(f)}>
              {f === 'open' ? 'Open' : f === 'resolved' ? 'Resolved' : 'All'} <span className={s.segCount}>{counts[f]}</span>
            </button>
          ))}
        </div>
      )}
      {body}
    </Drawer>
  );
}
