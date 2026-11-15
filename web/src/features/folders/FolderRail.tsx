// The folder rail beside Data and Dashboards (docs/team-folders, "What you will see"): All, Everyone in the project and
// its subfolders, then the top-level folders the caller opens, nested. A folder an admin sees only as an admin wears a
// lock and says so. Each row filters the list (`?folder=`), takes a drop of an item (→ the Move dialog, preset), and —
// where the caller may — carries New subfolder, Rename and Delete.

import { useState, type DragEvent } from 'react';
import { IconButton } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { childrenOf, editsFolder, EVERYONE, folderOfItem, type FolderNode, type FolderTree, type PlacedKind } from './api';
import { DeleteFolderDialog, depthOf, NewFolderDialog, parentsFor, RenameFolderDialog } from './FolderDialogs';
import type { Movable } from './MoveDialog';
import s from './Folders.module.css';

/** What a dragged row carries (a dataset row, a dashboard card). */
export const DRAG_TYPE = 'application/x-ordinate-item';

export function dragItem(e: DragEvent, item: Movable): void {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
  e.dataTransfer.effectAllowed = 'move';
}

function dropped(e: DragEvent): Movable | null {
  try {
    const v = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as Movable;
    return v && (v.kind === 'dataset' || v.kind === 'dashboard') && typeof v.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

interface Props {
  projectId: string;
  tree: FolderTree;
  kind: PlacedKind;
  /** Every item of the list (ids), for the counts. */
  ids: readonly string[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** An item dropped onto a folder the caller may add to. */
  onDrop?: (item: Movable, to: string) => void;
  /** "All datasets", "All dashboards". */
  allLabel: string;
}

type Ask = { what: 'new'; parent: string | null } | { what: 'rename' | 'delete'; folder: FolderNode };

export function FolderRail({ projectId, tree, kind, ids, selected, onSelect, onDrop, allLabel }: Props) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const counts = new Map<string, number>();
  for (const id of ids) {
    const f = folderOfItem(tree, projectId, kind, id);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const canMake = parentsFor(tree, projectId).length > 0;
  const mayChange = (f: FolderNode) => (f.parentId === null ? tree.admin : f.level === 'edit' || f.level === 'manage');
  const anyLocked = tree.folders.some((f) => f.adminOnly);

  const drop = (to: string) =>
    onDrop && editsFolder(tree, projectId, to)
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOver(to);
          },
          onDragLeave: () => setOver((o) => (o === to ? null : o)),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            setOver(null);
            const item = dropped(e);
            if (item) onDrop(item, to);
          },
        }
      : {};

  const row = (id: string | null, name: string, icon: IconName, depth: number, node?: FolderNode) => {
    const key = id ?? 'all';
    const n = id === null ? ids.length : (counts.get(id) ?? 0);
    const menu: MenuEntry[] = [];
    if (node && editsFolder(tree, projectId, node.id) && depthOf(tree, projectId, node.id) < 5) menu.push({ label: 'New subfolder…', icon: 'plus', onSelect: () => setAsk({ what: 'new', parent: node.id }) });
    if (!node && id === projectId && editsFolder(tree, projectId, projectId)) menu.push({ label: 'New subfolder…', icon: 'plus', onSelect: () => setAsk({ what: 'new', parent: projectId }) });
    if (node && mayChange(node)) {
      menu.push({ label: 'Rename…', icon: 'pencil', onSelect: () => setAsk({ what: 'rename', folder: node }) });
      menu.push({ kind: 'separator' }, { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setAsk({ what: 'delete', folder: node }) });
    }
    return (
      <li key={key} className={s.node} data-drop={over === key ? '1' : undefined} {...(id ? drop(id) : {})}>
        <button
          type="button"
          className={s.nodeBtn}
          data-depth={depth || undefined}
          aria-current={selected === id ? 'true' : undefined}
          aria-label={`${name} (${n})${node?.adminOnly ? ', admin access' : ''}`}
          title={node?.adminOnly ? `${name}: you see it as a project admin. No team of yours was given it.` : name}
          onClick={() => onSelect(id)}
        >
          <span className={s.nodeIc}>
            <Icon name={icon} size={16} />
          </span>
          <span className={s.nodeName}>{name}</span>
          {node?.adminOnly && (
            <span className={s.nodeLock}>
              <Icon name="lock" size={12} />
            </span>
          )}
          <span className={s.nodeCount}>{n}</span>
        </button>
        {menu.length > 0 && (
          <span className={s.nodeMenu}>
            <Menu label={`${name} options`} align="end" trigger={<IconButton icon="more-horizontal" size="sm" label={`${name} options`} />} items={menu} />
          </span>
        )}
      </li>
    );
  };

  const nested = (parent: string, depth: number): ReturnType<typeof row>[] =>
    childrenOf(tree, parent).flatMap((f) => [row(f.id, f.name, 'folder', depth, f), ...nested(f.id, depth + 1)]);

  return (
    <nav className={s.rail} aria-label="Folders">
      <div className={s.railHead}>
        <h2 className={s.railTitle}>Folders</h2>
        {canMake && <IconButton icon="plus" size="sm" label="New folder" onClick={() => setAsk({ what: 'new', parent: selected && selected !== projectId ? selected : tree.admin ? null : projectId })} />}
      </div>
      <ul className={s.railList}>
        {row(null, allLabel, 'layers', 0)}
        {row(projectId, EVERYONE, 'home', 0)}
        {nested(projectId, 1)}
      </ul>
      {childrenOf(tree, null).length > 0 && <div className={s.railRule} role="presentation" />}
      <ul className={s.railList}>{childrenOf(tree, null).flatMap((f) => [row(f.id, f.name, 'folder', 0, f), ...nested(f.id, 1)])}</ul>
      {anyLocked && (
        <p className={s.railFoot}>
          <Icon name="lock" size={12} /> Admin access: no team of yours was given it, so its members don’t see you there.
        </p>
      )}
      {ask?.what === 'new' && <NewFolderDialog projectId={projectId} tree={tree} parent={ask.parent} onClose={() => setAsk(null)} onMade={(id) => id && onSelect(id)} />}
      {ask?.what === 'rename' && <RenameFolderDialog projectId={projectId} folder={ask.folder} onClose={() => setAsk(null)} />}
      {ask?.what === 'delete' && <DeleteFolderDialog projectId={projectId} tree={tree} folder={ask.folder} onClose={() => setAsk(null)} onDeleted={() => selected === ask.folder.id && onSelect(null)} />}
    </nav>
  );
}
