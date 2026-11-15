// New folder, Rename and Delete (docs/team-folders, "Folders, items and moves"). The server decides (a top-level folder
// is a project admin's, a subfolder needs Edit on its parent, names are unique among siblings, depth at most 5): a
// refusal comes back in its words and stays in the dialog. Delete takes only an empty folder; one that holds items
// (the Trash included) first moves them, with the move warning, never on its own.

import { useState, type FormEvent } from 'react';
import { RpcError } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { toast } from '../../ui/Toast';
import { byId, childrenOf, editsFolder, EVERYONE, pathOf, useFolderWrite, type FolderNode, type FolderTree } from './api';
import { Destinations, ImpactPanel, useImpact } from './MoveParts';
import s from './Folders.module.css';

const MAX_DEPTH = 5;
const why = (e: unknown, fallback: string) => (e instanceof RpcError || e instanceof Error ? e.message : fallback);

/** How deep `id` is below its root (Everyone and a top-level folder: 0). */
export function depthOf(t: FolderTree, projectId: string, id: string | null): number {
  if (id === null || id === projectId) return 0;
  const chain = pathOf(t, id);
  return chain.length - (chain[0]?.parentId === null ? 1 : 0);
}

/** Where a new folder may go: the top level (admins), Everyone, and every folder the caller edits that is not too deep. */
export function parentsFor(t: FolderTree, projectId: string): Array<{ id: string | null; label: string; depth: number }> {
  const out: Array<{ id: string | null; label: string; depth: number }> = [];
  if (t.admin) out.push({ id: null, label: 'Top level (shared with teams)', depth: 0 });
  const walk = (parent: string, depth: number) => {
    for (const f of childrenOf(t, parent)) {
      if (editsFolder(t, projectId, f.id) && depthOf(t, projectId, f.id) < MAX_DEPTH) out.push({ id: f.id, label: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  if (editsFolder(t, projectId, projectId)) out.push({ id: projectId, label: EVERYONE, depth: 0 });
  walk(projectId, 1);
  for (const f of childrenOf(t, null)) {
    if (editsFolder(t, projectId, f.id)) out.push({ id: f.id, label: f.name, depth: 0 });
    walk(f.id, 1);
  }
  return out;
}

export function NewFolderDialog({ projectId, tree, parent: initial, onClose, onMade }: {
  projectId: string;
  tree: FolderTree;
  /** Where it goes by default (null: the top level). */
  parent?: string | null;
  onClose: () => void;
  onMade?: (id: string) => void;
}) {
  const options = parentsFor(tree, projectId);
  const [parent, setParent] = useState<string | null>(options.some((o) => o.id === initial) ? (initial ?? null) : (options[0]?.id ?? projectId));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useFolderWrite('folder:create');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate({ projectId, parentId: parent, name: name.trim() }, {
      onSuccess: (r) => {
        if (!r.ok) return setError(r.error);
        toast(`Made “${name.trim()}”.`, { kind: 'success' });
        onMade?.(String((r as { folder?: { id?: string } }).folder?.id ?? ''));
        onClose();
      },
      onError: (err) => setError(why(err, 'The folder could not be made.')),
    });
  };
  const top = parent === null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="New folder"
      description={top ? 'A top-level folder is shared with the teams you choose in Share → Folders. Until then only project admins open it.' : 'A subfolder opens to whoever opens the folder it is in.'}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="folder-new-form" loading={create.isPending} disabled={!name.trim()}>
            Create folder
          </Button>
        </>
      }
    >
      <form id="folder-new-form" className={s.body} onSubmit={submit}>
        <Input label="Name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} error={error ?? undefined} autoFocus />
        <p className={s.label}>Inside</p>
        <ul className={s.dests} role="radiogroup" aria-label="Inside">
          {options.map((o) => (
            <li key={o.id ?? 'top'}>
              <button type="button" role="radio" aria-checked={parent === o.id} data-depth={o.depth || undefined} className={s.dest} onClick={() => setParent(o.id)}>
                <Icon name={o.id === null ? 'layers' : o.id === projectId ? 'home' : 'folder'} size={16} />
                <span>{o.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </form>
    </Dialog>
  );
}

export function RenameFolderDialog({ projectId, folder, onClose }: { projectId: string; folder: FolderNode; onClose: () => void }) {
  const [name, setName] = useState(folder.name);
  const [error, setError] = useState<string | null>(null);
  const rename = useFolderWrite('folder:rename');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    rename.mutate({ projectId, folderId: folder.id, name: name.trim() }, {
      onSuccess: (r) => (r.ok ? onClose() : setError(r.error)),
      onError: (err) => setError(why(err, 'The folder could not be renamed.')),
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Rename ${folder.name}`}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="folder-rename-form" loading={rename.isPending} disabled={!name.trim() || name.trim() === folder.name}>
            Rename
          </Button>
        </>
      }
    >
      <form id="folder-rename-form" className={s.body} onSubmit={submit}>
        <Input label="Name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} error={error ?? undefined} autoFocus />
      </form>
    </Dialog>
  );
}

/** Items placed in `id` and every folder under it (the server's counts, the Trash included). */
function heldUnder(t: FolderTree, id: string): number {
  const all = byId(t);
  let n = 0;
  const stack = [id];
  while (stack.length) {
    const f = stack.pop() as string;
    n += all.get(f)?.items ?? 0;
    for (const c of childrenOf(t, f)) stack.push(c.id);
  }
  return n;
}

export function DeleteFolderDialog({ projectId, tree, folder, onClose, onDeleted }: { projectId: string; tree: FolderTree; folder: FolderNode; onClose: () => void; onDeleted?: () => void }) {
  const held = heldUnder(tree, folder.id);
  const subs = childrenOf(tree, folder.id).length;
  const [to, setTo] = useState<string | null>(null);
  const del = useFolderWrite('folder:delete');
  const move = useFolderWrite('folder:move');
  const impact = useImpact(projectId, [], to, folder.id, held > 0);
  const [error, setError] = useState<string | null>(null);
  const remove = () =>
    del.mutate({ projectId, folderId: folder.id }, {
      onSuccess: (r) => {
        if (!r.ok) return setError(r.error);
        toast(`Deleted “${folder.name}”.`, { kind: 'success' });
        onDeleted?.();
        onClose();
      },
      onError: (err) => setError(why(err, 'The folder could not be deleted.')),
    });
  const moveThenDelete = () => {
    if (!to || !impact.data?.ok) return;
    move.mutate({ projectId, items: [], from: folder.id, to, hash: impact.data.hash }, {
      onSuccess: (r) => (r.ok ? remove() : setError(r.error)),
      onError: (err) => {
        setError(why(err, 'The items could not be moved.'));
        void impact.refetch();
      },
    });
  };
  const inside = [folder.id, ...pathOf(tree, folder.id).map((f) => f.id)];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size={held ? 'lg' : 'sm'}
      title={`Delete ${folder.name}?`}
      description={
        held
          ? `It holds ${held} ${held === 1 ? 'item' : 'items'}${subs ? ' in it and its subfolders' : ''}, the Trash included. Move them somewhere first: deleting never moves anything on its own, because that could show them to more people.`
          : subs
            ? `Its ${subs === 1 ? 'subfolder goes' : `${subs} subfolders go`} too. They are empty.`
            : 'It is empty. Nothing else changes.'
      }
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          {held ? (
            <Button variant="danger" loading={move.isPending || del.isPending} disabled={!impact.data?.ok} onClick={moveThenDelete}>
              Move {held === 1 ? 'it' : `${held} items`} and delete
            </Button>
          ) : (
            <Button variant="danger" loading={del.isPending} onClick={remove}>
              Delete folder
            </Button>
          )}
        </>
      }
    >
      {held > 0 && (
        <div className={s.body}>
          <p className={s.label}>Move them to</p>
          <Destinations projectId={projectId} tree={tree} value={to} onChange={setTo} exclude={(id) => inside.includes(id) || pathOf(tree, id).some((f) => f.id === folder.id)} />
          <ImpactPanel query={impact} picked={!!to} />
        </div>
      )}
      {error && (
        <p className={s.changed} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
