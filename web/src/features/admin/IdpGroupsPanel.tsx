// Admin → People → Identity provider groups (docs/sso-lifecycle/00-design.md
// §3.15): map a group the IdP sends to an org role and/or a team. Once any
// group maps a role, every role follows the IdP (the People table hides its
// picker); a linked team's members come from the IdP only (Teams hides its
// member picker). A change applies at once to everyone whose groups the server
// has seen, and at each sign-in after.

import { useState, type FormEvent } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { ROLES, useIdpGroups, useTeams, useWrite, type IdpGroupRow, type Role } from './api';
import s from './Admin.module.css';

const NONE = 'none';
const REFRESH = ['admin:idpGroups', 'admin:users', 'admin:teams'] as const;
const roleLabel = (r: Role | null) => ROLES.find((x) => x.value === r)?.label ?? '—';

/** Add (no `row`) or change (`row`) one group's role and team. */
function MapDialog({ row, onOpenChange }: { row: IdpGroupRow | null; onOpenChange: (o: boolean) => void }) {
  const teams = useTeams();
  const [group, setGroup] = useState(row?.group ?? '');
  const [role, setRole] = useState<string>(row?.role ?? NONE);
  const [team, setTeam] = useState<string>(row?.teamId ?? NONE);
  const save = useWrite('admin:setIdpGroup', REFRESH, (r) => r.ok && onOpenChange(false));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ group: group.trim(), role: role === NONE ? null : (role as Role), teamId: team === NONE ? null : team });
  };
  const empty = role === NONE && team === NONE;
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={row ? `Map ${row.group}` : 'Map a group'}
      description="Matched exactly, as your identity provider sends it — case and spaces inside the name count."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="idp-map-form" loading={save.isPending} disabled={!group.trim() || (!row && empty)}>
            {row && empty ? 'Remove mapping' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="idp-map-form" className={s.dialogBody} onSubmit={submit}>
        <Input label="Group" value={group} maxLength={256} disabled={!!row} onChange={(e) => setGroup(e.target.value)} autoFocus={!row} placeholder="e.g. bi-editors" />
        <Select label="Role" value={role} onValueChange={setRole} options={[{ value: NONE, label: 'No role' }, ...ROLES]} />
        <Select
          label="Team"
          value={team}
          onValueChange={setTeam}
          disabled={teams.isPending}
          options={[{ value: NONE, label: 'No team' }, ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))]}
        />
        <p className={s.warn}>
          <Icon name="alert" size={16} />
          Anyone in no mapped group becomes a viewer at their next sign-in, so map your admins&rsquo; group first. A linked team&rsquo;s members are replaced by the
          group&rsquo;s.
        </p>
      </form>
    </Dialog>
  );
}

export function IdpGroupsPanel({ mode }: { mode: 'oidc' | 'header' }) {
  const groups = useIdpGroups();
  const [editing, setEditing] = useState<IdpGroupRow | 'new' | null>(null);
  const remove = useWrite('admin:setIdpGroup', REFRESH);
  const data = groups.data;
  const live = !!data?.source;
  let body;
  if (groups.isPending) body = <SkeletonTable cols={4} rows={3} label="Loading identity provider groups" />;
  else if (groups.isError) {
    body = <ErrorState heading={3} title="Identity provider groups could not be loaded" message={groups.error.message} onRetry={() => void groups.refetch()} />;
  } else if (!live) {
    body = (
      <div className={s.notice} role="note">
        <Icon name="info" />
        <div>
          <h3 className={s.noticeTitle}>Groups are not read from your identity provider</h3>
          <p className={s.lead}>
            {mode === 'oidc'
              ? 'Set OIDC_GROUPS_CLAIM to the ID token claim that lists a person’s groups (for example groups), then map groups here.'
              : 'Set TRUSTED_GROUPS_HEADER to the header your proxy lists a person’s groups in (for example X-Forwarded-Groups), then map groups here.'}{' '}
            Until then, roles and teams are set by hand.
          </p>
        </div>
      </div>
    );
  } else if (data.groups.length === 0) {
    body = (
      <EmptyState
        heading={3}
        icon="shield"
        title="No groups mapped yet"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            Map a group
          </Button>
        }
      >
        Map a group your identity provider sends to a role, a team, or both. Until a group maps to a role, roles are set by hand above.
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">Role</th>
              <th scope="col">Team</th>
              <th scope="col" className={s.actions}>
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((g) => (
              <tr key={g.group}>
                <td className={s.mono}>{g.group}</td>
                <td>{g.role ? roleLabel(g.role) : <span className={s.meta}>No role</span>}</td>
                <td>{g.teamName ?? <span className={s.meta}>No team</span>}</td>
                <td className={s.actions}>
                  <Menu
                    align="end"
                    trigger={<IconButton icon="more-horizontal" label={`Actions for ${g.group}`} size="sm" />}
                    items={[
                      { label: 'Change…', icon: 'pencil', onSelect: () => setEditing(g) },
                      { label: 'Remove', icon: 'trash', danger: true, onSelect: () => remove.mutate({ group: g.group, role: null, teamId: null }) },
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
    <section className={s.section} aria-label="Identity provider groups">
      <div className={s.bar}>
        <div>
          <h2 className={s.groupTitle}>Identity provider groups</h2>
          <p className={s.lead}>
            {live
              ? `Read from the ${data.from} ${data.source === 'oidc' ? 'claim of each sign-in' : 'header of each request'}. The highest mapped role wins; no mapped group is a viewer.`
              : 'Who gets which role and team, decided by your identity provider.'}
          </p>
        </div>
        {live && data.groups.length > 0 && (
          <div className={s.barEnd}>
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Map a group
            </Button>
          </div>
        )}
      </div>
      {body}
      {editing && <MapDialog key={editing === 'new' ? 'new' : editing.group} row={editing === 'new' ? null : editing} onOpenChange={(o) => !o && setEditing(null)} />}
    </section>
  );
}
