// Admin → Teams: create, rename, and choose members. A team is what a project
// is owned by and shared with (Projects tab, and sharing on each project).

import { useState, type FormEvent } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Menu } from '../../ui/Menu';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { fmtDate, useAdminUsers, useTeams, useWrite, type Team } from './api';
import s from './Admin.module.css';

/** Create (no `team`) or rename (`team`) — one name field. */
function NameDialog({ team, open, onOpenChange }: { team?: Team; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState(team?.name ?? '');
  const done = (r: { ok: boolean }) => r.ok && onOpenChange(false);
  const create = useWrite('admin:createTeam', ['admin:teams'], done);
  const rename = useWrite('admin:renameTeam', ['admin:teams', 'admin:projects'], done);
  const busy = create.isPending || rename.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (team) rename.mutate({ teamId: team.id, name: name.trim() });
    else create.mutate({ name: name.trim() });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={team ? `Rename ${team.name}` : 'New team'}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="team-name-form" loading={busy} disabled={!name.trim()}>
            {team ? 'Rename' : 'Create team'}
          </Button>
        </>
      }
    >
      <form id="team-name-form" className={s.dialogBody} onSubmit={submit}>
        <Input label="Team name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoFocus />
      </form>
    </Dialog>
  );
}

function MembersDialog({ team, onOpenChange }: { team: Team; onOpenChange: (o: boolean) => void }) {
  const users = useAdminUsers();
  const toggle = useWrite('admin:teamMember', ['admin:teams', 'admin:users']);
  const inTeam = new Set(team.members.map((m) => m.id));
  let body;
  if (users.isPending) body = <SkeletonTable cols={1} rows={4} label="Loading people" />;
  else if (users.isError) body = <ErrorState compact heading={3} title="People could not be loaded" message={users.error.message} />;
  else {
    body = (
      <div className={s.checkList}>
        {users.data.map((u) => (
          <Checkbox
            key={u.id}
            label={u.email}
            hint={u.disabled ? 'Disabled' : u.pending ? 'Invited' : undefined}
            checked={inTeam.has(u.id)}
            disabled={toggle.isPending}
            onCheckedChange={(on) => toggle.mutate({ teamId: team.id, userId: u.id, member: on })}
          />
        ))}
      </div>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Members of ${team.name}`}
      description="Changes save as you tick. A member gets the team's role on every project the team owns or is shared with."
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

export function TeamsTab() {
  const teams = useTeams();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Team | null>(null);
  const [members, setMembers] = useState<string | null>(null);
  // The dialog follows the refetched team, so a tick shows at once.
  const membersOf = teams.data?.find((t) => t.id === members);
  let body;
  if (teams.isPending) body = <SkeletonTable cols={4} rows={4} label="Loading teams" />;
  else if (teams.isError) {
    body = <ErrorState heading={3} title="Teams could not be loaded" message={teams.error.message} onRetry={() => void teams.refetch()} />;
  } else if (teams.data.length === 0) {
    body = (
      <EmptyState
        heading={3}
        icon="layers"
        title="No teams yet"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Create a team
          </Button>
        }
      >
        Group people into teams, then own and share projects by team instead of one person at a time.
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">Members</th>
              <th scope="col">Created</th>
              <th scope="col" className={s.actions}>
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {teams.data.map((t) => (
              <tr key={t.id}>
                <td className={s.strong}>{t.name}</td>
                <td>
                  {t.members.length === 0 ? (
                    <span className={s.meta}>No members</span>
                  ) : (
                    <span className={s.chips}>
                      {t.members.map((m) => (
                        <span key={m.id} className={s.chip}>
                          {m.email}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className={s.meta}>{fmtDate(t.createdAt)}</td>
                <td className={s.actions}>
                  <Menu
                    align="end"
                    trigger={<IconButton icon="more-horizontal" label={`Actions for ${t.name}`} size="sm" />}
                    items={[
                      { label: 'Members…', icon: 'user', onSelect: () => setMembers(t.id) },
                      { label: 'Rename…', icon: 'pencil', onSelect: () => setRenaming(t) },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section className={s.section} aria-label="Teams">
      <div className={s.bar}>
        <p className={s.lead}>Teams own projects and receive shares. Membership changes apply on the member's next request.</p>
        <div className={s.barEnd}>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New team
          </Button>
        </div>
      </div>
      {body}
      {creating && <NameDialog open onOpenChange={setCreating} />}
      {renaming && <NameDialog key={renaming.id} team={renaming} open onOpenChange={(o) => !o && setRenaming(null)} />}
      {membersOf && <MembersDialog team={membersOf} onOpenChange={(o) => !o && setMembers(null)} />}
    </section>
  );
}
