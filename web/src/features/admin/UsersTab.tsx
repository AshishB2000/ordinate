// Admin → Users: everyone in the org, invite by email (a pending member until
// their first sign-in), change a role, disable or enable. The server refuses
// demoting or disabling the last admin and disabling yourself; a refusal is a
// toast, and the list is refetched either way.

import { useState, type FormEvent } from 'react';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Menu } from '../../ui/Menu';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { fmtDate, ROLES, useAdminUsers, useWrite, type AdminUser, type Role } from './api';
import s from './Admin.module.css';

function Status({ u }: { u: AdminUser }) {
  if (u.disabled) return <Badge tone="error">Disabled</Badge>;
  if (u.pending) return <Badge tone="warn">Invited</Badge>;
  return <Badge tone="ok">Active</Badge>;
}

function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const invite = useWrite('admin:invite', ['admin:users'], (r) => {
    if (!r.ok) return;
    toast(`Invited ${email.trim().toLowerCase()}. They join when they first sign in.`, { kind: 'success' });
    setOpen(false);
    setEmail('');
    setRole('viewer');
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate({ email: email.trim(), role });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="primary" icon="plus">
          Invite people
        </Button>
      }
      title="Invite someone"
      description="They appear here as invited and get this role the first time they sign in with single sign-on."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="invite-form" loading={invite.isPending} disabled={!email.includes('@')}>
            Invite
          </Button>
        </>
      }
    >
      <form id="invite-form" className={s.dialogBody} onSubmit={submit}>
        <Input label="Email" type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <Select label="Role" value={role} onValueChange={(v) => setRole(v as Role)} options={ROLES} />
      </form>
    </Dialog>
  );
}

function UserRow({ u, me }: { u: AdminUser; me: string | undefined }) {
  const setRole = useWrite('admin:setRole', ['admin:users']);
  const setDisabled = useWrite('admin:setDisabled', ['admin:users']);
  const self = u.email === me;
  return (
    <tr>
      <td>
        <span className={s.cellRow}>
          <span className={s.strong}>{u.email}</span>
          {self && <Badge tone="accent">You</Badge>}
        </span>
      </td>
      <td>
        <Select
          size="sm"
          className={s.roleSelect}
          aria-label={`Role of ${u.email}`}
          value={u.role}
          options={ROLES}
          disabled={setRole.isPending}
          onValueChange={(v) => v !== u.role && setRole.mutate({ userId: u.id, role: v as Role })}
        />
      </td>
      <td>
        <Status u={u} />
      </td>
      <td className={s.num}>{u.teams}</td>
      <td className={s.meta}>{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'Never'}</td>
      <td className={s.meta}>{fmtDate(u.createdAt)}</td>
      <td className={s.actions}>
        <Menu
          align="end"
          trigger={<IconButton icon="more-horizontal" label={`Actions for ${u.email}`} size="sm" />}
          items={[
            u.disabled
              ? { label: 'Enable', icon: 'circle-check', onSelect: () => setDisabled.mutate({ userId: u.id, disabled: false }) }
              : {
                  label: 'Disable',
                  icon: 'lock',
                  danger: true,
                  disabled: self,
                  onSelect: () => setDisabled.mutate({ userId: u.id, disabled: true }),
                },
          ]}
        />
      </td>
    </tr>
  );
}

export function UsersTab({ me }: { me: string | undefined }) {
  const users = useAdminUsers();
  const [find, setFind] = useState('');
  const shown = users.data?.filter((u) => u.email.includes(find.trim().toLowerCase())) ?? [];
  let body;
  if (users.isPending) body = <SkeletonTable cols={6} rows={6} label="Loading people" />;
  else if (users.isError) {
    body = <ErrorState heading={3} title="People could not be loaded" message={users.error.message} onRetry={() => void users.refetch()} />;
  } else if (shown.length === 0) {
    body = (
      <EmptyState heading={3} icon="user" title={find ? 'Nobody matches that' : 'No one here yet'}>
        {find ? 'Try part of an email address.' : 'Invite people by email; they join when they first sign in.'}
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col" className={s.num}>
                Teams
              </th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Added</th>
              <th scope="col" className={s.actions}>
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <UserRow key={u.id} u={u} me={me} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section className={s.section} aria-label="People">
      <div className={s.bar}>
        <Input
          className={s.search}
          icon="search"
          type="search"
          aria-label="Find people"
          placeholder="Find by email"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <div className={s.barEnd}>
          <InviteDialog />
        </div>
      </div>
      {body}
    </section>
  );
}
