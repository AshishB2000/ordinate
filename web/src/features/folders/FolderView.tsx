// A list with folders (Data's datasets, the Dashboards page): the rail on the left when the project has a folder
// besides Everyone, the list filtered to the folder picked (`?folder=`), a tag on each row seen under All, the heading
// above a folder's items with who it is shared with, a designed empty folder, and the Move dialog. Without folders
// none of it shows and the list is as it was.

import { useState, type ReactNode } from 'react';
import { EmptyState } from '../../ui/States';
import { Icon } from '../../ui/icons/Icon';
import { byId, editsFolder, EVERYONE, folderOfItem, grantsLine, hasFolders, pathOf, useFolderParam, useFolderTree, type FolderTree, type PlacedKind } from './api';
import { FolderRail } from './FolderRail';
import { MoveDialog, type Movable } from './MoveDialog';
import s from './Folders.module.css';

export interface FolderView {
  projectId: string;
  kind: PlacedKind;
  tree: FolderTree | undefined;
  /** The project has a folder besides Everyone (and Postgres). */
  has: boolean;
  /** The folder picked in the rail; null: All. */
  selected: string | null;
  setSelected: (id: string | null) => void;
  folderOf: (id: string) => string;
  /** The items in the folder picked (all of them under All). */
  filter: <T>(items: readonly T[], idOf: (x: T) => string) => T[];
  /** May the caller move this item (Edit where it is)? */
  canMove: (id: string) => boolean;
  /** Where a new item made here should land: the folder picked when the caller adds to it. */
  landing: string | undefined;
  move: (items: Movable[], to?: string) => void;
  /** The Move dialog, when one is open: render it once. */
  dialog: ReactNode;
}

export function useFolderView(projectId: string, kind: PlacedKind): FolderView {
  const tree = useFolderTree(projectId).data;
  const has = hasFolders(tree);
  const [asked, setSelected] = useFolderParam();
  const selected = has && asked && (asked === projectId || byId(tree).has(asked)) ? asked : null;
  const [moving, setMoving] = useState<{ items: Movable[]; to?: string } | null>(null);
  const folderOf = (id: string) => folderOfItem(tree, projectId, kind, id);
  return {
    projectId,
    kind,
    tree,
    has,
    selected,
    setSelected,
    folderOf,
    filter: (items, idOf) => (selected ? items.filter((x) => folderOf(idOf(x)) === selected) : [...items]),
    canMove: (id) => has && editsFolder(tree, projectId, folderOf(id)),
    landing: has && selected && selected !== projectId && editsFolder(tree, projectId, selected) ? selected : undefined,
    move: (items, to) => setMoving({ items, to }),
    dialog: moving && tree && <MoveDialog projectId={projectId} tree={tree} items={moving.items} to={moving.to} onClose={() => setMoving(null)} />,
  };
}

/** The list beside its rail, or the list alone when the project has no folders. */
export function FolderLayout({ view, ids, allLabel, children }: { view: FolderView; ids: readonly string[]; allLabel: string; children: ReactNode }) {
  if (!view.has || !view.tree) return <>{children}</>;
  return (
    <div className={s.layout}>
      <FolderRail
        projectId={view.projectId}
        tree={view.tree}
        kind={view.kind}
        ids={ids}
        selected={view.selected}
        onSelect={view.setSelected}
        onDrop={(item, to) => view.canMove(item.id) && view.move([item], to)}
        allLabel={allLabel}
      />
      <div className={s.main}>
        <FolderHeading view={view} />
        {children}
      </div>
      {view.dialog}
    </div>
  );
}

/** Above a folder's items: where you are, and who it opens to. */
function FolderHeading({ view }: { view: FolderView }) {
  if (!view.selected || !view.tree) return null;
  if (view.selected === view.projectId) {
    return (
      <div className={s.crumbs}>
        <span className={s.crumbName}>{EVERYONE}</span>
        <span>· Every project member, at their project role</span>
      </div>
    );
  }
  const chain = pathOf(view.tree, view.selected);
  const root = chain[0]?.parentId === null ? chain[0] : undefined;
  return (
    <div className={s.crumbs}>
      {chain.map((f, i) => (
        <span key={f.id} className={i === chain.length - 1 ? s.crumbName : undefined}>
          {i > 0 && <span className={s.crumbSep}>/ </span>}
          {f.name}
        </span>
      ))}
      <span>· {root ? grantsLine(root) : `Opens like ${EVERYONE}`}</span>
      {chain.some((f) => f.adminOnly) && (
        <span className={s.tag}>
          <Icon name="lock" size={12} /> Admin access
        </span>
      )}
    </div>
  );
}

/** Under All, where a row's item sits (nothing for Everyone). */
export function FolderTag({ view, id }: { view: FolderView; id: string }) {
  if (!view.has || view.selected || !view.tree) return null;
  const f = view.folderOf(id);
  if (f === view.projectId) return null;
  const name = byId(view.tree).get(f)?.name;
  return name ? (
    <span className={s.tag} title={`In ${pathOf(view.tree, f).map((x) => x.name).join(' / ')}`}>
      <Icon name="folder" size={12} />
      {name}
    </span>
  ) : null;
}

/** A folder with nothing of this kind in it. */
export function FolderEmpty({ view, noun, actions }: { view: FolderView; noun: string; actions?: ReactNode }) {
  const name = view.selected === view.projectId ? EVERYONE : (view.tree && view.selected && byId(view.tree).get(view.selected)?.name) || 'this folder';
  const adds = !!view.tree && !!view.selected && editsFolder(view.tree, view.projectId, view.selected);
  return (
    <EmptyState icon="folder" heading={3} title={`No ${noun}s in ${name} yet`} actions={adds ? actions : undefined}>
      {adds
        ? `Move ${noun}s here with Move to… or by dragging one onto ${name} in the rail. Anything you make while ${name} is picked lands here.`
        : `Nobody has put ${noun}s in ${name} yet. You can view this folder; ask someone who can edit it to add one.`}
    </EmptyState>
  );
}
