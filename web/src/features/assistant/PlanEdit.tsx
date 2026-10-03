// The plan card's Edit mode — planEdit.ts, ported: reorder, remove, or change
// a step's parameters before the run starts. Every field is a plain input
// bound to the step; "Done editing" sends the list back through plan:check, so
// an edit is judged by exactly the validators the Assistant's own steps were.
// Nothing here decides validity.

import { IconButton } from '../../ui/Button';
import s from './Plan.module.css';

export type Step = { kind: string } & Record<string, unknown>;

interface PlField {
  key: string;
  label: string;
  kind?: 'text' | 'number' | 'list' | 'select';
  options?: string[];
  wide?: boolean;
}

const AGGS = ['sum', 'avg', 'count', 'min', 'max'];

/** The editable fields per step kind. Paths are dotted into the step object. */
const FIELDS: Record<string, PlField[]> = {
  import: [{ key: 'file', label: 'File' }, { key: 'name', label: 'Dataset name' }],
  calc: [{ key: 'dataset', label: 'Dataset' }, { key: 'name', label: 'Column' }, { key: 'expression', label: 'Formula', wide: true }],
  metric: [
    { key: 'dataset', label: 'Dataset' },
    { key: 'name', label: 'Metric' },
    { key: 'column', label: 'Column' },
    { key: 'aggregation', label: 'Aggregation', kind: 'select', options: AGGS },
  ],
  chart: [
    { key: 'dataset', label: 'Dataset' },
    { key: 'name', label: 'Visual' },
    { key: 'chartType', label: 'Chart type' },
    { key: 'encoding.category', label: 'Category' },
    { key: 'encoding.values.0.column', label: 'Measure' },
    { key: 'encoding.values.0.aggregation', label: 'Aggregation', kind: 'select', options: AGGS },
  ],
  dashboard: [
    { key: 'name', label: 'Dashboard' },
    { key: 'visuals', label: 'Visuals (comma-separated)', kind: 'list', wide: true },
    { key: 'metrics', label: 'Metrics (comma-separated)', kind: 'list', wide: true },
  ],
  style: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'preset', label: 'Style', kind: 'select', options: ['clean', 'executive', 'dense', 'dark'] },
  ],
  alert: [
    { key: 'metric', label: 'Metric' },
    { key: 'op', label: 'When', kind: 'select', options: ['>', '<', '>=', '<='] },
    { key: 'value', label: 'Value', kind: 'number' },
    { key: 'name', label: 'Alert name' },
  ],
};

/** A prepare step's own fields — whatever scalar/list keys it carries besides its type. */
function prepareFields(step: Step): PlField[] {
  const inner = step.step && typeof step.step === 'object' ? (step.step as Record<string, unknown>) : {};
  const out: PlField[] = [{ key: 'dataset', label: 'Dataset' }];
  for (const k of Object.keys(inner)) {
    if (k === 'type') continue;
    const v = inner[k];
    if (Array.isArray(v)) out.push({ key: 'step.' + k, label: k, kind: 'list' });
    else if (v === null || typeof v === 'string' || typeof v === 'number') out.push({ key: 'step.' + k, label: k });
  }
  return out;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/** A copy of `step` with `path` set to `value`, creating the containers on the way. */
function setPath(step: Step, path: string, value: unknown): Step {
  const next = structuredClone(step);
  const keys = path.split('.');
  let o = next as Record<string, unknown>;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k] as Record<string, unknown>;
  });
  o[keys[keys.length - 1]] = value;
  return next;
}

export function EditFields({ step, index, onChange }: { step: Step; index: number; onChange: (s: Step) => void }) {
  const fields = step.kind === 'step' ? prepareFields(step) : (FIELDS[step.kind] ?? []);
  return (
    <div className={s.edit}>
      {fields.map((f) => {
        const cur = getPath(step, f.key);
        const shown = cur == null ? '' : Array.isArray(cur) ? cur.join(', ') : String(cur);
        const commit = (raw: string) => {
          let v: unknown = raw;
          if (f.kind === 'list') v = raw.split(',').map((x) => x.trim()).filter(Boolean);
          else if (f.kind === 'number' || typeof cur === 'number') v = raw.trim() === '' ? null : Number(raw);
          onChange(setPath(step, f.key, v));
        };
        const name = `Step ${index + 1} ${f.label}`;
        return (
          <label key={f.key} className={f.wide ? `${s.field} ${s.wide}` : s.field}>
            <span className={s.fieldLabel}>{f.label}</span>
            {f.kind === 'select' ? (
              <select className={s.input} aria-label={name} value={shown} onChange={(e) => commit(e.target.value)}>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={s.input}
                aria-label={name}
                type={f.kind === 'number' ? 'number' : 'text'}
                defaultValue={shown}
                onBlur={(e) => e.target.value !== shown && commit(e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

export function EditControls({ index, count, onMove, onRemove }: { index: number; count: number; onMove: (to: number) => void; onRemove: () => void }) {
  return (
    <div className={s.editCtl}>
      <IconButton icon="arrow-up" size="sm" label={`Move up — step ${index + 1}`} disabled={index === 0} onClick={() => onMove(index - 1)} />
      <IconButton icon="arrow-down" size="sm" label={`Move down — step ${index + 1}`} disabled={index === count - 1} onClick={() => onMove(index + 1)} />
      <IconButton icon="trash" size="sm" label={`Remove — step ${index + 1}`} disabled={count <= 1} onClick={onRemove} />
    </div>
  );
}
