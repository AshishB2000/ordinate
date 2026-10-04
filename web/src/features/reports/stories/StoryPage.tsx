// /stories/:projectId/:storyId — one scrolling document at reading width, a
// left outline built from its headings, edited in place (storyPage.ts).
// Saving is a debounced autosave, undo/redo the dashboards' stack (⌘Z / ⇧⌘Z),
// and there is always an empty text line at the end to type into. Every chart
// and metric is the server's, fetched for the whole page in one call.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { ErrorState, PageSkeleton } from '../../../app/blocks';
import { Button, IconButton, buttonClass } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Menu } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { storyOutline } from '../../../../../src/analysis/storyText.ts';
import { useAdoptProject } from '../../projects/current';
import { failure, type MetricFigure, type Step, type Story, type StoryBlock, type VisualFigure } from '../api';
import { exportStory } from '../export/generate';
import { useGenerateHooks } from '../export/useGenerate';
import type { PickKind } from './BlockPicker';
import { ChooseMetrics, ChooseVisual, PinFilter, chooseImage } from './Choosers';
import { historyNew, historyPush, historyRedo, historyUndo, redoLabel, undoLabel, type History } from './history';
import { Present } from './Present';
import { StoryBlockRow } from './StoryBlock';
import s from './Story.module.css';

type Snap = { name: string; blocks: StoryBlock[] };
type Pending = { kind: 'visual' | 'metric' | 'metrics_row'; place: (b: StoryBlock) => void } | { kind: 'pin'; blockId: string; datasetId: string } | null;

const newId = () => crypto.randomUUID();

/** Always an empty text line at the end — the page never ends on a chart. */
export function withTail(blocks: StoryBlock[]): StoryBlock[] {
  const last = blocks[blocks.length - 1];
  return last && last.kind === 'text' && last.text.trim() === '' ? blocks : [...blocks, { id: newId(), kind: 'text', text: '' }];
}

/** What story:figures needs of the page: its chart and metric blocks, nothing else. */
type FigureReq = { id: string; kind: 'visual' | 'metric' | 'metrics_row'; visualId?: string; metricId?: string; metricIds?: string[]; filters: Step[] };
function figureBlocks(blocks: StoryBlock[]): FigureReq[] {
  return blocks.flatMap((b): FigureReq[] =>
    b.kind === 'visual' ? [{ id: b.id, kind: b.kind, visualId: b.visualId, filters: b.filters }]
      : b.kind === 'metric' ? [{ id: b.id, kind: b.kind, metricId: b.metricId, filters: b.filters }]
        : b.kind === 'metrics_row' ? [{ id: b.id, kind: b.kind, metricIds: b.metricIds, filters: b.filters }] : [],
  );
}

