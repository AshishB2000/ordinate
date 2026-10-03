// Empty and error states — hub.css "EMPTY STATE — one component, six
// surfaces" / emptyState.ts: an icon in a 48px circle, a 15px title, one
// muted line, then at most a primary and a ghost action. `compact` is the
// density variant for small hosts (a rail, a dropdown, a dock) — density only,
// never a restyle of the parts.

import type { ReactNode } from 'react';
import { Button } from './Button';
import { Icon, type IconName } from './icons/Icon';
import s from './States.module.css';

export function EmptyState({
  icon,
  title,
  children,
  actions,
  compact,
  heading = 2,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  /** The title's heading level, so it nests correctly under the page's. */
  heading?: 2 | 3 | 4;
}) {
  const H = `h${heading}` as const;
  return (
    <div className={compact ? `${s.empty} ${s.compact}` : s.empty}>
      <span className={s.icon}>
        <Icon name={icon} size={compact ? 16 : 20} />
      </span>
      <H className={s.title}>{title}</H>
      {children && <p className={s.body}>{children}</p>}
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}

/** A failed load: the same frame, an error mark, the message, and a retry. */
export function ErrorState({
  title,
  message,
  onRetry,
  compact,
  heading = 2,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  compact?: boolean;
  heading?: 2 | 3 | 4;
}) {
  const H = `h${heading}` as const;
  return (
    <div className={[s.empty, s.error, compact && s.compact].filter(Boolean).join(' ')} role="alert">
      <span className={s.icon}>
        <Icon name="alert" size={compact ? 16 : 20} />
      </span>
      <H className={s.title}>{title}</H>
      <p className={s.body}>{message}</p>
      {onRetry && (
        <div className={s.actions}>
          <Button icon="refresh" size={compact ? 'sm' : 'md'} onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
