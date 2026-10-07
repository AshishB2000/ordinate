// Password sign-in (AUTH_MODE=password): the email + password form, and the
// first-run form that creates the admin account with the setup code the server
// printed in its log. The server decides everything (src/server/auth/password.ts);
// these forms only word its refusal codes. A success is a full navigation, so
// the app starts clean as the signed-in user.

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { nav } from '../../api/client';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { changePasswordPath, ME_KEY, PASSWORD_MIN, passwordSetup, passwordSignIn, tooShort, type PasswordReply } from './api';
import { AuthAlert } from './AuthLayout';
import s from './SignInPage.module.css';

const minutes = (sec: number | undefined) => Math.max(1, Math.ceil((sec ?? 60) / 60));

/** A refusal code in words. */
export function passwordError(r: Extract<PasswordReply, { ok: false }>): string {
  switch (r.error) {
    case 'invalid':
      return "That email and password don't match an account on this server.";
    case 'invalid-input':
      return 'Enter a valid email address.';
    case 'disabled':
      return 'Your Ordinate account has been disabled. Ask an administrator to turn it back on.';
    case 'domain':
      return "That email domain isn't allowed on this Ordinate server.";
    case 'locked': {
      const m = minutes(r.retryAfter);
      return `Too many wrong passwords for this account. Try again in ${m} minute${m === 1 ? '' : 's'}.`;
    }
    case 'rate limited':
      return 'Too many sign-in attempts from this network. Wait a minute and try again.';
    case 'code':
      return "That setup code is wrong or has expired. Copy it from the server's log; restarting the server prints a new one.";
    case 'closed':
      return 'An admin account already exists on this server. Sign in with it instead.';
    case 'password-short':
      return `Use at least ${PASSWORD_MIN} characters.`;
    case 'password-long':
      return 'That password is too long: 256 characters at most.';
    case 'same':
      return 'Choose a password different from the current one.';
    case 'current':
      return 'Your current password is not right.';
    case 'signed-out':
      return 'Your session ended. Sign in again, then change your password.';
    default:
      return "That didn't go through. Please try again.";
  }
}

export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    passwordSignIn(email.trim(), password).then(
      (r) => {
        if (r.ok) return nav.assign(r.mustChangePassword ? changePasswordPath(next) : next);
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
    <form className={s.fields} onSubmit={submit} aria-label="Sign in">
      {error && <AuthAlert title="We couldn't sign you in">{error}</AuthAlert>}
      <Input label="Email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button variant="primary" size="lg" type="submit" className={s.go} loading={busy} iconEnd="arrow-right">
        Sign in
      </Button>
    </form>
  );
}

export function SetupForm({ next }: { next: string }) {
  const client = useQueryClient();
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const short = tried && tooShort(password) ? `Use at least ${PASSWORD_MIN} characters.` : undefined;
  const mismatch = tried && confirm !== password ? "The passwords don't match." : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (tooShort(password) || confirm !== password) return;
    setBusy(true);
    setError(null);
    passwordSetup(code, email.trim(), password).then(
      (r) => {
        if (r.ok) return nav.assign(next);
        setBusy(false);
        setError(passwordError(r));
        // Someone else finished setup first: the page switches to the sign-in form.
        if (r.error === 'closed') void client.invalidateQueries({ queryKey: ME_KEY });
      },
      () => {
        setBusy(false);
        setError("Ordinate couldn't be reached. Check your connection and try again.");
      },
    );
  };

  return (
    <form className={s.fields} onSubmit={submit} aria-label="Create admin account" noValidate>
      {error && <AuthAlert title="The account wasn't created">{error}</AuthAlert>}
      <Input
        label="Setup code"
        hint="Printed in the server's log when it started."
        autoComplete="off"
        spellCheck={false}
        placeholder="XXXX-XXXX-XXXX"
        required
        autoFocus
        className={s.code}
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Input label="Your email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <Input
        label="Password"
        type="password"
        autoComplete="new-password"
        required
        hint={`At least ${PASSWORD_MIN} characters.`}
        error={short}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Input label="Confirm password" type="password" autoComplete="new-password" required error={mismatch} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <Button variant="primary" size="lg" type="submit" className={s.go} loading={busy} iconEnd="arrow-right">
        Create admin account
      </Button>
    </form>
  );
}
