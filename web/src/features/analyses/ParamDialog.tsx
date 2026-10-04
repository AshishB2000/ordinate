// Define (or edit) one dashboard parameter and the control that moves it
// (legacy paramDialog.ts). The validation here is for the AUTHOR — a name that
// is not an identifier, a minimum above its maximum, a default outside its own
// bounds — said inline; the server re-validates everything
// (analysis/params.ts sanitizeParameters).

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input, Textarea } from '../../ui/Field';
import type { Parameter } from './api';
import s from './editor/Dialogs.module.css';

const KINDS: { kind: Parameter['kind']; label: string; hint: string }[] = [
  { kind: 'number', label: 'Number', hint: 'A slider with bounds' },
  { kind: 'text', label: 'Text', hint: 'Typed, or picked' },
  { kind: 'date', label: 'Date', hint: 'A date picker' },
  { kind: 'list', label: 'List', hint: 'Several values' },
];
export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export type ParamDraft = Omit<Parameter, 'id'>;

interface Fields {
  name: string;
  kind: Parameter['kind'];
  value: string;
  min: string;
  max: string;
  step: string;
  options: string;
}

function fieldsOf(p: Parameter | undefined): Fields {
  const v = p?.value;
  return {
    name: p?.name ?? '',
    kind: p?.kind ?? 'number',
    value: v == null ? (p ? '' : '1000') : Array.isArray(v) ? v.join(', ') : String(v),
    min: p ? (p.min === undefined ? '' : String(p.min)) : '0',
    max: p ? (p.max === undefined ? '' : String(p.max)) : '10000',
    step: p ? (p.step === undefined ? '' : String(p.step)) : '100',
    options: p && Array.isArray(p.list) ? p.list.join('\n') : '',
  };
}

/** The parameter as typed, or why it cannot be saved (paramDialog.ts build). Exported for its test. */
export function buildParam(f: Fields, taken: (name: string) => boolean): { param?: ParamDraft; error?: string } {
  const name = f.name.trim();
  if (!PARAM_NAME_RE.test(name)) return { error: 'A name starts with a letter and uses letters, digits and underscores.' };
  if (taken(name)) return { error: `This dashboard already has a parameter called "${name}".` };
  const num = (raw: string): number | undefined => (raw.trim() === '' ? undefined : Number.isFinite(Number(raw)) ? Number(raw) : NaN);
  if (f.kind === 'number') {
    const [v, min, max, step] = [num(f.value), num(f.min), num(f.max), num(f.step)];
    if ([v, min, max, step].some((x) => Number.isNaN(x))) return { error: 'Numbers only in the number fields.' };
    if (min !== undefined && max !== undefined && min > max) return { error: 'The minimum is above the maximum.' };
    if (v !== undefined && ((min !== undefined && v < min) || (max !== undefined && v > max))) return { error: 'The default is outside the bounds.' };
    if (step !== undefined && step <= 0) return { error: 'The step must be above zero.' };
    return {
      param: { name, kind: 'number', value: v ?? null, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step !== undefined ? { step } : {}) },
    };
  }
  if (f.kind === 'date') return { param: { name, kind: 'date', value: f.value || null } };
  const opts = f.options.split('\n').map((x) => x.trim()).filter(Boolean);
  const value = f.kind === 'list' ? f.value.split(',').map((x) => x.trim()).filter(Boolean) : f.value || null;
  if (opts.length && f.kind === 'text' && value && !opts.includes(value as string)) return { error: 'The default is not one of the options.' };
  return { param: { name, kind: f.kind, value, ...(opts.length ? { list: opts } : {}) } };
}

export function ParamDialog({
  existing,
  label: existingLabel,
  others,
  onDone,
  onClose,
}: {
  existing?: Parameter;
  label?: string;
  /** The dashboard's other parameter names — a clash is refused. */
  others: string[];
  onDone: (param: ParamDraft, label: string) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<Fields>(() => fieldsOf(existing));
  const [label, setLabel] = useState(existingLabel ?? '');
  const sameKind = existing && existing.kind === f.kind;
  const r = buildParam(f, (n) => others.some((o) => o.toLowerCase() === n.toLowerCase()));
  const set = (patch: Partial<Fields>) => setF((x) => ({ ...x, ...patch }));
  const ref = f.name.trim() || 'name';
  const submit = () => {
    if (!r.param) return;
    onDone(r.param, label.trim());
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={existing ? 'Edit parameter' : 'Add a parameter'}
      description="A value the reader moves, that the sheet refers to by name."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" disabled={!r.param} onClick={submit}>
            {existing ? 'Save' : 'Add parameter'}
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input label="Name" placeholder="threshold" spellCheck={false} value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus maxLength={40} />
        <div className={s.refs}>
          <span>
            <code>[[{ref}]]</code> in filters and formulas
          </span>
          <span>
            <code>{`{{${ref}}}`}</code> in titles and text
          </span>
        </div>
        <div className={s.kinds} role="radiogroup" aria-label="Type">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={k.kind === f.kind}
              className={k.kind === f.kind ? `${s.kind} ${s.on}` : s.kind}
              onClick={() => set({ kind: k.kind, ...(sameKind || k.kind === existing?.kind ? {} : { value: k.kind === 'number' ? '1000' : '' }) })}
            >
              <span className={s.kindLabel}>{k.label}</span>
              <span className={s.kindHint}>{k.hint}</span>
            </button>
          ))}
        </div>
        {f.kind === 'number' && (
          <>
            <Input label="Default" type="number" value={f.value} onChange={(e) => set({ value: e.target.value })} />
            <div className={s.bounds}>
              <Input label="Minimum" type="number" placeholder="none" value={f.min} onChange={(e) => set({ min: e.target.value })} />
              <Input label="Maximum" type="number" placeholder="none" value={f.max} onChange={(e) => set({ max: e.target.value })} />
              <Input label="Step" type="number" placeholder="any" value={f.step} onChange={(e) => set({ step: e.target.value })} />
            </div>
            <p className={s.hint}>With both a minimum and a maximum the control is a slider; otherwise a number box.</p>
          </>
        )}
        {f.kind === 'date' && <Input label="Default" type="date" value={f.value} onChange={(e) => set({ value: e.target.value })} />}
        {(f.kind === 'text' || f.kind === 'list') && (
          <>
            <Input
              label={f.kind === 'list' ? 'Default values (comma-separated)' : 'Default'}
              placeholder={f.kind === 'list' ? 'West, East' : 'Any text'}
              value={f.value}
              onChange={(e) => set({ value: e.target.value })}
            />
            <Textarea
              label="Options"
              rows={3}
              placeholder="One option per line — leave empty for a free text box"
              value={f.options}
              onChange={(e) => set({ options: e.target.value })}
            />
          </>
        )}
        <Input label="Label" placeholder="Shown on the chip — defaults to the name" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        {r.error && (
          <p className={s.error} role="alert">
            {r.error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
