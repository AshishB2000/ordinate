// Admin → Teams → <team> → Folders (docs/team-folders, "What an admin sees"): per project, the team's level on each
// top-level folder — No access, Can view or Can edit — through the same project channels as Share → Folders (an org
// admin is admin on every project). A member gets at most their project role, whatever the folder level says.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useAdminProjects } from '../admin/api';
import { FOLDERS_OFF, people, useFolderAccess, useFolderWrite } from './api';
import { FoldersOff } from './FolderDialogs';
import { LEVELS } from './SharedFolders';
import s from './Folders.module.css';

const NONE = 'none';
const OPTIONS = [{ value: NONE, label: 'No access' }, ...LEVELS];

function ProjectFolders({ projectId, teamId, teamName }: { projectId: string; teamId: string; teamName: string }) {
  const access = useFolderAccess(projectId);
  const grant = useFolderWrite('folder:grant');
  if (access.isPending) return <SkeletonRows rows={3} label="Loading folders" />;
  if (access.isError) return <ErrorState compact heading={3} title="Folders could not be loaded" message={access.error.message} onRetry={() => void access.refetch()} />;
  if (!access.data.ok) return <EmptyState compact heading={3} icon="folder" title="Folders are off on this server">{access.data.error}</EmptyState>;
  const team = access.data.teams.find((t) => t.id === teamId);
  if (!access.data.folders.length) {
    return (
      <EmptyState compact heading={3} icon="folder" title="This project has no folders">
        {access.data.enabled ? 'Everything in it is in Everyone in the project. A project admin makes folders in Share → Folders.' : FOLDERS_OFF}
      </EmptyState>
    );
  }
  const on = access.data.enabled;
  return (
    <>
      {!on && <FoldersOff />}
      <p className={s.hint}>
        {team?.inProject ? `${people(team.inProject)} of ${teamName} ${team.inProject === 1 ? 'holds' : 'hold'} a role in this project.` : `No one in ${teamName} holds a role in this project, so a folder level here opens nothing yet.`}
      </p>
      <ul className={`${s.teams} ${s.boxed}`} aria-label={`${teamName}'s folders`}>
        {access.data.folders.map((f) => {
          const mine = f.grants.find((g) => g.teamId === teamId)?.level ?? NONE;
          return (
            <li key={f.id} className={s.team}>
              <span className={s.teamIc} aria-hidden="true">
                <Icon name="folder" size={12} />
              </span>
              <span className={s.teamName}>
                {f.name}
                <span className={s.teamMeta}>{f.grants.length ? f.grants.map((g) => g.team).join(', ') : 'Only project admins'}</span>
              </span>
              {on ? (
                <Select
                  size="sm"
                  className={s.levelSelect}
                  aria-label={`${teamName} on ${f.name}`}
                  value={mine}
                  options={OPTIONS}
                  disabled={grant.isPending}
                  onValueChange={(v) =>
                    grant.mutate({ projectId, folderId: f.id, teamId, level: v === NONE ? null : (v as 'view' | 'edit') }, { onSuccess: (r) => !r.ok && toast(r.error, { kind: 'error' }) })
                  }
                />
              ) : (
                <span className={s.levelText}>{OPTIONS.find((o) => o.value === mine)?.label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function TeamFoldersDialog({ team, onClose }: { team: { id: string; name: string }; onClose: () => void }) {
  const projects = useAdminProjects();
  const live = (projects.data ?? []).filter((p) => !p.archived);
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = picked ?? live[0]?.id ?? null;
  let body;
  if (projects.isPending) body = <SkeletonRows rows={3} label="Loading projects" />;
  else if (projects.isError) body = <ErrorState compact heading={3} title="Projects could not be loaded" message={projects.error.message} />;
  else if (!live.length) body = <EmptyState compact heading={3} icon="folder" title="No projects yet">Folders live inside a project.</EmptyState>;
  else {
    body = (
      <div className={s.body}>
        <Select label="Project" value={projectId ?? ''} options={live.map((p) => ({ value: p.id, label: p.name }))} onValueChange={setPicked} />
        {projectId && <ProjectFolders key={projectId} projectId={projectId} teamId={team.id} teamName={team.name} />}
      </div>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Folders for ${team.name}`}
      description="A team opens a top-level folder at the level given here, and its subfolders with it. Changes apply on each member’s next request."
      footer={
        <DialogClose asChild>
          <Button variant="primary">Done</Button>
        </DialogClose>
      }
    >
      {body}
    </Dialog>
  );
}
