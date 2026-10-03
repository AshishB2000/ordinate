// Text fields — hub.css "fields": one height (32), one border, one radius, so
// an input, a select and a button on the same row line up. `Field` is the
// label / hint / error frame every control in the kit shares: it owns the ids,
// so a control is always named by its label and described by its hint or error.

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons/Icon';
import s from './Field.module.css';

export interface FieldFrame {
  label?: string;
  hint?: string;
  /** A message turns the control invalid (aria-invalid) and replaces the hint. */
  error?: string;
}

/** Ids for a control inside a Field: its own, and what describes it. */
export function useFieldIds(id: string | undefined, f: FieldFrame) {
  const auto = useId();
  const controlId = id ?? auto;
  const msgId = `${controlId}-msg`;
  return { controlId, msgId, describedBy: f.error || f.hint ? msgId : undefined, invalid: f.error ? true : undefined };
}

export function Field({
  label,
  hint,
  error,
  controlId,
  msgId,
  labelId,
  children,
}: FieldFrame & { controlId: string; msgId: string; labelId?: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      {label && (
        <label className={s.label} htmlFor={controlId} id={labelId}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <span className={s.error} id={msgId}>
          <Icon name="alert" size={12} />
          {error}
        </span>
      ) : (
        hint && (
          <span className={s.hint} id={msgId}>
            {hint}
          </span>
        )
      )}
    </div>
  );
}

export interface InputProps extends FieldFrame, Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Leading icon inside the field (a search glass, say). */
  icon?: IconName;
  size?: 'sm' | 'md';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, icon, size = 'md', id, className, ...rest },
  ref,
) {
  const ids = useFieldIds(id, { hint, error });
  return (
    <Field label={label} hint={hint} error={error} controlId={ids.controlId} msgId={ids.msgId}>
      <span className={[s.box, size === 'sm' && s.sm, className].filter(Boolean).join(' ')}>
        {icon && <Icon name={icon} />}
        <input
          ref={ref}
          id={ids.controlId}
          className={s.input}
          aria-invalid={ids.invalid}
          aria-describedby={ids.describedBy}
          {...rest}
        />
      </span>
    </Field>
  );
});

export interface TextareaProps extends FieldFrame, TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, id, className, rows = 4, ...rest },
  ref,
) {
  const ids = useFieldIds(id, { hint, error });
  return (
    <Field label={label} hint={hint} error={error} controlId={ids.controlId} msgId={ids.msgId}>
      <textarea
        ref={ref}
        id={ids.controlId}
        rows={rows}
        className={[s.textarea, className].filter(Boolean).join(' ')}
        aria-invalid={ids.invalid}
        aria-describedby={ids.describedBy}
        {...rest}
      />
    </Field>
  );
});
