// /dashboards?project=<id> — the project's one list of dashboards (docs/superpowers/specs/2026-10-29-dashboard-drafts-
// publish-design.md). Every dashboard is a draft only editors and admins see until it is published, so an editor gets
// two tabs: Published (published ones, a badge on those with edits not live yet) and Drafts (never published). A
// viewer's gallery holds published dashboards only — the server's rule — so they get the grid alone, with no tab and
// nothing to create. `?tab=` keeps the tab; `?new=1[&dataset=<id>]` opens the new-dashboard wizard (the palette's New
// dashboard, a dataset page's), and the old Analyses address sends both here.

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { useDatasets } from '../../../api/datasets';
import { ErrorState, Page } from '../../../app/blocks';
import { Skeleton } from '../../../ui/Skeleton';
import { Tab, TabList, TabPanel, Tabs } from '../../../ui/Tabs';
import { toast } from '../../../ui/Toast';
import { useAiStatus } from '../../assistant/api';
import { AI_NOT_READY } from '../../assistant/AiNotReady';
import { failure, useGallery, type Analysis, type GalleryItem, type OpenReply } from '../../analyses/api';
import { DraftFlow } from '../../analyses/DraftReview';
import { NewWizard } from '../../analyses/NewWizard';
import { useTags, type TagIndex } from '../../data/api';
import { LineageDrawer } from '../../data/LineageDrawer';
import { TagFilterBar, tagsOf, useActiveTag } from '../../data/tags';
import { useCanEdit } from '../../projects/api';
import { toastMovedToTrash } from '../../projects/trashToast';
import { CreateActions } from './CreateActions';
import { DashboardCard, editPath, nameOf, refOf, type CardAsk } from './DashboardCard';
import { DeleteDialog, RenameDialog, UnpublishDialog } from './ListDialogs';
import { EmptyTab, FirstDashboard, NothingPublished } from './ListEmpty';
import a from '../../analyses/Analyses.module.css';
import s from './List.module.css';

type TabId = 'published' | 'drafts';

function Loading() {
  return (
    <ul className={a.grid} role="status" aria-busy="true" aria-label="Loading dashboards">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className={a.card} aria-hidden="true">
          <Skeleton className={a.skPrev} />
          <Skeleton className={a.skLine} />
          <Skeleton className={a.skMeta} />
        </li>
      ))}
    </ul>
  );
}

/** A grid of cards under the tag filter bar (catalogUi.ts ctAfterPaint): the tags these cards carry, one pressed, in `?tag=`. */
function Grid({ label, items, tags, ...card }: {
  label: string;
  items: readonly GalleryItem[];
  tags: TagIndex | undefined;
  projectId: string;
  canEdit: boolean;
  onAsk: (what: CardAsk, item: GalleryItem) => void;
}) {
  const [tag, setTag] = useActiveTag();
  const tagged = (item: GalleryItem) => tagsOf(tags, refOf(item)).map((t) => t.name);
  const present = [...new Set(items.flatMap(tagged))];
  const shown = tag ? items.filter((item) => tagged(item).includes(tag)) : items;
  return (
    <>
      <TagFilterBar present={present} index={tags} active={tag} onPick={setTag} empty={shown.length === 0} />
      <ul className={a.grid} aria-label={label}>
        {shown.map((item) => (
          <DashboardCard key={item.id} item={item} tags={tags} {...card} />
        ))}
      </ul>
    </>
  );
}

/** "Duplicate": the draft as it stands, as a new draft — `analysis:create` from `analysis:open`, as Save mine as a copy does. */
async function duplicate(projectId: string, item: GalleryItem): Promise<Analysis> {
  const open = (await rpc('analysis:open', { projectId, id: item.id })) as OpenReply;
  if (!open.ok) throw new Error(failure(open, 'The dashboard could not be read.'));
  const d = open.analysis;
  const made = (await rpc('analysis:create', {
    projectId, name: `${d.name || 'Untitled dashboard'} (copy)`.slice(0, 200), sheets: d.sheets, filters: d.filters, parameters: d.parameters, style: d.style,
  })) as Analysis | { ok: false; error: string };
  if (!('id' in made)) throw new Error(failure(made, 'The copy could not be made.'));
  return made;
}

