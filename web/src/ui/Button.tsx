// Buttons — hub.css `.btn` / `.icon-btn`: four variants in three heights
// (28 / 32 / 36), 32 by default so a button beside a field is the field's
// height. `loading` is the one place a spinner survives (hub.css "the last
// spinner"): a control with an action in flight has no room for a skeleton.

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './icons/Icon';
import s from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ControlSize = 'sm' | 'md' | 'lg';

/** The class list for anything that should LOOK like a button — a router <Link>, say. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ControlSize = 'md', extra?: string) {
  return [s.btn, s[variant], s[size], extra].filter(Boolean).join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: IconName;
  /** Trailing icon, e.g. a chevron on a menu button. */
  iconEnd?: IconName;
  loading?: boolean;
  block?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconEnd, loading, block, className, disabled, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClass(variant, size, [block && s.block, loading && s.loading, className].filter(Boolean).join(' '))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className={s.spinner} aria-hidden="true" /> : icon && <Icon name={icon} />}
      {children != null && <span>{children}</span>}
      {iconEnd && <Icon name={iconEnd} />}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Required: the glyph is aria-hidden, so this is the control's only name. */
  label: string;
  size?: ControlSize;
  variant?: 'ghost' | 'primary';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', variant = 'ghost', className, type, title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={title ?? label}
      className={[s.iconBtn, s[size], variant === 'primary' && s.iconPrimary, className].filter(Boolean).join(' ')}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
});
