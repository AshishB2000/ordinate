// The page frame every route renders in, and the placeholder for an area not
// ported yet. The states inside a page (empty / error / loading) are the UI
// kit's (web/src/ui); they are re-exported here so the placeholder routes keep
// their one import.

import type { ReactNode } from 'react';
import type { IconName } from '../ui/icons/Icon';
import { EmptyState } from '../ui/States';
import s from './blocks.module.css';

export { EmptyState, ErrorState } from '../ui/States';
export { PageSkeleton, SkeletonRows } from '../ui/Skeleton';

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