function Editor({ projectId, story, focusEnd }: { projectId: string; story: Story; focusEnd: boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [snap, setSnap] = useState<Snap>(() => ({ name: story.name, blocks: withTail(story.blocks) }));
  const [hist, setHist] = useState<History<Snap>>(() => historyNew(snap));
  const [editing, setEditing] = useState(() => (focusEnd ? snap.blocks[snap.blocks.length - 1].id : ''));
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [presenting, setPresenting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [armed, setArmed] = useState('');
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  const { hooks, dialog } = useGenerateHooks();

  // ── saving: debounced, and flushed before leaving ──
  const latest = useRef(snap);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    try {
      const r = (await rpc('story:update', { projectId, id: story.id, name: latest.current.name, blocks: latest.current.blocks })) as { id?: string };
      setStatus(r && r.id ? 'Saved' : 'Could not save');
      void client.invalidateQueries({ queryKey: ['story:list', projectId] });
    } catch {
      setStatus('Could not save');
    }
  }, [client, projectId, story.id]);
  useEffect(() => () => void flush(), [flush]);

  const commit = (next: Snap, label: string, coalesce = false) => {
    const tailed = { ...next, blocks: withTail(next.blocks) };
    setSnap(tailed);
    latest.current = tailed;
    setHist((h) => historyPush(h, label, tailed, Date.now(), coalesce));
    dirty.current = true;
    setStatus('Saving…');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
  };
  const setBlocks = (blocks: StoryBlock[], label: string, coalesce = false) => commit({ ...snap, blocks }, label, coalesce);
  const step = (dir: 'undo' | 'redo') => {
    const r = dir === 'undo' ? historyUndo(hist) : historyRedo(hist);
    if (!r) return;
    setHist(r.h);
    setSnap(r.h.present.snap);
    latest.current = r.h.present.snap;
    setEditing('');
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
    toast(`${dir === 'undo' ? 'Undid' : 'Redid'} ${r.label.toLowerCase()}`);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || presenting) return;
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT') return; // the field's own undo
      e.preventDefault();
      step(e.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── the page's figures, one call ──
  const figKey = useMemo(() => figureBlocks(snap.blocks), [snap.blocks]);
  const figures = useQuery({
    queryKey: ['story:figures', projectId, figKey],
    queryFn: figKey.length
      ? async () => ((await rpc('story:figures', { projectId, blocks: figKey })) as { blocks: Record<string, VisualFigure | MetricFigure> }).blocks
      : skipToken,
    placeholderData: (prev) => prev,
  });

  // ── making blocks ──
  const make = async (kind: PickKind, place: (b: StoryBlock) => void, fallback?: () => void) => {
    const id = newId();
    if (kind === 'text') return place({ id, kind: 'text', text: '' });
    if (kind === 'heading') return place({ id, kind: 'text', text: '## ' });
    if (kind === 'divider') return place({ id, kind: 'divider' });
    if (kind === 'callout') return place({ id, kind: 'callout', tone: 'info', text: '' });
    if (kind === 'image') {
      const img = await chooseImage();
      if (img && 'error' in img) toast(img.error, { kind: 'error' });
      if (img && 'src' in img) return place({ id, kind: 'image', src: img.src, alt: img.alt });
      return fallback?.();
    }
    setPending({ kind, place });
  };
  const insertAfter = (afterId: string, b: StoryBlock) => {
    const i = snap.blocks.findIndex((x) => x.id === afterId);
    const blocks = snap.blocks.slice();
    blocks.splice(i < 0 ? blocks.length : i + 1, 0, b);
    setBlocks(blocks, 'Add block');
    if (b.kind === 'text' || b.kind === 'callout') setEditing(b.id);
  };
  const replace = (id: string, b: StoryBlock) => {
    setBlocks(snap.blocks.map((x) => (x.id === id ? b : x)), 'Add ' + b.kind.replace('_', ' '));
    setEditing(b.kind === 'text' || b.kind === 'callout' ? b.id : '');
  };
  const move = (id: string, to: number) => {
    const from = snap.blocks.findIndex((b) => b.id === id);
    if (from < 0) return;
    const blocks = snap.blocks.slice();
    const [b] = blocks.splice(from, 1);
    blocks.splice(Math.max(0, Math.min(to, blocks.length)), 0, b);
    setBlocks(blocks, 'Move block');
  };

  const outline = storyOutline(snap.blocks);
  const doExport = async () => {
    await flush();
    toast('Building the PDF…');
    const out = await exportStory(projectId, story.id, snap.name, hooks);
    if (out.ok) toast(`Downloaded ${out.filename}`, { kind: 'success' });
    else if (!out.cancelled) toast(out.error || 'Couldn’t build the PDF.', { kind: 'error' });
  };
  const remove = async () => {
    clearTimeout(timer.current);
    dirty.current = false;
    try {
      await rpc('story:delete', { projectId, id: story.id });
      void client.invalidateQueries({ queryKey: ['story:list', projectId] });
      void navigate(`/reports?project=${projectId}&tab=stories`);
    } catch (err) {
      toast(failure(err, 'Could not delete the story.'), { kind: 'error' });
    }
  };

  return (
    <div className={s.storyPage}>
      <header className={s.head}>
        <Link className={buttonClass('ghost', 'sm')} to={`/reports?project=${projectId}&tab=stories`} onClick={() => void flush()}>
          <Icon name="arrow-left" />
          <span>Stories</span>
        </Link>
        <h1 className={s.nameH}>
          <input
          className={s.nameInput}
          aria-label="Story name"
          value={snap.name}
          maxLength={200}
          onChange={(e) => commit({ ...snap, name: e.target.value }, 'Rename', true)}
          onBlur={() => !snap.name.trim() && commit({ ...snap, name: 'Untitled story' }, 'Rename')}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        </h1>
        <span className={s.status} role="status">{status}</span>
        <div className={s.headActions}>
          <IconButton icon="undo" label={undoLabel(hist) ? `Undo ${undoLabel(hist).toLowerCase()}` : 'Nothing to undo'} disabled={!undoLabel(hist)} onClick={() => step('undo')} />
          <IconButton icon="redo" label={redoLabel(hist) ? `Redo ${redoLabel(hist).toLowerCase()}` : 'Nothing to redo'} disabled={!redoLabel(hist)} onClick={() => step('redo')} />
          <Button icon="maximize" onClick={() => void flush().then(() => setPresenting(true))}>
            Present
          </Button>
          <Button variant="primary" icon="download" onClick={() => void doExport()}>
            Export PDF
          </Button>
          <Menu label="Story options" align="end" trigger={<IconButton icon="more-horizontal" label="Story options" />} items={[{ label: 'Delete story', icon: 'trash', danger: true, onSelect: () => setConfirmDelete(true) }]} />
        </div>
      </header>
      <div className={s.layout}>
        <nav className={s.outline} aria-label="Outline">
          <div className={s.outlineTitle}>Outline</div>
          {outline.length ? (
            <ul>
              {outline.map((h, i) => (
                <li key={i} className={s[`ol${h.level}`]}>
                  <button type="button" title={h.text} onClick={() => document.getElementById(`st-b-${h.blockId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.outlineEmpty}>Headings you write (# or ##) appear here.</p>
          )}
        </nav>
        <article className={s.doc} aria-label={snap.name}>
          {snap.blocks.map((b, i) => (
            <div
              key={b.id}
              className={[s.dragRow, drop?.id === b.id && (drop.before ? s.dropBefore : s.dropAfter)].filter(Boolean).join(' ')}
              draggable={armed === b.id}
              onDragStart={(e) => (armed === b.id ? e.dataTransfer.setData('text/x-story-block', b.id) : e.preventDefault())}
              onDragEnd={() => {
                setArmed('');
                setDrop(null);
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('text/x-story-block')) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDrop({ id: b.id, before: e.clientY < r.top + r.height / 2 });
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData('text/x-story-block');
                e.preventDefault();
                setDrop(null);
                if (!id || id === b.id) return;
                const from = snap.blocks.findIndex((x) => x.id === id);
                const before = drop?.before ?? true;
                const target = i + (before ? 0 : 1);
                move(id, from < target ? target - 1 : target);
              }}
            >
              <StoryBlockRow
                projectId={projectId}
                block={b}
                index={i}
                count={snap.blocks.length}
                editing={editing === b.id}
                figure={figures.data?.[b.id]}
                figuresPending={figures.isPending || figures.isFetching}
                onChange={(nb, label, coalesce) => setBlocks(snap.blocks.map((x) => (x.id === b.id ? nb : x)), label, coalesce)}
                onEdit={setEditing}
                onEndEdit={() => setEditing((cur) => (cur === b.id ? '' : cur))}
                onAddAfter={(kind) => void make(kind, (nb) => insertAfter(b.id, nb))}
                onPickInto={(kind) =>
                  void make(
                    kind,
                    (nb) => (nb.kind === 'text' ? replace(b.id, { ...nb, id: b.id }) : replace(b.id, nb)),
                    () => replace(b.id, { id: b.id, kind: 'text', text: '' }),
                  )
                }
                onMove={(to) => move(b.id, to)}
                onDuplicate={() => insertAfter(b.id, { ...structuredClone(b), id: newId() })}
                onRemove={() => setBlocks(snap.blocks.filter((x) => x.id !== b.id), 'Delete block')}
                onBackspaceEmpty={() => {
                  if (i === 0 || i === snap.blocks.length - 1) return;
                  const prev = snap.blocks[i - 1];
                  setBlocks(snap.blocks.filter((x) => x.id !== b.id), 'Delete block');
                  setEditing(prev.kind === 'text' ? prev.id : '');
                }}
                onPin={() => {
                  const f = figures.data?.[b.id] as VisualFigure | undefined;
                  if (f && !('missing' in f)) setPending({ kind: 'pin', blockId: b.id, datasetId: f.datasetId });
                }}
                onDragHandle={(on) => setArmed(on ? b.id : '')}
              />
            </div>
          ))}
        </article>
      </div>
      {pending?.kind === 'visual' && (
        <ChooseVisual
          projectId={projectId}
          onDone={(visualId) => {
            const p = pending;
            setPending(null);
            if (visualId) p.place({ id: newId(), kind: 'visual', visualId, filters: [] });
          }}
        />
      )}
      {(pending?.kind === 'metric' || pending?.kind === 'metrics_row') && (
        <ChooseMetrics
          projectId={projectId}
          max={pending.kind === 'metrics_row' ? 4 : 1}
          onDone={(ids) => {
            const p = pending;
            setPending(null);
            if (!ids.length) return;
            p.place(p.kind === 'metric' || ids.length === 1 ? { id: newId(), kind: 'metric', metricId: ids[0], filters: [] } : { id: newId(), kind: 'metrics_row', metricIds: ids, filters: [] });
          }}
        />
      )}
      {pending?.kind === 'pin' && (
        <PinFilter
          projectId={projectId}
          datasetId={pending.datasetId}
          onDone={(stepDef: Step | null) => {
            const p = pending;
            setPending(null);
            if (!stepDef) return;
            setBlocks(snap.blocks.map((x) => (x.id === p.blockId && x.kind === 'visual' ? { ...x, filters: [...x.filters, stepDef] } : x)), 'Pin filter');
          }}
        />
      )}
      {presenting && <Present projectId={projectId} name={snap.name} blocks={snap.blocks} figures={figures.data ?? {}} onExit={() => setPresenting(false)} />}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        size="sm"
        title="Delete this story?"
        description={`“${snap.name}” will be deleted. The charts and metrics it shows are not.`}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      />
      {dialog}
    </div>
  );
}

export default function StoryPageRoute() {
  const { projectId = '', storyId = '' } = useParams();
  const [params] = useSearchParams();
  useAdoptProject(projectId);
  const q = useQuery({
    queryKey: ['story:get', projectId, storyId],
    queryFn: async () => (await rpc('story:get', { projectId, id: storyId })) as Story | null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError || !q.data) {
    return (
      <div className={s.storyPage}>
        <ErrorState title="That story could not be opened" message={q.isError ? q.error.message : 'It may have been deleted.'} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  return <Editor key={storyId} projectId={projectId} story={q.data} focusEnd={params.get('focus') === 'end'} />;
}
