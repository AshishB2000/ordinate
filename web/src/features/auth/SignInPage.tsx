// The sign-in page: outside the shell (no nav for someone not signed in).
// It never handles a credential — "Continue" is a plain navigation to
// /api/auth/login, which sends the browser to the company's IdP and back.
// A failed sign-in comes back as /sign-in?error=<code> (src/server/auth/oidc.ts).

import { Navigate, useSearchParams } from 'react-router';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { useMe } from './api';
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

const POINTS: { icon: 'shield' | 'lock' | 'layers'; text: string }[] = [
  { icon: 'shield', text: 'Your company account, through your own identity provider' },
  { icon: 'lock', text: 'Runs in your infrastructure — your data stays there' },
  { icon: 'layers', text: 'Data, visuals and dashboards in one workspace' },
];

export default function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const error = params.get('error');
  const me = useMe();

  // Already signed in (a bookmarked /sign-in, the back button): straight in.
  if (me.data?.user) return <Navigate to={next} replace />;
  const proxied = me.data?.mode === 'header';
  const login = `/api/auth/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`;

  return (
    <div className={s.wrap}>
      <aside className={s.brand} aria-hidden="true">
        <div className={s.brandTop}>
          <img src="/favicon.svg" alt="" className={s.mark} width={36} height={36} />
          <span className={s.word}>Ordinate</span>
        </div>
        <div className={s.pitch}>
          <p className={s.pitchTitle}>Bring data in. Shape it. Chart it. Share it.</p>
          <div className={s.bars}>
            {/* Heights come from the stylesheet (nth-child): no inline styles under the CSP. */}
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={s.bar} />
            ))}
          </div>
          <ul className={s.points}>
            {POINTS.map((p) => (
              <li key={p.text}>
                <Icon name={p.icon} />
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className={s.brandFoot}>Self-hosted business intelligence</p>
      </aside>

      <main className={s.panel}>
        <div className={s.form}>
          <div className={s.compactMark}>
            <img src="/favicon.svg" alt="" width={32} height={32} />
            <span className={s.word}>Ordinate</span>
          </div>
          <h1 className={s.title}>Sign in to Ordinate</h1>
          <p className={s.lede}>
            {proxied
              ? "This server signs you in through your company's access proxy. Open Ordinate from its usual address and you'll be signed in automatically."
              : "Use your work account. You'll go to your company's sign-in page and come straight back here."}
          </p>

          {error !== null && (
            <div className={s.alert} role="alert">
              <span className={s.alertIcon}>
                <Icon name="alert" />
              </span>
              <div>
                <p className={s.alertTitle}>We couldn't sign you in</p>
                <p className={s.alertBody}>{ERRORS[error] ?? GENERIC}</p>
              </div>
            </div>
          )}

          {!proxied && (
            <a className={buttonClass('primary', 'lg', s.go)} href={login}>
              <span>{error !== null ? 'Try again' : 'Continue with single sign-on'}</span>
              <Icon name="arrow-right" />
            </a>
          )}

          <p className={s.fine}>
            Ordinate never sees your password. If you can't get in, your Ordinate administrator manages who has
            access.
          </p>
        </div>
      </main>
    </div>
  );
}
