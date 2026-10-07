// Admin → People under password sign-in: add someone with a temporary
// password, or set a new temporary password for someone who forgot theirs.
// Either way they choose their own at their next sign-in, and the admin hands
// the temporary one over themselves — Ordinate sends no email. The password
// field is plain text on purpose: it is meant to be read out or copied.

import { useState, type FormEvent } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { PASSWORD_MIN, tooShort } from '../auth/api';
import { ROLES, useWrite, type AdminUser, type Role } from './api';
import s from './Admin.module.css';

// No 0/O, 1/l/I: read out loud or copied off a screen.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A random 16-character temporary password (~92 bits), from the browser's CSPRNG. */
export function temporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(16));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function TempPasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className={s.tempRow}>
      <Input
        label="Temporary password"
        hint={`At least ${PASSWORD_MIN} characters. They choose their own when they first sign in.`}
        autoComplete="off"
        spellCheck={false}
        className={s.tempInput}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button icon="refresh" onClick={() => onChange(temporaryPassword())}>
        Generate
      </Button>
    </div>
  );
}

export function AddPersonDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState(temporaryPassword);
  const add = useWrite('admin:addUser', ['admin:users'], (r) => {
    if (!r.ok) return;
    toast(`Added ${email.trim().toLowerCase()}. Give them the temporary password; they choose their own when they first sign in.`, {
      kind: 'success',
    });
    setOpen(false);
    setEmail('');
    setRole('viewer');
    setPassword(temporaryPassword());
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate({ email: email.trim(), role, password });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="primary" icon="plus">
          Add person
        </Button>
      }
      title="Add someone"
      description="They sign in with this email and the temporary password below. Copy it before you close this."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            type="submit"
            form="add-person-form"
            loading={add.isPending}
            disabled={!email.includes('@') || tooShort(password)}
          >
            Add person
          </Button>
        </>
      }
    >
      <form id="add-person-form" className={s.dialogBody} onSubmit={submit}>
        <Input label="Email" type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <Select label="Role" value={role} onValueChange={(v) => setRole(v as Role)} options={ROLES} />
        <TempPasswordField value={password} onChange={setPassword} />
      </form>
    </Dialog>
  );
}

/** Opened from a person's row menu; `user` null = closed. */
export function ResetPasswordDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const [password, setPassword] = useState(temporaryPassword);
  const reset = useWrite('admin:resetPassword', ['admin:users'], (r) => {
    if (!r.ok) return;
    toast(`New temporary password set for ${user?.email ?? 'them'}. They were signed out everywhere.`, { kind: 'success' });
    setPassword(temporaryPassword());
    onClose();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (user) reset.mutate({ userId: user.id, password });
  };
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Reset password"
      description={`${user?.email ?? ''} is signed out everywhere and signs in next with this temporary password.`}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="reset-password-form" loading={reset.isPending} disabled={tooShort(password)}>
            Set password
          </Button>
        </>
      }
    >
      <form id="reset-password-form" className={s.dialogBody} onSubmit={submit}>
        <TempPasswordField value={password} onChange={setPassword} />
      </form>
    </Dialog>
  );
}
