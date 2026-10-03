// The data-quality rule editor (dsRuleEditor.ts): one dialog to add or edit a
// rule. NOTHING HERE COUNTS — the live "would fail N rows now" is the server
// running the same evaluator the stored rule will (`quality:preview`), and
// every default is a figure the app already computed: a range from the
// column's summary, an allowed-values list from its distinct values, a row
// count from the stored count. The server re-validates everything on save.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDatasetColumns, useDatasets, type DatasetColumns } from '../../api/datasets';
import { Button } from '../../ui/Button';
import { RadioGroup } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input, Textarea } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { call, useWrite, type ColumnSummary, type Preview, type Rule, type RuleDraft, type RuleKind } from './api';
import { formatNumber, rowsText } from './format';
import { columnsFor, KINDS, PRESETS } from './ruleWords';
import s from './Data.module.css';
import qs from './Quality.module.css';

/** Prefill an allowed-values list only when the column has this few values. */
const SET_PREFILL = 30;

type Args = Record<string, unknown>;
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** The arguments a kind starts with: the stored ones when editing that kind and column, else the app's own figures. */
function defaults(kind: RuleKind, column: string, existing: Rule | null, sums: ColumnSummary[], rowCount: number): Args {
  if (existing && existing.kind === kind && (kind === 'row_count' || existing.column === column)) return existing.args;
  if (kind === 'row_count') return { min: rowCount };
  if (kind === 'range') {
    const sum = sums.find((x) => x.name === column);
    return typeof sum?.min === 'number' ? { min: sum.min, max: sum.max } : {};
  }
  if (kind === 'regex') return { preset: 'email' };
  return {};
}

