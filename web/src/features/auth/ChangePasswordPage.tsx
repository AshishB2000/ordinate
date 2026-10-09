// Change password (AUTH_MODE=password), outside the shell like sign-in. Someone
// holding a temporary password (an admin set it) is sent here by the server at
// every navigation until they choose their own; anyone else reaches it from
// the account menu. Other sessions of the account end on a change.

import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { nav } from '../../api/client';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { changePassword, PASSWORD_MIN, signInPath, signOut, tooShort, useMe } from './api';
import { AuthAlert, AuthLayout } from './AuthLayout';
import { passwordError } from './PasswordForms';
import s from './SignInPage.module.css';

const safeNext = (raw: string | null): string => (raw && /^\/(?![/\\])[^\s\\]*$/.test(raw) && !raw.startsWith('/change-password') ? raw : '/');

export default function ChangePasswordPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me.data && !me.data.user) return <Navigate to={signInPath('/change-password')} replace />;
  if (me.data && me.data.mode !== 'password') return <Navigate to="/" replace />;
  const forced = me.data?.user?.mustChangePassword === true;

  const short = tried && tooShort(password) ? `Use at least ${PASSWORD_MIN} characters.` : undefined;
  const mismatch = tried && confirm !== password ? "The passwords don't match." : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (tooShort(password) || confirm !== password) return;
    setBusy(true);
    setError(null);
    changePassword(current, password).then(
      (r) => {
        if (r.ok) return nav.assign(next);
        setBusy(false);
        setError(passwordError(r));
      },
      () => {
        setBusy(false);
        setError("Ordinate couldn't be reached. Check your connection and try again.");
      },
    );
  };

  return (
    <AuthLayout passwords>
      <h1 className={s.title}>{forced ? 'Choose your own password' : 'Change your password'}</h1>
      <p className={s.lede}>
        {forced
          ? 'You signed in with a temporary password from your administrator. Choose a new one to continue.'
          : "You'll stay signed in here; every other device signed in to this account is signed out."}
      </p>
      <form className={s.fields} onSubmit={submit} aria-label="Change password" noValidate>
        {error && <AuthAlert title="Your password wasn't changed">{error}</AuthAlert>}
        <Input
          label={forced ? 'Temporary password' : 'Current password'}
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          hint={`At least ${PASSWORD_MIN} characters.`}
          error={short}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Input label="Confirm new password" type="password" autoComplete="new-password" required error={mismatch} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Button variant="primary" size="lg" type="submit" className={s.go} loading={busy} iconEnd="arrow-right">
          Change password
        </Button>
      </form>
      <p className={`${s.fine} ${s.actions}`}>
        {forced ? <span>Signed in as {me.data?.user?.email}</span> : <Link to={next}>Back to Ordinate</Link>}
        <button type="button" className={s.linkButton} onClick={() => void signOut().finally(() => nav.assign('/sign-in'))}>
          Sign out
        </button>
      </p>
    </AuthLayout>
  );
}
