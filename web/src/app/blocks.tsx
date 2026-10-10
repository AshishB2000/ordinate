// The page frame every route renders in. The states inside a page (empty /
// error / loading) are the UI kit's (web/src/ui); they are re-exported here so
// a page keeps one import.

import type { ReactNode } from 'react';
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
