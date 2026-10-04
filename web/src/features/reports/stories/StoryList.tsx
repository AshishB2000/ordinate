// The Stories tab (storyList.ts): a card per story — a page of prose drawn
// small, its title, the first line of prose, its length and last edit — plus
// New story and Draft with the Assistant. Opening a card opens the story page.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { EmptyState, ErrorState } from '../../../app/blocks';
import { shortTime } from '../../../app/when';
import { Button, IconButton } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Menu } from '../../../ui/Menu';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { failure, useStories, type Story, type StorySummary } from '../api';
import { DraftStory } from './DraftStory';
import s from '../Reports.module.css';

type Ask = { kind: 'new' } | { kind: 'rename'; story: StorySummary } | { kind: 'delete'; story: StorySummary } | null;

export function StoryList({ projectId }: { projectId: string }) {
  const q = useStories(projectId);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [ask, setAsk] = useState<Ask>(null);
  const [name, setName] = useState('');
  const [drafting, setDrafting] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: ['story:list', projectId] });
  const open = (id: string, focusEnd = false) => void navigate(`/stories/${projectId}/${id}${focusEnd ? '?focus=end' : ''}`);

  const submit = async () => {
    const a = ask;
    setAsk(null);
    try {
      if (a?.kind === 'new') {
        const r = (await rpc('story:create', { projectId, name: name.trim() || 'Untitled story' })) as Story | { ok: false; error: string };
        if (!('id' in r)) throw new Error(failure(r, 'Could not create the story.'));
        open(r.id, true);
      } else if (a?.kind === 'rename' && name.trim()) {
        await rpc('story:update', { projectId, id: a.story.id, name: name.trim() });
      } else if (a?.kind === 'delete') {
        await rpc('story:delete', { projectId, id: a.story.id });
        toast(`Deleted “${a.story.name}”`);
      }
    } catch (err) {
      toast(failure(err, 'That did not work.'), { kind: 'error' });
    }
    refresh();
  };

  const actions = (
    <div className={s.barActions}>
      <Button icon="sparkles" onClick={() => setDrafting(true)}>
        Draft with the Assistant
      </Button>
      <Button
        variant="primary"
        icon="plus"
        onClick={() => {
          setName('Untitled story');
          setAsk({ kind: 'new' });
        }}
      >
        New story
      </Button>
    </div>
  );

  let body;
  if (q.isPending) {
    body = (
      <ul className={s.grid} aria-busy="true" aria-label="Loading stories">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className={s.card} aria-hidden="true">
            <Skeleton className={s.skBand} />
            <Skeleton className={s.skLine} />
            <Skeleton className={s.skMeta} />
          </li>
        ))}
      </ul>
    );
  } else if (q.isError) {
    body = <ErrorState title="Stories could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  } else if (!q.data.length) {
    body = (
      <EmptyState icon="type-text" title="No stories yet" actions={actions}>
        A story is a document you read top to bottom: your words, with live charts and metrics where they make the point. Type <kbd>/</kbd> on an empty line to
        add one. Present it section by section, or export it as a PDF.
      </EmptyState>
    );
  } else {
    body = (
      <ul className={s.grid} aria-label="Stories">
        {q.data.map((st) => (
          <li key={st.id} className={s.card} data-story-id={st.id}>
            <button type="button" className={s.cardOpen} onClick={() => open(st.id)} aria-label={`Open ${st.name}`}>
              <span className={s.band}>
                <span className={s.prose} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
              </span>
              <span className={s.cardBody}>
                <span className={s.cardName}>{st.name || 'Untitled story'}</span>
                <span className={s.excerpt}>{st.excerpt || 'No prose yet'}</span>
                <span className={s.cardLine}>
                  {st.blockCount === 1 ? '1 block' : `${st.blockCount} blocks`} · Edited {shortTime(st.updatedAt)}
                </span>
              </span>
            </button>
            <span className={s.cardMenu}>
              <Menu
                label={`${st.name} options`}
                align="end"
                trigger={<IconButton icon="more-horizontal" label="Story actions" size="sm" />}
                items={[
                  { label: 'Open', icon: 'file-text', onSelect: () => open(st.id) },
                  {
                    label: 'Rename',
                    icon: 'pencil',
                    onSelect: () => {
                      setName(st.name);
                      setAsk({ kind: 'rename', story: st });
                    },
                  },
                  { kind: 'separator' },
                  { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setAsk({ kind: 'delete', story: st }) },
                ]}
              />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  const del = ask?.kind === 'delete';
  return (
    <div className={s.tab}>
      {!!q.data?.length && (
        <div className={s.bar}>
          <span className={s.count}>{q.data.length === 1 ? '1 story' : `${q.data.length} stories`}</span>
          {actions}
        </div>
      )}
      {body}
      <Dialog
        open={ask !== null}
        onOpenChange={(o) => !o && setAsk(null)}
        size="sm"
        title={ask?.kind === 'new' ? 'Name the story' : ask?.kind === 'rename' ? 'Rename story' : 'Delete this story?'}
        description={del ? `“${ask.story.name}” will be deleted. The charts and metrics it shows are not.` : undefined}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant={del ? 'danger' : 'primary'} onClick={() => void submit()}>
              {ask?.kind === 'new' ? 'Create' : ask?.kind === 'rename' ? 'Rename' : 'Delete'}
            </Button>
          </>
        }
      >
        {!del && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
          </form>
        )}
      </Dialog>
      {drafting && <DraftStory projectId={projectId} onClose={() => setDrafting(false)} onBuilt={(id) => open(id)} />}
    </div>
  );
}
