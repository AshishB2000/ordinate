// One card on the Dashboards page: the gallery's preview, the name, a badge only where it says something the tab does
// not ("Edits not live"), and plain meta. A published dashboard opens on its view page, a draft in the editor. An
// editor's ⋯ holds every way on; a viewer gets only Copy link (their gallery holds published dashboards alone).

import { Link, useNavigate } from 'react-router';
import { ago } from '../../../app/when';
import { Badge } from '../../../ui/Badge';
import { IconButton } from '../../../ui/Button';
import { Menu, type MenuEntry } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import type { GalleryItem } from '../../analyses/api';
import { GalleryPreview } from '../../analyses/GalleryPreview';
import type { TagIndex } from '../../data/api';
import { TagChips, tagsOf } from '../../data/tags';
import { displayName } from '../../home/homeText';
import a from '../../analyses/Analyses.module.css';

/** A dashboard's catalog ref (src/app/catalog.ts: the record kind is `analysis`). */
export const refOf = (item: GalleryItem) => `analysis:${item.id}`;
export const viewPath = (projectId: string, id: string) => `/dashboards/${projectId}/${id}`;
export const editPath = (projectId: string, id: string) => `/analyses/${projectId}/${id}`;
export const nameOf = (item: GalleryItem) => item.name || 'Untitled dashboard';

/** What the card's ⋯ asks of the page: the steps that need a dialog or a write. */
export type CardAsk = 'duplicate' | 'rename' | 'lineage' | 'unpublish' | 'delete';

/** "2 sheets · Published Oct 27 by Ana" for what readers see; "2 sheets · Edited 5 min ago" for a draft or unpublished edits. */
export function metaOf(item: GalleryItem): string {
  const sheets = `${item.sheetCount} ${item.sheetCount === 1 ? 'sheet' : 'sheets'}`;
  if (item.status !== 'published') return `${sheets} · Edited ${ago(item.updatedAt)}`;
  const by = item.publishedBy ? ` by ${displayName(item.publishedBy) || item.publishedBy}` : '';
  return `${sheets} · Published ${ago(item.publishedAt ?? item.updatedAt)}${by}`;
}

function editorMenu(projectId: string, item: GalleryItem, go: (to: string) => void, ask: (what: CardAsk) => void): MenuEntry[] {
  const live = item.status !== 'draft';
  const view = viewPath(projectId, item.id);
  return [
    ...(live ? [{ label: 'Open published', icon: 'eye' as const, onSelect: () => go(view) }] : []),
    { label: 'Edit', icon: 'pencil', onSelect: () => go(editPath(projectId, item.id)) },
    { label: 'Preview', icon: 'monitor', onSelect: () => go(`${view}?draft=1`) },
    { kind: 'separator' },
    { label: 'Duplicate', icon: 'copy', onSelect: () => ask('duplicate') },
    { label: 'Rename', icon: 'type-text', onSelect: () => ask('rename') },
    { label: 'History', icon: 'history', onSelect: () => go(`/versions/${projectId}/dashboard/${item.id}`) },
    { label: 'Lineage', icon: 'lineage', onSelect: () => ask('lineage') },
    { kind: 'separator' },
    ...(live ? [{ label: 'Unpublish…', icon: 'eye-off' as const, onSelect: () => ask('unpublish') }] : []),
    { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => ask('delete') },
  ];
}

function CopyLink({ projectId, item }: { projectId: string; item: GalleryItem }) {
  const copy = () =>
    navigator.clipboard.writeText(`${window.location.origin}${viewPath(projectId, item.id)}`).then(
      () => toast('Link copied', { kind: 'success' }),
      () => toast('The clipboard is not available here.', { kind: 'error' }),
    );
  return <IconButton icon="link" size="sm" label={`Copy link to ${nameOf(item)}`} onClick={() => void copy()} />;
}

export function DashboardCard({ projectId, item, tags, canEdit, onAsk }: {
  projectId: string;
  item: GalleryItem;
  tags: TagIndex | undefined;
  canEdit: boolean;
  onAsk: (what: CardAsk, item: GalleryItem) => void;
}) {
  const navigate = useNavigate();
  const name = nameOf(item);
  return (
    <li className={a.card}>
      <Link className={a.body} to={item.status === 'draft' ? editPath(projectId, item.id) : viewPath(projectId, item.id)}>
        <GalleryPreview projectId={projectId} item={item} />
        <span className={a.name}>{name}</span>
        <span className={a.meta}>
          {item.status === 'edited' && <Badge tone="warn">Edits not live</Badge>}
          <span>{metaOf(item)}</span>
        </span>
        <TagChips tags={tagsOf(tags, refOf(item))} />
      </Link>
      <span className={a.menu}>
        {canEdit ? (
          <Menu
            label={`${name} options`}
            align="end"
            trigger={<IconButton icon="more-horizontal" label={`${name} options`} size="sm" />}
            items={editorMenu(projectId, item, (to) => void navigate(to), (what) => onAsk(what, item))}
          />
        ) : (
          <CopyLink projectId={projectId} item={item} />
        )}
      </span>
    </li>
  );
}
