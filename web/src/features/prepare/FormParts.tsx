// The small controls every step form is built from (legacy prepareForms.ts's
// builders: fieldRow, makeColSelect, makeColChecks, makeNameSelect, the preview
// box), on the UI kit. A form is a controlled view over a Draft: it reads
// `draft`, writes with `set(patch)`, and owns nothing else.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Checkbox } from '../../ui/Choice';
import { IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import type { Column } from './api';
import type { Draft } from './drafts';
import s from './Prepare.module.css';

export interface FormCtx {
  projectId: string;
  datasetId: string;
  /** The step being edited, or -1 for a new one (previews read the input it would get). */
  index: number;
  /** The prepared columns as they stand now. */
  columns: Column[];
  /** id → name of the project's datasets. */
  names: ReadonlyMap<string, string>;
  /** Opens a text column's profile (the text steps' "Profile this column"). */
  openProfile?: (column: string) => void;
}

export interface FormProps {
  draft: Draft;
  set: (patch: Draft) => void;
  ctx: FormCtx;
}

export const str = (v: unknown): string => (v == null ? '' : String(v));
export const arr = <T = unknown,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** A <Select> over names; `blank` adds a first option whose value is ''. */
export function NameSelect({
  label,
  value,
  names,
  onChange,
  blank,
  ariaLabel,
}: {
  label?: string;
  value: string;
  names: readonly string[];
  onChange: (v: string) => void;
  blank?: string;
  ariaLabel?: string;
}) {
  const options = [...(blank !== undefined ? [{ value: '', label: blank }] : []), ...names.map((n) => ({ value: n, label: n }))];
  return (
    <Select
      label={label}
      aria-label={ariaLabel ?? label}
      size="sm"
      value={value}
      onValueChange={onChange}
      options={options}
      placeholder={names.length ? 'Choose…' : 'No columns'}
    />
  );
}

/** A <Select> over labelled values. */
export function PickSelect({
  label,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  label?: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  return (
    <Select
      label={label}
      aria-label={ariaLabel ?? label}
      size="sm"
      value={value}
      onValueChange={onChange}
      options={options.map(([v, l]) => ({ value: v, label: l }))}
    />
  );
}

/** A column select over the current columns. */
export function ColumnSelect(p: { label?: string; value: string; columns: readonly Column[]; onChange: (v: string) => void; blank?: string; ariaLabel?: string }) {
  return <NameSelect {...p} names={p.columns.map((c) => c.name)} />;
}

/** A checkbox per name; the value is the checked ones, in the list's order. */
export function NameChecks({ label, names, value, onChange }: { label: string; names: readonly string[]; value: readonly string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className={s.checks}>
      <legend className={s.legend}>{label}</legend>
      {names.length === 0 && <span className={s.hint}>No columns to choose from.</span>}
      <div className={s.checkGrid}>
        {names.map((n) => (
          <Checkbox
            key={n}
            label={n}
            checked={value.includes(n)}
            onCheckedChange={(on) => onChange(names.filter((x) => (x === n ? on : value.includes(x))))}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** A text field bound to one draft key. */
export function TextField({ label, value, onChange, placeholder, type = 'text', min, max }: { label: string; value: unknown; onChange: (v: string) => void; placeholder?: string; type?: 'text' | 'number'; min?: number; max?: number }) {
  return <Input label={label} size="sm" type={type} min={min} max={max} value={str(value)} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className={s.hint}>{children}</p>;
}

/** A row of controls with a remove button (an aggregation, a rule, a pair). */
export function RowLine({ children, onRemove, removeLabel }: { children: ReactNode; onRemove: () => void; removeLabel: string }) {
  return (
    <div className={s.ruleRow}>
      {children}
      <IconButton icon="x" size="sm" label={removeLabel} onClick={onRemove} />
    </div>
  );
}

/** The live preview under a form: what the server counted, laid out. `warn` tints it. */
export function PreviewBox({ children, warn, busy }: { children: ReactNode; warn?: boolean; busy?: boolean }) {
  return (
    <div className={[s.preview, warn && s.previewWarn].filter(Boolean).join(' ')} aria-live="polite" aria-busy={busy || undefined}>
      {children}
    </div>
  );
}

/**
 * Asks the server what `step` would do, 250 ms after it stops changing; null
 * key = nothing to ask. A slower earlier reply never overwrites a newer one.
 */
export function usePreview<T>(key: string | null, ask: () => Promise<T>): { data: T | null; busy: boolean; error: string | null } {
  const [state, setState] = useState<{ data: T | null; busy: boolean; error: string | null }>({ data: null, busy: false, error: null });
  const seq = useRef(0);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    const mine = ++seq.current;
    if (key === null) {
      setState({ data: null, busy: false, error: null });
      return;
    }
    setState((s0) => ({ ...s0, busy: true }));
    const t = setTimeout(() => {
      askRef.current().then(
        (data) => mine === seq.current && setState({ data, busy: false, error: null }),
        (e: unknown) => mine === seq.current && setState({ data: null, busy: false, error: e instanceof Error ? e.message : 'Could not preview.' }),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [key]);
  return state;
}
