// Page building blocks the shell and the placeholder routes need: the page
// frame, and the empty / error / loading states every surface must design for
// (plan §7). Shapes and tokens follow hub.css's `.ws-empty` and `.sk`.
// ponytail: the minimum set for the shell; T0.7's kit (web/src/ui/) supersedes
// EmptyState / ErrorState / Skeleton with the full component family.

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import s from './blocks.module.css';

export function Page({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1 className={s.title}>{title}</h1>
        {sub && <p className={s.sub}>{sub}</p>}
      </header>
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <span className={s.emptyIcon}>
        <Icon name={icon} size={20} />
      </span>
      <h2 className={s.emptyTitle}>{title}</h2>
      {children && <p className={s.emptyBody}>{children}</p>}
      {actions && <div className={s.emptyActions}>{actions}</div>}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className={`${s.empty} ${s.error}`} role="alert">
      <span className={s.emptyIcon}>
        <Icon name="alert" size={20} />
      </span>
      <h2 className={s.emptyTitle}>{title}</h2>
      <p className={s.emptyBody}>{message}</p>
      {onRetry && (
        <div className={s.emptyActions}>
          <button type="button" className={s.btn} onClick={onRetry}>
            <Icon name="refresh" />
            <span>Try again</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** A list arriving: `rows` bars that hold the layout so nothing jumps when data lands. */
export function SkeletonRows({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <div className={s.skList} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skRow}>
          <span className={`${s.sk} ${s.skIcon}`} />
          <span className={`${s.sk} ${s.skText}`} />
          <span className={`${s.sk} ${s.skMeta}`} />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className={s.page} role="status" aria-busy="true" aria-label="Loading page">
      <span className={`${s.sk} ${s.skTitle}`} />
      <div className={s.skList}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`${s.sk} ${s.skBlock}`} />
        ))}
      </div>
    </div>
  );
}

/** An area that has not been ported to the browser yet. */
export function NotPortedYet({ title, icon, blurb }: { title: string; icon: IconName; blurb: string }) {
  return (
    <Page title={title}>
      <EmptyState icon={icon} title={`${title} is on its way to the browser`}>
        {blurb} Until it lands here, the desktop app has the full {title.toLowerCase()} area.
      </EmptyState>
    </Page>
  );
}