export function DashboardList({ projectId }: { projectId: string }) {
  const q = useGallery(projectId);
  const datasets = useDatasets(projectId);
  const tags = useTags(projectId);
  const key = useAiStatus();
  const client = useQueryClient();
  const navigate = useNavigate();
  // Creating, renaming, publishing and deleting are an editor's; a viewer opens and reads.
  const canEdit = useCanEdit(projectId);
  const [params, setParams] = useSearchParams();
  const [wizard, setWizard] = useState<{ datasetId?: string } | null>(() => (params.get('new') ? { datasetId: params.get('dataset') ?? undefined } : null));
  useEffect(() => {
    if (!params.get('new')) return;
    // Also when the page is already on screen (the palette's New dashboard from here): open it, then strip the ask.
    setWizard({ datasetId: params.get('dataset') ?? undefined });
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete('new');
        n.delete('dataset');
        return n;
      },
      { replace: true },
    );
  }, [params, setParams]);
  const [drafting, setDrafting] = useState<{ datasetId?: string } | null>(null);
  const [asked, setAsked] = useState<{ what: Exclude<CardAsk, 'duplicate'>; item: GalleryItem } | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });

  const items = q.data ?? [];
  const published = items.filter((d) => d.status !== 'draft');
  const drafts = items.filter((d) => d.status === 'draft');
  const want = params.get('tab');
  // Published by default; with none published yet, the drafts are what there is to see.
  const tab: TabId = want === 'published' || want === 'drafts' ? want : !published.length && drafts.length ? 'drafts' : 'published';
  const pick = (t: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set('tab', t);
        return n;
      },
      { replace: true },
    );

  const onAsk = (what: CardAsk, item: GalleryItem) => {
    if (what !== 'duplicate') return setAsked({ what, item });
    duplicate(projectId, item).then(
      (made) => {
        refresh();
        pick('drafts');
        toast(`“${made.name}” is a new draft.`, { kind: 'success', action: { label: 'Open', onClick: () => void navigate(editPath(projectId, made.id)) } });
      },
      (err: unknown) => toast(failure(err, 'The dashboard could not be duplicated.'), { kind: 'error' }),
    );
  };
  // To the Trash after a confirm; the toast still carries Undo.
  const remove = async (item: GalleryItem) => {
    setAsked(null);
    let reply: { ok?: boolean } | null = null;
    try {
      reply = (await rpc('analysis:delete', { projectId, id: item.id })) as { ok?: boolean };
    } catch {
      reply = null;
    }
    toastMovedToTrash(client, { projectId, type: 'dashboard', id: item.id, name: item.name }, reply);
    refresh();
  };

  // The Assistant's doors are shut, and say why, until a model is connected (execMenu.ts gateAssistantDoors).
  const aiReady = !!key.data?.ready;
  const aiWhy = key.isPending ? 'Checking whether a model is set up…' : AI_NOT_READY;
  const grid = { tags: tags.data, projectId, canEdit, onAsk };

  let body;
  if (q.isPending) body = <Loading />;
  else if (q.isError) body = <ErrorState title="Dashboards could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (!items.length && canEdit) {
    body = (
      <FirstDashboard projectId={projectId} ai={key.data} aiWhy={aiWhy} datasets={datasets.data ?? []} onCreate={() => setWizard({})} onDraft={(datasetId) => setDrafting({ datasetId })} />
    );
  } else if (!items.length) body = <NothingPublished />;
  else if (!canEdit) body = <Grid label="Dashboards" items={items} {...grid} />;
  else {
    body = (
      <Tabs value={tab} onValueChange={pick}>
        <TabList label="Dashboards">
          <Tab value="published" count={String(published.length)}>
            Published
          </Tab>
          <Tab value="drafts" count={String(drafts.length)}>
            Drafts
          </Tab>
        </TabList>
        <TabPanel value="published">
          <div className={s.panel}>{published.length ? <Grid label="Published dashboards" items={published} {...grid} /> : <EmptyTab which="published" />}</div>
        </TabPanel>
        <TabPanel value="drafts">
          <div className={s.panel}>{drafts.length ? <Grid label="Draft dashboards" items={drafts} {...grid} /> : <EmptyTab which="drafts" />}</div>
        </TabPanel>
      </Tabs>
    );
  }

  // With nothing authored (not while loading, nor on an error) the empty panel holds Create and Draft with AI.
  return (
    <Page
      title="Dashboards"
      sub={canEdit ? 'Every dashboard starts as a draft that only editors and admins see. Publish it to show it to everyone in the project.' : 'The dashboards published in this project.'}
      actions={canEdit && q.data?.length !== 0 && <CreateActions projectId={projectId} aiReady={aiReady} aiWhy={aiWhy} onCreate={() => setWizard({})} onDraft={() => setDrafting({})} />}
    >
      {body}
      {wizard && canEdit && <NewWizard projectId={projectId} datasetId={wizard.datasetId} initialStep={wizard.datasetId ? 2 : 1} onClose={() => setWizard(null)} />}
      {drafting && canEdit && <DraftFlow projectId={projectId} datasetId={drafting.datasetId} onClose={() => setDrafting(null)} />}
      {asked?.what === 'lineage' && <LineageDrawer projectId={projectId} type="dashboard" id={asked.item.id} name={nameOf(asked.item)} onClose={() => setAsked(null)} />}
      {asked?.what === 'rename' && <RenameDialog projectId={projectId} item={asked.item} onDone={refresh} onClose={() => setAsked(null)} />}
      {asked?.what === 'unpublish' && <UnpublishDialog projectId={projectId} item={asked.item} onClose={() => setAsked(null)} />}
      {asked?.what === 'delete' && <DeleteDialog item={asked.item} onConfirm={() => void remove(asked.item)} onClose={() => setAsked(null)} />}
    </Page>
  );
}
