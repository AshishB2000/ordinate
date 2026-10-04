// Power-step forms, CLEAN family — parse dates, keep one row per key, replace
// values, conditional column (legacy prepareClean.ts). The parse-date preview
// is counted by the server over the step's real input (prepare:stepPreview).

import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { previewPower } from './api';
import { buildStep, PARSE_FORMATS } from './drafts';
import { fmtN } from './steps';
import { arr, ColumnSelect, Hint, NameChecks, NameSelect, PickSelect, PreviewBox, RowLine, str, TextField, usePreview, type FormProps } from './FormParts';
import s from './Prepare.module.css';

export function ParseDateForm({ draft, set, ctx }: FormProps) {
  const built = buildStep('parse_date', draft, ctx.columns);
  const step = 'steps' in built ? built.steps[0] : null;
  const p = usePreview(step ? JSON.stringify(step) : null, () => previewPower(ctx.projectId, ctx.datasetId, ctx.index, step!));
  const pd = p.data?.ok ? p.data.parseDate : null;
  return (
    <>
      <ColumnSelect label="Column" value={str(draft.column)} columns={ctx.columns} onChange={(column) => set({ column })} />
      <NameSelect label="Format (a value that does not match, or is not a real date, becomes empty)" value={str(draft.format)} names={PARSE_FORMATS} onChange={(format) => set({ format })} />
      <TextField label="New column name" value={draft.as} placeholder="(replace the column in place)" onChange={(as) => set({ as })} />
      {step && (
        <PreviewBox busy={p.busy} warn={!!pd && pd.failed > 0 || (p.data !== null && !p.data.ok)}>
          {pd ? (
            <>
              <div>
                {fmtN(pd.parsed)} of {fmtN(pd.filled)} values parsed · {fmtN(pd.failed)} failed{pd.empty ? ` · ${fmtN(pd.empty)} empty` : ''}
              </div>
              {pd.samples.length > 0 && <div>Did not parse: {pd.samples.map((x) => `"${x}"`).join(', ')}</div>}
            </>
          ) : (
            <div>{p.error ?? (p.data && !p.data.ok ? p.data.error : 'Counting…')}</div>
          )}
        </PreviewBox>
      )}
    </>
  );
}

const KEEP: readonly (readonly [string, string])[] = [
  ['first', 'the first row'],
  ['last', 'the last row'],
  ['max', 'the row with the highest…'],
  ['min', 'the row with the lowest…'],
];

export function DedupeKeyForm({ draft, set, ctx }: FormProps) {
  const keep = str(draft.keep) || 'first';
  return (
    <>
      <NameChecks label="Key columns" names={ctx.columns.map((c) => c.name)} value={arr<string>(draft.columns)} onChange={(columns) => set({ columns })} />
      <PickSelect label="For each key, keep" value={keep} options={KEEP} onChange={(v) => set({ keep: v })} />
      {(keep === 'max' || keep === 'min') && (
        <ColumnSelect label="…of this column (ties keep the earlier row)" value={str(draft.by)} columns={ctx.columns} onChange={(by) => set({ by })} />
      )}
    </>
  );
}

const REPLACE_HINTS: Record<string, string> = {
  exact: 'A cell equal to "find" becomes "replace with"; the first matching rule wins.',
  contains: 'Every occurrence of "find" is replaced; the rules apply one after another, in order.',
  regex: 'Every match of the pattern is replaced (no lookaround or backreferences); rules apply in order.',
};

export function ReplaceForm({ draft, set, ctx }: FormProps) {
  const mode = str(draft.mode) || 'exact';
  const rules = arr<Record<string, unknown>>(draft.rules);
  const put = (i: number, patch: Record<string, unknown>) => set({ rules: rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  return (
    <>
      <ColumnSelect label="Column" value={str(draft.column)} columns={ctx.columns} onChange={(column) => set({ column })} />
      <PickSelect label="Match" value={mode} options={[['exact', 'exact'], ['contains', 'contains'], ['regex', 'regex']]} onChange={(m) => set({ mode: m })} />
      {mode === 'regex' && <Checkbox label="Ignore case" checked={!!draft.ignoreCase} onCheckedChange={(ignoreCase) => set({ ignoreCase })} />}
      <Hint>{REPLACE_HINTS[mode]}</Hint>
      <div className={s.rules}>
        {rules.map((r, i) => (
          <RowLine key={i} removeLabel="Remove rule" onRemove={() => set({ rules: rules.filter((_, k) => k !== i) })}>
            <TextField label="Find" value={r.from} placeholder="find" onChange={(from) => put(i, { from })} />
            <span className={s.arrow} aria-hidden="true">→</span>
            <TextField label="Replace with" value={r.to} placeholder="replace with" onChange={(to) => put(i, { to })} />
          </RowLine>
        ))}
      </div>
      <div>
        <Button size="sm" icon="plus" onClick={() => set({ rules: [...rules, { from: '', to: '' }] })}>
          Add rule
        </Button>
      </div>
    </>
  );
}

const RULE_OPS = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty'] as const;

export function ConditionalForm({ draft, set, ctx }: FormProps) {
  const rules = arr<{ when: Record<string, unknown>; then: unknown }>(draft.rules);
  const put = (i: number, when: Record<string, unknown> | null, then?: string) =>
    set({ rules: rules.map((r, k) => (k === i ? { when: when ? { ...r.when, ...when } : r.when, then: then ?? r.then } : r)) });
  return (
    <>
      <TextField label="New column" value={draft.name} placeholder="new column name" onChange={(name) => set({ name })} />
      <div className={s.rules}>
        {rules.map((r, i) => {
          const op = str(r.when?.op) || '=';
          return (
            <RowLine key={i} removeLabel="Remove rule" onRemove={() => set({ rules: rules.filter((_, k) => k !== i) })}>
              <span className={s.arrow}>If</span>
              <ColumnSelect ariaLabel={`Rule ${i + 1} column`} value={str(r.when?.column)} columns={ctx.columns} onChange={(column) => put(i, { column })} />
              <PickSelect ariaLabel={`Rule ${i + 1} operator`} value={op} options={RULE_OPS.map((o) => [o, o] as const)} onChange={(v) => put(i, { op: v })} />
              {op !== 'is_empty' && op !== 'not_empty' && <TextField label="Value" value={r.when?.value} placeholder="value" onChange={(value) => put(i, { value })} />}
              <span className={s.arrow}>then</span>
              <TextField label="Result" value={r.then} placeholder="result" onChange={(then) => put(i, null, then)} />
            </RowLine>
          );
        })}
      </div>
      <div>
        <Button size="sm" icon="plus" onClick={() => set({ rules: [...rules, { when: { column: ctx.columns[0]?.name ?? '', op: '=', value: '' }, then: '' }] })}>
          Add rule
        </Button>
      </div>
      <TextField label="Otherwise" value={draft.else} placeholder="(leave empty)" onChange={(v) => set({ else: v })} />
      <Hint>The first rule that matches decides the value. The rules run as one formula, so the column is typed like any calculated field.</Hint>
    </>
  );
}
