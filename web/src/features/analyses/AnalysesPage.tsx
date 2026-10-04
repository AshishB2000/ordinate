// /analyses?project=<id> — the project's dashboards (legacy analyses.ts +
// anList.ts). Internally each is an `analysis` record; the UI calls it a
// dashboard (docs/analysis/00-model.md). A card grid, because a dashboard is
// mostly pictures: each card previews its first sheet's first one or two
// visuals, drawn by the shared chart engine from the server's figures.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { useDatasets } from '../../api/datasets';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { ago } from '../../app/when';
import { Button, IconButton, buttonClass } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Menu } from '../../ui/Menu';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { openDockWith } from '../assistant/dockState';
import { ProjectGate } from '../import/ProjectGate';
import { toastMovedToTrash } from '../projects/trashToast';
import { failure, useGallery, type GalleryItem } from './api';
import { DraftFlow } from './DraftReview';
import { NewWizard } from './NewWizard';
import { VisualTileBody } from './VisualTile';
import s from './Analyses.module.css';

const NO_FILTERS: never[] = [];
const NO_PARAMS: never[] = [];

/** How many build-intent chips the empty state offers (anList.ts AN_CHIP_MAX). */
const CHIP_MAX = 3;

function Preview({ projectId, item }: { projectId: string; item: GalleryItem }) {
  if (!item.previews.length) {
    // A first sheet with no visual cards gets the section's own bar motif.
    return (
      <span className={`${s.prev} ${s.prevNone}`} aria-hidden="true">
        <span className={s.bars}>
          <span className={s.bar2} />
          <span className={s.bar4} />
          <span className={s.bar3} />
        </span>
      </span>
    );
  }
  return (
    <span className={item.previews.length > 1 ? `${s.prev} ${s.prev2}` : s.prev} aria-hidden="true">
      {item.previews.map((v) => (
        <span key={v.id} className={s.thumb}>
          <VisualTileBody projectId={projectId} def={v} filters={NO_FILTERS} params={NO_PARAMS} thumb />
        </span>
      ))}
    </span>
  );
}

function Card({ projectId, item, onRename, onDelete }: { projectId: string; item: GalleryItem; onRename: () => void; onDelete: () => void }) {
  const navigate = useNavigate();
  const open = `/analyses/${projectId}/${item.id}`;
  const sheets = `${item.sheetCount} ${item.sheetCount === 1 ? 'sheet' : 'sheets'}`;
  return (
    <li className={s.card}>
      <Link className={s.body} to={open}>
        <Preview projectId={projectId} item={item} />
        <span className={s.name}>{item.name || 'Untitled dashboard'}</span>
        <span className={s.meta}>
          {sheets} · Updated {ago(item.updatedAt)}
        </span>
      </Link>
      <span className={s.menu}>
        <Menu
          label={`${item.name} options`}
          align="end"
          trigger={<IconButton icon="more-horizontal" label="Dashboard options" size="sm" />}
          items={[
            { label: 'Open', icon: 'layout-dashboard', onSelect: () => void navigate(open) },
            { label: 'Rename', icon: 'pencil', onSelect: onRename },
            { label: 'History', icon: 'history', onSelect: () => void navigate(`/versions/${projectId}/dashboard/${item.id}`) },
            { kind: 'separator' },
            { label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete },
          ]}
        />
      </span>
    </li>
  );
}

