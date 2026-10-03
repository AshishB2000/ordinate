// Admin → Projects: every project of the org with its owner team, and moving
// ownership to another team. The previous owner team keeps an admin grant, so
// nobody silently loses access (remove it from the project's sharing).

import { useState } from 'react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { fmtDate, useAdminProjects, useTeams, useWrite, type AdminProject } from './api';
import s from './Admin.module.css';

function TransferDialog({ project, onOpenChange }: { project: AdminProject; onOpenChange: (o: boolean) => void }) {
  const teams = useTeams();
  const [teamId, setTeamId] = useState<string | null>(null);
  const transfer = useWrite('admin:transferOwner', ['admin:projects'], (r) => {
    if (!r.ok) return;
    toast(`${project.name} now belongs to ${teams.data?.find((t) => t.id === teamId)?.name ?? 'the team'}.`, { kind: 'success' });
    onOpenChange(false);
  });
  const options = (teams.data ?? []).filter((t) => t.id !== project.owner?.id).map((t) => ({ value: t.id, label: t.name }));
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Transfer ${project.name}`}
      description={
        project.owner
          ? `Owned by ${project.owner.name}. The new owner team becomes admin; ${project.owner.name} keeps an admin grant until you remove it.`
          : 'No team owns this project yet. The owner team becomes admin on it.'
      }
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            loading={transfer.isPending}
            disabled={!teamId}
            onClick={() => teamId && transfer.mutate({ projectId: project.id, teamId })}
          >
            Transfer ownership
          </Button>
        </>
      }
    >
      {teams.isError ? (
        <ErrorState compact heading={3} title="Teams could not be loaded" message={teams.error.message} />
      ) : !teams.isPending && options.length === 0 ? (
        <EmptyState compact heading={3} icon="layers" title="No other team">
          Create a team on the Teams tab first.
        </EmptyState>
      ) : (
        <Select
          label="New owner team"
          placeholder={teams.isPending ? 'Loading teams…' : 'Choose a team'}
          value={teamId}
          onValueChange={setTeamId}
          options={options}
          disabled={teams.isPending}
        />
      )}
    </Dialog>
  );
}

export function ProjectsTab() {
  const projects = useAdminProjects();
  const [moving, setMoving] = useState<AdminProject | null>(null);
  let body;
  if (projects.isPending) body = <SkeletonTable cols={4} rows={5} label="Loading projects" />;
  else if (projects.isError) {
    body = (
      <ErrorState heading={3} title="Projects could not be loaded" message={projects.error.message} onRetry={() => void projects.refetch()} />
    );
  } else if (projects.data.length === 0) {
    body = (
      <EmptyState heading={3} icon="folder" title="No projects yet">
        Projects appear here as people create them. Each can be owned by a team.
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Owner team</th>
              <th scope="col">Updated</th>
              <th scope="col" className={s.actions}>
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {projects.data.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className={s.cellRow}>
                    <span className={s.strong}>{p.name}</span>
                    {p.archived && <Badge>Archived</Badge>}
                  </span>
                </td>
                <td>{p.owner ? p.owner.name : <span className={s.meta}>No owner team</span>}</td>
                <td className={s.meta}>{fmtDate(p.updatedAt)}</td>
                <td className={s.actions}>
                  <Button size="sm" icon="arrow-right" onClick={() => setMoving(p)} aria-label={`Transfer ${p.name}`}>
                    Transfer
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section className={s.section} aria-label="Project ownership">
      <p className={s.lead}>
        The owner team is admin on its project. Org admins can open every project; everyone else sees what is owned by or
        shared with them.
      </p>
      {body}
      {moving && <TransferDialog project={moving} onOpenChange={(o) => !o && setMoving(null)} />}
    </section>
  );
}
