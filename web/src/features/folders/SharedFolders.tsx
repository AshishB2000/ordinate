// Share → Folders (docs/team-folders, "What an admin sees"): each top-level folder with the teams given it at Can view or
// Can edit, the people that adds up to (the server's counts), and its reach switch; New folder; and *Move everything to
// Everyone*, the step before a rollback to a release without folders. Project admins only — the channels are `admin`.

import { useState } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { Combobox } from '../../ui/Combobox';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { byId, EVERYONE, FOLDERS_OFF, people, useFolderAccess, useFolderTree, useFolderWrite, type FolderAccess, type FolderTree } from './api';
import { DeleteFolderDialog, FoldersOff, NewFolderDialog, RenameFolderDialog } from './FolderDialogs';
import { ImpactPanel, useImpact } from './MoveParts';
import s from './Folders.module.css';

export const LEVELS = [
  { value: 'view', label: 'Can view' },
  { value: 'edit', label: 'Can edit' },
] as const;

type Folder = FolderAccess['folders'][number];
const failed = (r: { ok: boolean; error?: string }) => !r.ok && toast(r.error ?? 'That did not go through.', { kind: 'error' });

const levelText = (l: 'view' | 'edit') => LEVELS.find((x) => x.value === l)?.label ?? l;

/** `on`: ORDINATE_FOLDERS is on, so its teams, levels and switch can change (off: they are read-only). */
function FolderCard({ projectId, folder, teams, tree, on }: { projectId: string; folder: Folder; teams: FolderAccess['teams']; tree: FolderTree | undefined; on: boolean }) {
  const grant = useFolderWrite('folder:grant');
  const share = useFolderWrite('folder:setShareFigures');
  const [pick, setPick] = useState<string | null>(null);
  const [level, setLevel] = useState<'view' | 'edit'>('view');
  const [ask, setAsk] = useState<'rename' | 'delete' | null>(null);
  const given = new Set(folder.grants.map((g) => g.teamId));
  const options = teams.filter((t) => !given.has(t.id)).map((t) => ({ value: t.id, label: t.inProject ? `${t.name} (${people(t.inProject)} in this project)` : `${t.name} (no one in this project yet)` }));
  const set = (teamId: string, to: 'view' | 'edit' | null) => grant.mutate({ projectId, folderId: folder.id, teamId, level: to }, { onSuccess: failed });
  const node = tree ? byId(tree).get(folder.id) : undefined;
  return (
    <li className={s.card} aria-label={folder.name}>
      <div className={s.cardHead}>
        <span className={s.cardIc} aria-hidden="true">
          <Icon name="folder" />
        </span>
        <span className={s.cardTitle}>
          <span className={s.cardName}>{folder.name}</span>
          <span className={s.cardMeta}>
            {folder.grants.length ? `${people(folder.people)} through ${folder.grants.length === 1 ? 'its team' : `${folder.grants.length} teams`}` : 'Only project admins'} · {folder.items} {folder.items === 1 ? 'item' : 'items'}
          </span>
        </span>
        {node && (
          <Menu
            label={`${folder.name} options`}
            align="end"
            trigger={<IconButton icon="more-horizontal" size="sm" label={`${folder.name} options`} />}
            items={[
              { label: 'Rename…', icon: 'pencil', onSelect: () => setAsk('rename') },
              { kind: 'separator' },
              { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setAsk('delete') },
            ]}
          />
        )}
      </div>
      <ul className={s.teams} aria-label={`Teams given ${folder.name}`}>
        {folder.grants.length === 0 && <li className={s.noTeams}>No team has it yet, so only project admins open it. Add a team below.</li>}
        {folder.grants.map((g) => (
          <li key={g.teamId} className={s.team}>
            <span className={s.teamIc} aria-hidden="true">
              <Icon name="layers" size={12} />
            </span>
            <span className={s.teamName}>
              {g.team}
              <span className={s.teamMeta}>{people(g.people)} in this project</span>
            </span>
            {on ? (
              <>
                <Select size="sm" className={s.levelSelect} aria-label={`Level of ${g.team}`} value={g.level} options={LEVELS} disabled={grant.isPending} onValueChange={(v) => set(g.teamId, v as 'view' | 'edit')} />
                <IconButton icon="x" size="sm" label={`Take ${folder.name} away from ${g.team}`} disabled={grant.isPending} onClick={() => set(g.teamId, null)} />
              </>
            ) : (
              <span className={s.levelText}>{levelText(g.level)}</span>
            )}
          </li>
        ))}
      </ul>
      {on && (
        <div className={s.addTeam}>
          <Combobox label="Give it to a team" placeholder="Search teams" emptyText={teams.length ? 'Every team has it' : 'Make teams in Admin → Teams first'} value={pick} onValueChange={setPick} options={options} />
          <Select label="Level" value={level} options={LEVELS} onValueChange={(v) => setLevel(v as 'view' | 'edit')} className={s.levelSelect} />
          <Button
            variant="primary"
            icon="plus"
            disabled={!pick}
            loading={grant.isPending}
            onClick={() => pick && grant.mutate({ projectId, folderId: folder.id, teamId: pick, level }, { onSuccess: (r) => (r.ok ? setPick(null) : failed(r)) })}
          >
            Add
          </Button>
        </div>
      )}
      <div className={s.reach}>
        {on ? (
          <Switch
            label="Dashboards in other folders may show this folder’s data"
            hint="Their viewers see those charts and figures, never the datasets themselves. Turn it off for data that must stay inside this folder."
            checked={folder.shareFigures}
            disabled={share.isPending}
            onCheckedChange={(to) => share.mutate({ projectId, folderId: folder.id, on: to }, { onSuccess: failed })}
          />
        ) : (
          <p className={s.hint}>{folder.shareFigures ? 'Dashboards in other folders may show this folder’s data.' : 'Dashboards in other folders may not show this folder’s data.'}</p>
        )}
      </div>
      {ask === 'rename' && node && <RenameFolderDialog projectId={projectId} folder={node} onClose={() => setAsk(null)} />}
      {ask === 'delete' && node && tree && <DeleteFolderDialog projectId={projectId} tree={tree} folder={node} onClose={() => setAsk(null)} />}
    </li>
  );
}