function Gallery({ projectId }: { projectId: string }) {
  const q = useGallery(projectId);
  const datasets = useDatasets(projectId);
  const client = useQueryClient();
  const [wizard, setWizard] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [renaming, setRenaming] = useState<GalleryItem | null>(null);
  const [name, setName] = useState('');
  const refresh = () => void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });

  const rename = async () => {
    const item = renaming;
    setRenaming(null);
    if (!item) return;
    try {
      const r = (await rpc('analysis:rename', { projectId, id: item.id, name: name.trim() || item.name })) as { ok: boolean; error?: string };
      if (!r.ok) toast(failure(r, 'The dashboard could not be renamed.'), { kind: 'error' });
    } catch (err) {
      toast(failure(err, 'The dashboard could not be renamed.'), { kind: 'error' });
    }
    refresh();
  };
  // To the Trash, with Undo on the toast — which is why there is no confirm.
  const remove = async (item: GalleryItem) => {
    let reply: { ok?: boolean } | null = null;
    try {
      reply = (await rpc('analysis:delete', { projectId, id: item.id })) as { ok?: boolean };
    } catch {
      reply = null;
    }
    toastMovedToTrash(client, { projectId, type: 'dashboard', id: item.id, name: item.name }, reply);
    refresh();
  };

  const count = q.data?.length ?? 0;
  const actions = (
    <div className={s.actions}>
      <Link className={buttonClass('ghost')} to={`/data/metrics?project=${projectId}`}>
        <Icon name="target" />
        <span>Metrics</span>
      </Link>
      <Button icon="sparkles" onClick={() => setDrafting(true)}>
        Draft with the Assistant
      </Button>
      <Button variant="primary" icon="plus" onClick={() => setWizard(true)}>
        Create dashboard
      </Button>
    </div>
  );

  let body;
  if (q.isPending) {
    body = (
      <ul className={s.grid} role="status" aria-busy="true" aria-label="Loading dashboards">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className={s.card} aria-hidden="true">
            <Skeleton className={s.skPrev} />
            <Skeleton className={s.skLine} />
            <Skeleton className={s.skMeta} />
          </li>
        ))}
      </ul>
    );
  } else if (q.isError) {
    body = <ErrorState title="Dashboards could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  } else if (count === 0) {
    const sets = (datasets.data ?? []).slice(0, CHIP_MAX);
    body = (
      <EmptyState
        icon="layout-dashboard"
        title="No dashboards yet"
        actions={
          <>
            <Button variant="primary" size="lg" onClick={() => setWizard(true)}>
              Create dashboard
            </Button>
            <Button variant="ghost" size="lg" icon="sparkles" onClick={() => openDockWith('Build me a dashboard from my data')}>
              Draft with the Assistant
            </Button>
          </>
        }
      >
        A dashboard is where you build: sheets of charts, metrics and text over your datasets. Start from a blank sheet, or describe what you want and
        let the Assistant draft the sheets, charts and calculated fields — you review all of it before anything is created.
      </EmptyState>
    );
    if (sets.length) {
      body = (
        <>
          {body}
          <div className={s.chips} aria-label="Start from your data">
            {sets.map((d) => {
              const text = `Build an overview of ${d.name || 'my data'}`;
              return (
                <button key={d.id} type="button" className={s.chip} onClick={() => openDockWith(text)}>
                  {text}
                </button>
              );
            })}
          </div>
        </>
      );
    }
  } else {
    body = (
      <ul className={s.grid} aria-label="Dashboards">
        {q.data.map((item) => (
          <Card
            key={item.id}
            projectId={projectId}
            item={item}
            onRename={() => {
              setName(item.name);
              setRenaming(item);
            }}
            onDelete={() => void remove(item)}
          />
        ))}
      </ul>
    );
  }

  return (
    <Page title="Analyses" sub="The dashboards you author: sheets of charts, metrics and text over your datasets.">
      <div className={s.head}>
        {count > 0 ? <span className={s.count}>{count === 1 ? '1 dashboard' : `${count} dashboards`}</span> : <span />}
        {actions}
      </div>
      {body}
      {wizard && <NewWizard projectId={projectId} onClose={() => setWizard(false)} />}
      {drafting && <DraftFlow projectId={projectId} onClose={() => setDrafting(false)} />}
      <Dialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        size="sm"
        title="Rename dashboard"
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" onClick={() => void rename()}>
              Save
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
        </form>
      </Dialog>
    </Page>
  );
}

export default function AnalysesPage() {
  return (
    <ProjectGate title="Analyses" why="Dashboards belong to a project.">
      {(projectId) => <Gallery key={projectId} projectId={projectId} />}
    </ProjectGate>
  );
}
