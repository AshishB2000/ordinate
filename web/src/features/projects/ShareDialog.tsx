// Sharing a project (T3.3's `project:access` / `project:share`): who holds
// which role, and — for a project admin — adding a person or team, changing
// a role, removing one. The owner team's grant is fixed here (ownership moves
// in Admin → Projects), and so is your own (no locking yourself out by a
// slip). Anyone who can open the project may see the list.

import { useState } from 'react';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Combobox } from '../../ui/Combobox';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useMe } from '../auth/api';
import { useAccess, useChange, useShareTargets, type Grant, type ProjectRow, type Role } from './api';
import s from './Projects.module.css';

const ROLES: readonly { value: Role; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
];
const ROLE_HINT: Record<Role, string> = {
  viewer: 'Viewers open and read everything in the project.',
  editor: 'Editors also change it: data, visuals, dashboards, the Trash.',
  admin: 'Admins also share it, archive it and delete it.',
};

type Member = { userId: string } | { teamId: string };
const memberOf = (g: { kind: 'user' | 'team'; id: string }): Member => (g.kind === 'user' ? { userId: g.id } : { teamId: g.id });

export function ShareDialog({ project, admin, onClose }: { project: ProjectRow; admin: boolean; onClose: () => void }) {
  const access = useAccess(project.id);
  const me = useMe().data?.user?.email;
  const targets = useShareTargets(project.id, admin);
  const [pick, setPick] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('viewer');
  const share = useChange<'project:share', { ok: boolean; error?: string }>('project:share', ['project:access', 'projects:roles'], (r) => {
    if (!r.ok) toast(r.error === 'owner' ? 'The owner team stays admin; move ownership in Admin → Projects.' : 'That person or team no longer exists.', { kind: 'error' });
  });

  const granted = new Set((access.data ?? []).map((g) => `${g.kind}:${g.id}`));
  const options = [
    ...(targets.data?.teams ?? []).map((t) => ({ value: `team:${t.id}`, label: `${t.name} (team)` })),
    ...(targets.data?.users ?? []).map((u) => ({ value: `user:${u.id}`, label: u.email })),
  ].filter((o) => !granted.has(o.value));

  const add = () => {
    if (!pick) return;
    const [kind, id] = pick.split(':') as ['user' | 'team', string];
    share.mutate({ projectId: project.id, member: memberOf({ kind, id }), role }, { onSuccess: (r) => r.ok && setPick(null) });
  };

  let list;
  if (access.isPending) list = <SkeletonRows rows={3} label="Loading who has access" />;
  else if (access.isError) {
    list = <ErrorState compact heading={3} title="Access could not be loaded" message={access.error.message} onRetry={() => void access.refetch()} />;
  } else if (access.data.length === 0) {
    list = (
      <EmptyState compact heading={3} icon="user" title="Only org admins can open it">
        {admin ? 'Add a person or a team below.' : 'Nobody has been given access to this project yet.'}
      </EmptyState>
    );
  } else {
    list = (
      <ul className={s.grants} aria-label="People and teams with access">
        {access.data.map((g: Grant) => (
          <li key={`${g.kind}:${g.id}`} className={s.grant}>
            <span className={s.grantIc} aria-hidden="true">
              <Icon name={g.kind === 'team' ? 'layers' : 'user'} />
            </span>
            <span className={s.grantName}>
              {g.label}
              {g.kind === 'team' && <span className={s.grantKind}>Team</span>}
              {g.kind === 'user' && g.label === me && <span className={s.grantKind}>You</span>}
            </span>
            {g.owner ? (
              <Badge tone="accent">Owner · Admin</Badge>
            ) : admin && !(g.kind === 'user' && g.label === me) ? (
              <>
                <Select
                  size="sm"
                  className={s.roleSelect}
                  aria-label={`Role of ${g.label}`}
                  value={g.role}
                  options={ROLES}
                  disabled={share.isPending}
                  onValueChange={(v) => share.mutate({ projectId: project.id, member: memberOf(g), role: v as Role })}
                />
                <IconButton
                  icon="x"
                  size="sm"
                  label={`Remove ${g.label}`}
                  disabled={share.isPending}
                  onClick={() => share.mutate({ projectId: project.id, member: memberOf(g), role: null })}
                />
              </>
            ) : (
              <Badge>{ROLES.find((r) => r.value === g.role)?.label ?? g.role}</Badge>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={admin ? `Share ${project.name}` : `Who has access to ${project.name}`}
      description={admin ? 'Org admins can always open it. Everyone else needs a grant here, directly or through a team.' : 'Only a project admin can change this.'}
      footer={
        <DialogClose asChild>
          <Button variant="primary">Done</Button>
        </DialogClose>
      }
    >
      <div className={s.dialogBody}>
        {admin && (
          <div className={s.addRow}>
            {targets.isError ? (
              <ErrorState compact heading={3} title="The org's people could not be loaded" message={targets.error.message} />
            ) : (
              <>
                <Combobox
                  label="Add a person or team"
                  placeholder={targets.isPending ? 'Loading…' : 'Search people and teams'}
                  emptyText="Everyone already has access"
                  value={pick}
                  onValueChange={setPick}
                  options={options}
                  disabled={targets.isPending}
                />
                <Select label="Role" value={role} onValueChange={(v) => setRole(v as Role)} options={ROLES} className={s.roleSelect} />
                <Button variant="primary" icon="plus" disabled={!pick} loading={share.isPending} onClick={add}>
                  Add
                </Button>
              </>
            )}
          </div>
        )}
        {admin && <p className={s.hint}>{ROLE_HINT[role]}</p>}
        {list}
      </div>
    </Dialog>
  );
}