/** *Move everything to Everyone*: every placed item back where every member opens it, with the warning first. */
function MoveEverythingDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const impact = useImpact(projectId, [], projectId, projectId);
  const move = useFolderWrite('folder:move');
  const go = () =>
    impact.data?.ok &&
    move.mutate({ projectId, items: [], to: projectId, from: projectId, hash: impact.data.hash }, {
      onSuccess: (r) => {
        if (!r.ok) return failed(r);
        toast(`Moved everything to ${EVERYONE}.`, { kind: 'success' });
        onClose();
      },
      onError: (err) => {
        toast(err.message, { kind: 'error' });
        void impact.refetch();
      },
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Move everything to ${EVERYONE}?`}
      description="Every dataset and dashboard in a folder, the Trash included, goes back to where every project member opens it at their role. The folders stay, empty, with their teams."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="danger" loading={move.isPending} disabled={!impact.data?.ok} onClick={go}>
            Move everything
          </Button>
        </>
      }
    >
      <ImpactPanel query={impact} picked />
    </Dialog>
  );
}

export function SharedFolders({ projectId }: { projectId: string }) {
  const access = useFolderAccess(projectId);
  const tree = useFolderTree(projectId).data;
  const [making, setMaking] = useState(false);
  const [everything, setEverything] = useState(false);
  if (access.isPending) return <SkeletonRows rows={4} label="Loading folders" />;
  if (access.isError) return <ErrorState compact heading={3} title="Folders could not be loaded" message={access.error.message} onRetry={() => void access.refetch()} />;
  if (!access.data.ok) return <EmptyState compact heading={3} icon="folder" title="Folders are off on this server">{access.data.error}</EmptyState>;
  const { folders, teams, everyone, enabled } = access.data;
  const placed = tree ? Object.keys(tree.placed.dataset).length + Object.keys(tree.placed.dashboard).length : 0;
  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setMaking(true)} disabled={!tree}>
      New folder
    </Button>
  );
  return (
    <div className={s.shared}>
      <div className={s.sharedBar}>
        <p className={s.hint}>
          Everything starts in <strong>{EVERYONE}</strong>, which its {people(everyone)} open at their project role. A top-level folder opens only to the teams you give it; its subfolders follow it.
        </p>
        {enabled && folders.length > 0 && newButton}
      </div>
      {!enabled && folders.length > 0 && <FoldersOff />}
      {folders.length === 0 ? (
        <EmptyState compact heading={3} icon="folder" title="No folders yet" actions={enabled ? newButton : undefined}>
          {enabled ? 'Make a folder for one team’s datasets and dashboards, then choose which teams can view or edit it. Nothing moves until someone moves it.' : FOLDERS_OFF}
        </EmptyState>
      ) : (
        <ul className={s.cards} aria-label="Top-level folders">
          {folders.map((f) => (
            <FolderCard key={f.id} projectId={projectId} folder={f} teams={teams} tree={tree} on={enabled} />
          ))}
        </ul>
      )}
      {enabled && placed > 0 && (
        <div className={s.rollback}>
          <p className={s.hint}>
            Before rolling back to a release without folders, move everything back to {EVERYONE}: an older release shows every folder’s items to every member.
          </p>
          <Button icon="home" onClick={() => setEverything(true)}>
            Move everything to Everyone
          </Button>
        </div>
      )}
      {making && tree && <NewFolderDialog projectId={projectId} tree={tree} parent={null} onClose={() => setMaking(false)} />}
      {everything && <MoveEverythingDialog projectId={projectId} onClose={() => setEverything(false)} />}
    </div>
  );
}
