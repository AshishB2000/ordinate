// The sign-in page: outside the shell (no nav for someone not signed in).
//
// Single sign-on (oidc): it never handles a credential — "Continue" is a plain
// navigation to /api/auth/login, which sends the browser to the company's IdP
// and back. A failed sign-in comes back as /sign-in?error=<code>
// (src/server/auth/oidc.ts).
//
// Password sign-in (password): an email + password form, or — before the
// server has an admin — the form that creates one with the setup code from the
// server's log (./PasswordForms.tsx).

import { Navigate, useSearchParams } from 'react-router';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Skeleton } from '../../ui/Skeleton';
import { useMe } from './api';
import { AuthAlert, AuthLayout } from './AuthLayout';
import { SetupForm, SignInForm } from './PasswordForms';
import s from './SignInPage.module.css';

const ERRORS: Record<string, string> = {
  denied: 'Sign-in was cancelled at your identity provider.',
  domain: "That account's email domain isn't allowed on this Ordinate server. Sign in with your work account.",
  disabled: 'Your Ordinate account has been disabled. Ask an administrator to turn it back on.',
  email: "Your identity provider didn't share a verified email address, which Ordinate needs to sign you in.",
  expired: 'That sign-in took too long or started in another browser. Please try again.',
  unavailable: "Ordinate couldn't reach your identity provider. Try again in a minute.",
};
const GENERIC = "Sign-in didn't complete. Please try again.";

/** Same rule as the server's safeNext: a same-origin path, else Home. */
const safeNext = (raw: string | null): string => (raw && /^\/(?![/\\])[^\s\\]*$/.test(raw) ? raw : '/');

function Passwords({ next, setup }: { next: string; setup: boolean }) {
  if (setup) {
    return (
      <>
        <h1 className={s.title}>Create the admin account</h1>
        <p className={s.lede}>
          This Ordinate server has no administrator yet. Enter the setup code from the server's log, then choose the
          email and password you'll sign in with.
        </p>
        <SetupForm next={next} />
        <p className={s.fine}>
          Running Docker Compose? <code className={s.cmd}>docker compose logs ordinate | grep "setup code"</code> prints
          it. Password sign-in is for trying Ordinate out: switch the server to your company's single sign-on before
          real use.
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className={s.title}>Sign in to Ordinate</h1>
      <p className={s.lede}>Use the email and password your Ordinate administrator gave you.</p>
      <SignInForm next={next} />
      <p className={s.fine}>
        Forgot your password? Your Ordinate administrator can set a new one for you in Admin → People.
      </p>
    </>
  );
}

export default function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const error = params.get('error');
  const me = useMe();

  // Already signed in (a bookmarked /sign-in, the back button): straight in.
  if (me.data?.user) return <Navigate to={next} replace />;
  const passwords = me.data?.mode === 'password';
  const proxied = me.data?.mode === 'header';
  const login = `/api/auth/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`;

  let body;
  // Until the mode is known, nothing to click: an SSO button flashing up before a password form is worse than a beat of grey.
  if (me.isPending) {
    body = (
      <div className={s.fields} aria-busy="true" aria-label="Checking how this server signs you in">
        <Skeleton className={s.skelTitle} />
        <Skeleton className={s.skelLine} />
        <Skeleton className={s.skelButton} />
      </div>
    );
  } else if (passwords) {
    body = <Passwords next={next} setup={me.data?.setup === true} />;
  } else {
    body = (
      <>
        <h1 className={s.title}>Sign in to Ordinate</h1>
        <p className={s.lede}>
          {proxied
            ? "This server signs you in through your company's access proxy. Open Ordinate from its usual address and you'll be signed in automatically."
            : "Use your work account. You'll go to your company's sign-in page and come straight back here."}
        </p>

        {error !== null && <AuthAlert title="We couldn't sign you in">{ERRORS[error] ?? GENERIC}</AuthAlert>}

        {!proxied && (
          <a className={buttonClass('primary', 'lg', s.go)} href={login}>
            <span>{error !== null ? 'Try again' : 'Continue with single sign-on'}</span>
            <Icon name="arrow-right" />
          </a>
        )}

        <p className={s.fine}>
          Ordinate never sees your password. If you can't get in, your Ordinate administrator manages who has access.
        </p>
      </>
    );
  }

  return <AuthLayout passwords={passwords}>{body}</AuthLayout>;
}
