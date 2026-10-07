// The frame of the pages outside the shell (sign-in, change password): a brand
// panel beside the form column. Narrow windows drop the panel for a compact mark.

import type { ReactNode } from 'react';
import { Icon } from '../../ui/icons/Icon';
import s from './SignInPage.module.css';

const SSO_POINTS: { icon: 'shield' | 'lock' | 'layers'; text: string }[] = [
  { icon: 'shield', text: 'Your company account, through your own identity provider' },
  { icon: 'lock', text: 'Runs in your infrastructure — your data stays there' },
  { icon: 'layers', text: 'Data, visuals and dashboards in one workspace' },
];

const PASSWORD_POINTS: typeof SSO_POINTS = [
  { icon: 'shield', text: 'Accounts managed by your Ordinate administrator' },
  SSO_POINTS[1],
  SSO_POINTS[2],
];

/** `passwords`: the server signs in with its own passwords, not an identity provider. */
export function AuthLayout({ passwords, children }: { passwords: boolean; children: ReactNode }) {
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
            {(passwords ? PASSWORD_POINTS : SSO_POINTS).map((p) => (
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
          {children}
        </div>
      </main>
    </div>
  );
}

/** The red box a refused sign-in shows above the form. */
export function AuthAlert({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={s.alert} role="alert">
      <span className={s.alertIcon}>
        <Icon name="alert" />
      </span>
      <div>
        <p className={s.alertTitle}>{title}</p>
        <p className={s.alertBody}>{children}</p>
      </div>
    </div>
  );
}
