// The chip on a dataset's or a dashboard's page (docs/team-folders, "What you will see"): *In Finance · Finance can
// view, Finance leads can edit* — the answer to "why can I see this?". For someone who may move the item it opens
// Move to…. Nothing shows while the project has no folder besides Everyone.

import { useState } from 'react';
import { Icon } from '../../ui/icons/Icon';
import { editsFolder, EVERYONE, folderOfItem, grantsLine, hasFolders, pathOf, useFolderTree, type PlacedKind } from './api';
import { MoveDialog } from './MoveDialog';
import s from './Folders.module.css';

export function FolderChip({ projectId, kind, id, name }: { projectId: string; kind: PlacedKind; id: string; name: string }) {
  const tree = useFolderTree(projectId).data;
  const [moving, setMoving] = useState(false);
  if (!hasFolders(tree)) return null;
  const folder = folderOfItem(tree, projectId, kind, id);
  const chain = folder === projectId ? [] : pathOf(tree, folder);
  const root = chain[0]?.parentId === null ? chain[0] : undefined;
  const where = chain.length ? chain.map((f) => f.name).join(' / ') : EVERYONE;
  const whoLine = folder === projectId ? 'every member, at their role' : root ? grantsLine(root) : `opens like ${EVERYONE}`;
  // An admin no team of theirs gave it to sees it as an admin: the lock says so, the line still says who opens it.
  const locked = chain.some((f) => f.adminOnly);
  const asAdmin = locked ? ' You open it as a project admin.' : '';
  const inner = (
    <>
      <Icon name={locked ? 'lock' : folder === projectId ? 'home' : 'folder'} size={12} />
      <span className={s.chipWhere}>In {where}</span>
      <span className={s.chipWho}>· {whoLine}</span>
    </>
  );
  if (!editsFolder(tree, projectId, folder)) {
    return (
      <span className={s.chip} title={`In ${where}: ${whoLine}.${asAdmin}`}>
        {inner}
      </span>
    );
  }
  return (
    <>
      <button type="button" className={s.chip} title={`In ${where}: ${whoLine}.${asAdmin} Move to another folder…`} onClick={() => setMoving(true)}>
        {inner}
      </button>
      {moving && <MoveDialog projectId={projectId} tree={tree} items={[{ kind, id, name }]} onClose={() => setMoving(false)} />}
    </>
  );
}
