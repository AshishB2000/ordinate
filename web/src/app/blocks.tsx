// The page frame every route renders in, and the ONE page header
// (docs/design-floor): the parent crumb above the title, the title (a string,
// or a node for an editable name), status chips after it, a sentence or a meta
// row under it, and the actions on the right — at most one primary. A
// workspace that fills the window under a bar of its own renders <PageHead> in
// that bar. The states inside a page (empty / error / loading) are the UI
// kit's (web/src/ui); they are re-exported here so a page keeps one import.

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { PRIMARY_SELECTOR } from '../ui/Button';
import { Icon } from '../ui/icons/Icon';
import s from './blocks.module.css';

export { EmptyState, ErrorState } from '../ui/States';
export { PageSkeleton, SkeletonRows } from '../ui/Skeleton';

/** Where a page's back crumb goes, and what it says: the parent page's own heading. */
export interface Back {
  to: string;
  label: string;
}

export interface PageHeadProps {
  title: ReactNode;
  /** A sentence (a string, set as a paragraph) or a meta row (a node). */
  sub?: ReactNode;
  back?: Back;
  /** Chips right after the title: View only, a save state, Live. */
  status?: ReactNode;
  /** Right-aligned; at most one primary. */
  actions?: ReactNode;
  /** A workspace bar's own padding and surface, when the head is not inside <Page>. */
  className?: string;
}

/** The way to a page's parent: the one back link in the app. `iconOnly` for a phone's 44px bar. */
export function BackLink({ to, label, iconOnly = false, className }: Back & { iconOnly?: boolean; className?: string }) {
  return (
    <Link className={className ?? s.back} to={to} aria-label={iconOnly ? `Back to ${label}` : undefined}>
      <Icon name="arrow-left" size={iconOnly ? 20 : 16} />
      {!iconOnly && <span>{label}</span>}
    </Link>
  );
}

export function PageHead({ title, sub, back, status, actions, className }: PageHeadProps) {
  const bar = useRef<HTMLDivElement>(null);
  // A second primary is a console error, so the e2e harness fails any page that shows one.
  useLayoutEffect(() => {
    const n = bar.current?.querySelectorAll(PRIMARY_SELECTOR).length ?? 0;
    if (n > 1) console.error(`A page header holds at most one primary action; "${typeof title === 'string' ? title : 'this page'}" has ${n}.`);
  });
  return (
    <header className={className ? `${s.head} ${className}` : s.head}>
      {back && <BackLink to={back.to} label={back.label} />}
      <div className={s.row}>
        <div className={s.text}>
          <div className={s.titleRow}>
            <h1 className={s.title}>{title}</h1>
            {status}
          </div>
          {sub != null && sub !== false && sub !== '' && (typeof sub === 'string' ? <p className={s.sub}>{sub}</p> : <div className={`${s.sub} ${s.meta}`}>{sub}</div>)}
        </div>
        {actions && (
          <div ref={bar} className={s.actions}>
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

export function Page({ children, ...head }: Omit<PageHeadProps, 'className'> & { children: ReactNode }) {
  return (
    <div className={s.page}>
      <PageHead {...head} />
      {children}
    </div>
  );
}

/**
 * The router state a link passes so the page it opens can crumb back here
 * (useCameFrom). Never a blank name — an untitled record is named by its kind —
 * because a blank crumb is refused and the reader would be sent to the parent.
 */
export function backTo(to: string, name: string | undefined, kind: string): { back: Back } {
  return { back: { to, label: name?.trim() || kind } };
}

/**
 * The crumb for a page with more than one way in: the `state.back` its opener
 * passed (a link from somewhere that is not the parent), else the parent.
 */
export function useCameFrom(parent: Back): Back {
  const b = (useLocation().state as { back?: Partial<Back> } | null)?.back;
  const ok = !!b && typeof b.to === 'string' && b.to.startsWith('/') && !b.to.startsWith('//') && typeof b.label === 'string' && b.label !== '';
  return ok ? { to: b.to as string, label: b.label as string } : parent;
}
