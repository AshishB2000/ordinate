// Checkbox, Switch, RadioGroup — NATIVE inputs, restyled. The browser already
// gives them the right role, Space to toggle, arrow keys between radios, form
// participation and label clicks; Radix has no package for them in plan §2
// and none is needed. `appearance: none` drops only the paint.

import { forwardRef, useEffect, useId, useRef, type InputHTMLAttributes } from 'react';
import { Icon } from './icons/Icon';
import s from './Choice.module.css';

type Native = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked' | 'size'>;

export interface CheckboxProps extends Native {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The "some of these" state of a select-all box. */
  indeterminate?: boolean;
  hint?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, checked, onCheckedChange, indeterminate = false, hint, className, id, ...rest },
  outer,
) {
  const inner = useRef<HTMLInputElement>(null);
  const auto = useId();
  const cid = id ?? auto;
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span className={[s.row, className].filter(Boolean).join(' ')}>
      <span className={s.boxWrap}>
        <input
          ref={(el) => {
            inner.current = el;
            if (typeof outer === 'function') outer(el);
            else if (outer) outer.current = el;
          }}
          id={cid}
          type="checkbox"
          className={s.box}
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
          aria-describedby={hint ? `${cid}-hint` : undefined}
          {...rest}
        />
        <span className={s.mark} aria-hidden="true">
          <Icon name={indeterminate ? 'minus' : 'check'} size={12} />
        </span>
      </span>
      <span className={s.text}>
        <label htmlFor={cid} className={s.label}>
          {label}
        </label>
        {hint && (
          <span id={`${cid}-hint`} className={s.hint}>
            {hint}
          </span>
        )}
      </span>
    </span>
  );
});

export interface SwitchProps extends Native {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  hint?: string;
}

/** hub.css `.stp-switch`: an on/off that takes effect immediately (no Save). */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, checked, onCheckedChange, hint, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <span className={[s.row, s.switchRow, className].filter(Boolean).join(' ')}>
      <span className={s.text}>
        <label htmlFor={cid} className={s.label}>
          {label}
        </label>
        {hint && (
          <span id={`${cid}-hint`} className={s.hint}>
            {hint}
          </span>
        )}
      </span>
      <input
        ref={ref}
        id={cid}
        type="checkbox"
        role="switch"
        className={s.switch}
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        aria-describedby={hint ? `${cid}-hint` : undefined}
        {...rest}
      />
    </span>
  );
});

export interface RadioGroupProps {
  /** The group's visible name (a <legend>). */
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string; hint?: string; disabled?: boolean }[];
  /** Defaults to a unique name; pass one to take part in a <form>. */
  name?: string;
  orientation?: 'vertical' | 'horizontal';
  disabled?: boolean;
  error?: string;
}

export function RadioGroup({
  label,
  value,
  onValueChange,
  options,
  name,
  orientation = 'vertical',
  disabled,
  error,
}: RadioGroupProps) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset
      className={[s.group, orientation === 'horizontal' && s.horizontal].filter(Boolean).join(' ')}
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${group}-err` : undefined}
    >
      <legend className={s.legend}>{label}</legend>
      <div className={s.options}>
        {options.map((o) => {
          const rid = `${group}-${o.value}`;
          return (
            <span key={o.value} className={s.row}>
              <input
                id={rid}
                type="radio"
                className={s.radio}
                name={group}
                value={o.value}
                checked={o.value === value}
                disabled={o.disabled}
                onChange={() => onValueChange(o.value)}
                aria-describedby={o.hint ? `${rid}-hint` : undefined}
              />
              <span className={s.text}>
                <label htmlFor={rid} className={s.label}>
                  {o.label}
                </label>
                {o.hint && (
                  <span id={`${rid}-hint`} className={s.hint}>
                    {o.hint}
                  </span>
                )}
              </span>
            </span>
          );
        })}
      </div>
      {error && (
        <span id={`${group}-err`} className={s.error}>
          <Icon name="alert" size={12} />
          {error}
        </span>
      )}
    </fieldset>
  );
}