export function RuleEditor({ projectId, datasetId, header, summaries, existing, onClose }: {
  projectId: string;
  datasetId: string;
  header: DatasetColumns;
  summaries: ColumnSummary[];
  existing: Rule | null;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<RuleKind>(existing?.kind ?? 'not_null');
  const fit = (k: RuleKind, want: string) => {
    const cols = columnsFor(k, header.columns);
    return cols.some((c) => c.name === want) ? want : (cols[0]?.name ?? '');
  };
  const [column, setColumn] = useState(fit(existing?.kind ?? 'not_null', existing?.column ?? ''));
  const [severity, setSeverity] = useState<'fail' | 'warn'>(existing?.severity ?? 'fail');
  const [args, setArgs] = useState<Args>(() => defaults(existing?.kind ?? 'not_null', column, existing, summaries, header.rowCount));
  const [setText, setSetText] = useState(() => (Array.isArray(existing?.args.values) ? (existing.args.values as string[]).join('\n') : ''));
  const [setHint, setSetHint] = useState('One per line, matched exactly. Empty cells pass.');
  const [error, setError] = useState('');
  const datasets = useDatasets(projectId);

  const pickKind = (k: RuleKind) => {
    if (k === kind) return;
    const col = fit(k, column);
    setKind(k);
    setColumn(col);
    setArgs(defaults(k, col, existing, summaries, header.rowCount));
  };
  const pickColumn = (col: string) => {
    setColumn(col);
    setArgs(defaults(kind, col, existing, summaries, header.rowCount));
  };

  // Allowed values, prefilled from the column's own distinct values when there are few enough to be a list.
  useEffect(() => {
    if (kind !== 'in_set' || !column || setText) return;
    let live = true;
    void (async () => {
      const r = (await call('dataset:distinct', { projectId, datasetId, column, limit: SET_PREFILL + 1 }).catch(() => null)) as { values?: string[] } | null;
      if (!live || !r || !Array.isArray(r.values) || r.values.length > SET_PREFILL) return;
      setSetText(r.values.join('\n'));
      setSetHint(`Prefilled with the ${formatNumber(r.values.length)} values in this column now. One per line.`);
    })();
    return () => {
      live = false;
    };
    // Only on a kind or column change: emptying the box by hand must not refill it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, column]);

  const draft: RuleDraft = {
    ...(existing ? { id: existing.id } : {}),
    kind,
    ...(kind === 'row_count' ? {} : { column }),
    args: kind === 'in_set' ? { values: setText.split('\n').map((v) => v.replace(/\r$/, '')).filter((v) => v.trim() !== '') } : args,
    severity,
  };
  // The live preview: one query per pause, the server's own evaluator.
  const [debounced, setDebounced] = useState(draft);
  const key = JSON.stringify(draft);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(JSON.parse(key) as RuleDraft), 300);
    return () => clearTimeout(t);
  }, [key]);
  const preview = useQuery({
    queryKey: ['quality:preview', projectId, datasetId, debounced],
    queryFn: async () => (await call('quality:preview', { projectId, datasetId, rule: debounced })) as Preview,
  });
  const busy = preview.isFetching || JSON.stringify(debounced) !== key;
  const p = preview.data;
  const line = busy
    ? { cls: qs.pvBusy, text: 'Checking the data…' }
    : !p
      ? { cls: s.muted, text: 'Could not check the data.' }
      : !p.ok
        ? { cls: s.muted, text: `Not checkable yet: ${p.error}` }
        : p.error
          ? { cls: s.failText, text: `Cannot run: ${p.error}` }
          : p.passed
            ? { cls: s.good, text: kind === 'row_count' ? 'Passes now.' : 'Passes now — no rows fail.' }
            : { cls: s.failText, text: kind === 'row_count' ? 'Would fail now.' : `Would fail now: ${rowsText(p.failing)}.` };

  const save = useWrite('quality:save', ['quality:list', 'dataset:list'], {
    quiet: true,
    onDone: (r) => (r.ok === false ? setError(r.error || 'Could not save the rule.') : onClose()),
  });
  const cols = columnsFor(kind, header.columns);
  const colType = header.columns.find((c) => c.name === column)?.type;
  const isDate = kind === 'range' && colType === 'date';
  const num = (v: string): unknown => (v === '' ? undefined : isDate ? v : Number(v));

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={existing ? 'Edit rule' : 'Add rule'}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={save.isPending} onClick={() => (setError(''), save.mutate({ projectId, datasetId, rule: draft }))}>
            {existing ? 'Save rule' : 'Add rule'}
          </Button>
        </>
      }
    >
      <div className={qs.kinds} role="radiogroup" aria-label="Rule kind">
        {KINDS.map((k) => (
          <button key={k.kind} type="button" role="radio" aria-checked={k.kind === kind} className={`${qs.kindTile} ${k.kind === kind ? qs.kindOn : ''}`} onClick={() => pickKind(k.kind)}>
            <span className={s.strong}>{k.label}</span>
            <span className={s.meta}>{k.hint}</span>
          </button>
        ))}
      </div>
      {kind !== 'row_count' && (
        <Select label="Column" value={column || null} options={cols.map((c) => ({ value: c.name, label: `${c.name} · ${c.type}` }))} placeholder="No column fits this rule" onValueChange={pickColumn} />
      )}
      {(kind === 'range' || kind === 'row_count') && (
        <>
          <div className={qs.pair}>
            <Input label="Minimum" type={isDate ? 'date' : 'number'} step="any" placeholder="No minimum" value={str(args.min)} onChange={(e) => setArgs({ ...args, min: num(e.target.value) })} />
            <Input label="Maximum" type={isDate ? 'date' : 'number'} step="any" placeholder="No maximum" value={str(args.max)} onChange={(e) => setArgs({ ...args, max: num(e.target.value) })} />
          </div>
          <p className={s.meta}>
            {kind === 'row_count'
              ? `This dataset has ${rowsText(header.rowCount)} now.`
              : isDate
                ? 'Dates are compared as YYYY-MM-DD.'
                : 'Prefilled with the column’s current minimum and maximum.'}
          </p>
        </>
      )}
      {kind === 'regex' && (
        <>
          <RadioGroup
            label="Format"
            orientation="horizontal"
            value={str(args.preset)}
            options={[...PRESETS, { value: '', label: 'Custom' }]}
            onValueChange={(v) => setArgs(v ? { preset: v } : { pattern: '' })}
          />
          {!args.preset && (
            <Input label="Pattern" hint="The whole cell must match, as a regular expression." className={s.mono} placeholder="e.g. [A-Z]{2}-[0-9]{4}" value={str(args.pattern)} onChange={(e) => setArgs({ pattern: e.target.value })} />
          )}
        </>
      )}
      {kind === 'in_set' && <Textarea label="Allowed values" hint={setHint} rows={5} placeholder="One value per line" value={setText} onChange={(e) => setSetText(e.target.value)} />}
      {kind === 'references' && (
        <RefFields
          projectId={projectId}
          datasetId={datasetId}
          options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.id === datasetId ? `${d.name} (this dataset)` : d.name }))}
          args={args}
          onArgs={setArgs}
        />
      )}
      <RadioGroup
        label="Severity"
        orientation="horizontal"
        value={severity}
        options={[
          { value: 'fail', label: 'Fail', hint: 'Raises an alert and puts a red dot on the dataset' },
          { value: 'warn', label: 'Warn', hint: 'Shown here only' },
        ]}
        onValueChange={(v) => setSeverity(v as 'fail' | 'warn')}
      />
      <p className={`${qs.preview} ${line.cls}`} role="status">
        {line.text}
      </p>
      {error && (
        <p className={s.rowError} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** A references rule's other side: a dataset and one of its columns. */
function RefFields({ projectId, datasetId, options, args, onArgs }: {
  projectId: string;
  datasetId: string;
  options: { value: string; label: string }[];
  args: Args;
  onArgs: (a: Args) => void;
}) {
  const other = str(args.datasetId) || options.find((o) => o.value !== datasetId)?.value || '';
  const cols = useDatasetColumns(projectId, other || undefined);
  useEffect(() => {
    if (!args.datasetId && other) onArgs({ ...args, datasetId: other });
  }, [args, other, onArgs]);
  return (
    <div className={qs.pair}>
      <Select label="Dataset" value={other || null} options={options} onValueChange={(v) => onArgs({ datasetId: v })} />
      <Select
        label="Its column"
        hint="Every non-empty value must exist there."
        value={str(args.column) || null}
        placeholder={cols.isPending ? 'Loading columns…' : 'Choose a column'}
        options={(cols.data?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name} · ${c.type}` }))}
        onValueChange={(v) => onArgs({ ...args, datasetId: other, column: v })}
      />
    </div>
  );
}
