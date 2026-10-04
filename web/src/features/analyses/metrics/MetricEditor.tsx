// One dialog for a whole metric (legacy metricEditor.ts): name, dataset,
// definition (Simple or Formula), filters, format, description, direction —
// with a LIVE figure from the server (`metric:preview` runs the resolver and
// the formatter the saved record will use). A draft without an id is a
// prefill: "Save as metric…" on a KPI hands one in. A duplicate name is
// refused by the server and said in the dialog, the work still in the boxes.

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../../api/client';
import { useDatasetColumns, useDatasets } from '../../../api/datasets';
import { Button, IconButton, buttonClass } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input, Textarea } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { Tab, TabList, Tabs } from '../../../ui/Tabs';
import { Icon } from '../../../ui/icons/Icon';
import { AGG_LABEL, failure, type Agg, type Step } from '../api';
import { isFormula, useMetricList, type Metric, type MetricFormat } from './api';
import s from './Metrics.module.css';

const AGGS: Agg[] = ['sum', 'avg', 'count', 'min', 'max'];
const OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'is_empty', 'not_empty'];
/** Long enough that typing a formula is not a query per keystroke (ME_PREVIEW_MS). */
const PREVIEW_MS = 300;

export type MetricDraft = Partial<Omit<Metric, 'definition'>> & { definition?: Metric['definition'] };

function filterText(st: Step): string {
  const v = Array.isArray(st.values) ? st.values.join(', ') : st.value == null ? '' : String(st.value);
  return `${String(st.column ?? '')} ${String(st.op ?? '')} ${v}`.trim();
}

/** "+ Filter": column, operator, value — a row predicate applied before the aggregation. */
function AddFilter({ columns, onAdd }: { columns: { name: string }[]; onAdd: (st: Step) => void }) {
  const [col, setCol] = useState<string | null>(null);
  const [op, setOp] = useState('=');
  const [value, setValue] = useState('');
  const column = col ?? columns[0]?.name ?? null;
  const unary = op === 'is_empty' || op === 'not_empty';
  return (
    <div className={s.addFilter}>
      <Select size="sm" aria-label="Filter column" value={column} options={columns.map((c) => ({ value: c.name, label: c.name }))} onValueChange={setCol} />
      <Select size="sm" aria-label="Operator" value={op} options={OPS.map((o) => ({ value: o, label: o.replace('_', ' ') }))} onValueChange={setOp} />
      {!unary && <Input size="sm" aria-label="Filter value" value={value} onChange={(e) => setValue(e.target.value)} />}
      <Button
        size="sm"
        disabled={!column || (!unary && !value.trim())}
        onClick={() => {
          if (!column) return;
          const n = Number(value);
          const typed = value.trim() !== '' && Number.isFinite(n) && op !== 'contains' ? n : value;
          onAdd({ type: 'filter', column, op, ...(unary ? {} : { value: typed }) });
          setValue('');
        }}
      >
        Add filter
      </Button>
    </div>
  );
}

export function MetricEditor({ projectId, existing, onSaved, onClose }: { projectId: string; existing?: MetricDraft; onSaved: (m: Metric) => void; onClose: () => void }) {
  const editingId = existing?.id ?? '';
  const def = existing?.definition;
  const sets = useDatasets(projectId);
  const [name, setName] = useState(existing?.name ?? '');
  const [datasetId, setDatasetId] = useState<string | null>(existing?.datasetId ?? null);
  const ds = datasetId ?? sets.data?.[0]?.id ?? null;
  const cols = useDatasetColumns(projectId, ds ?? undefined);
  const others = useMetricList(projectId);
  const [mode, setMode] = useState<'simple' | 'formula'>(def && isFormula(def) ? 'formula' : 'simple');
  const [column, setColumn] = useState<string | null>(def && !isFormula(def) ? def.column || null : null);
  const col = column && cols.data?.columns.some((c) => c.name === column) ? column : (cols.data?.columns[0]?.name ?? null);
  const [agg, setAgg] = useState<Agg>(def && !isFormula(def) ? def.aggregation : 'sum');
  const [formula, setFormula] = useState(def && isFormula(def) ? def.formula : '');
  const [filters, setFilters] = useState<Step[]>(existing?.filters ?? []);
  const fmt0 = existing?.format;
  const [format, setFormat] = useState<MetricFormat>({
    kind: fmt0?.kind ?? 'number',
    decimals: fmt0?.decimals ?? 0,
    prefix: fmt0?.prefix ?? '',
    suffix: fmt0?.suffix ?? '',
    compact: fmt0?.compact === true,
  });
  const [description, setDescription] = useState(existing?.description ?? '');
  const [direction, setDirection] = useState<string>(existing?.direction ?? '');
  const [preview, setPreview] = useState<{ display: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const definition = mode === 'formula' ? { formula } : col ? { column: col, aggregation: agg } : null;
  const key = JSON.stringify([ds, definition, filters, format]);
  useEffect(() => {
    const [d, dfn, flt, f] = JSON.parse(key) as [string | null, Metric['definition'] | null, Step[], MetricFormat];
    if (!d || !dfn) return setPreview(null);
    let live = true;
    const t = setTimeout(() => {
      rpc('metric:preview', { projectId, datasetId: d, definition: dfn, filters: flt, format: f }).then(
        (r) => {
          const res = r as { ok: boolean; display?: string; definitionText?: string };
          if (live) setPreview(res.ok ? { display: res.display || '—', text: res.definitionText || '' } : { display: '—', text: '' });
        },
        () => live && setPreview({ display: '—', text: '' }),
      );
    }, PREVIEW_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, projectId]);

  const save = async () => {
    setError('');
    if (!name.trim()) return setError('A metric needs a name.');
    if (!ds || !definition) return setError('Choose a dataset and a column.');
    const fields = {
      name: name.trim(),
      definition,
      filters,
      format,
      description,
      direction: direction as '' | 'up_good' | 'down_good',
    };
    setSaving(true);
    try {
      const r = (editingId
        ? await rpc('metric:update', { projectId, id: editingId, patch: fields })
        : await rpc('metric:save', { projectId, input: { ...fields, datasetId: ds } })) as { ok: boolean; metric?: Metric; error?: string };
      if (!r.ok || !r.metric) throw new Error(r.error || 'Could not save the metric.');
      onSaved(r.metric);
      onClose();
    } catch (err) {
      // In the dialog, not a toast: the user's work is still in these boxes.
      setError(failure(err, 'Could not save the metric.'));
    } finally {
      setSaving(false);
    }
  };

  const refs = (others.data ?? []).filter((m) => m.id !== editingId && m.datasetId === ds).slice(0, 12);
  const columns = cols.data?.columns ?? [];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={editingId ? 'Edit metric' : 'New metric'}
      footer={
        <>
          {editingId && (
            <Link className={buttonClass('ghost', 'sm', s.history)} to={`/versions/${projectId}/metric/${editingId}`}>
              <Icon name="history" />
              <span>History</span>
            </Link>
          )}
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {editingId ? 'Save' : 'Create metric'}
          </Button>
        </>
      }
    >
      <div className={s.editor}>
        <div className={s.fields}>
          <Input label="Name" placeholder="Revenue" hint="Formulas reference a metric by this name." value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
          <Select
            label="Dataset"
            disabled={!!editingId}
            hint={editingId ? 'A metric cannot change dataset — duplicate it instead.' : undefined}
            value={ds}
            options={(sets.data ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
            onValueChange={(v) => {
              setDatasetId(v);
              setColumn(null);
              setFilters([]);
            }}
          />
          <Tabs value={mode} onValueChange={(v) => setMode(v === 'formula' ? 'formula' : 'simple')}>
            <TabList label="Definition">
              <Tab value="simple">Simple</Tab>
              <Tab value="formula">Formula</Tab>
            </TabList>
          </Tabs>
          {mode === 'simple' ? (
            <>
              <Select label="Column" value={col} options={columns.map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))} onValueChange={setColumn} />
              <div className={s.aggs} role="radiogroup" aria-label="Aggregation">
                {AGGS.map((a) => (
                  <button key={a} type="button" role="radio" aria-checked={a === agg} className={a === agg ? `${s.agg} ${s.on}` : s.agg} onClick={() => setAgg(a)}>
                    {AGG_LABEL[a]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <Textarea
                label="Formula"
                rows={3}
                spellCheck={false}
                placeholder="[Profit] / [Revenue]"
                hint="Other metrics by name in [brackets], or an aggregation of a column — sum(revenue) - sum(cost)."
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
              />
              {refs.length > 0 && (
                <div className={s.refs}>
                  {refs.map((m) => (
                    <button key={m.id} type="button" className={s.ref} title={m.definitionText} onClick={() => setFormula((f) => `${f}[${m.name}]`)}>
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div className={s.group}>
            <span className={s.groupLabel}>Filters</span>
            <span className={s.groupHint}>Applied before the aggregation — part of what the metric means.</span>
            {filters.length > 0 && (
              <div className={s.chips}>
                {filters.map((f, i) => (
                  <span key={i} className={s.chip}>
                    {filterText(f)}
                    <IconButton icon="x" size="sm" label={`Remove filter ${filterText(f)}`} onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} />
                  </span>
                ))}
              </div>
            )}
            <AddFilter columns={columns} onAdd={(st) => setFilters((fs) => [...fs, st])} />
          </div>
          <div className={s.group}>
            <span className={s.groupLabel}>Format</span>
            <div className={s.format}>
              <Select
                size="sm"
                aria-label="Format"
                value={format.kind}
                options={[
                  { value: 'number', label: 'Number' },
                  { value: 'currency', label: 'Currency' },
                  { value: 'percent', label: 'Percent' },
                  { value: 'duration', label: 'Duration' },
                ]}
                onValueChange={(v) => setFormat((f) => ({ ...f, kind: v as MetricFormat['kind'] }))}
              />
              <Input size="sm" type="number" min={0} max={6} aria-label="Decimal places" value={String(format.decimals ?? 0)} onChange={(e) => setFormat((f) => ({ ...f, decimals: Number(e.target.value) || 0 }))} />
              <Input size="sm" aria-label="Prefix" placeholder="Prefix" value={format.prefix ?? ''} maxLength={8} onChange={(e) => setFormat((f) => ({ ...f, prefix: e.target.value }))} />
              <Input size="sm" aria-label="Suffix" placeholder="Suffix" value={format.suffix ?? ''} maxLength={8} onChange={(e) => setFormat((f) => ({ ...f, suffix: e.target.value }))} />
              <Checkbox label="Compact" checked={!!format.compact} onCheckedChange={(c) => setFormat((f) => ({ ...f, compact: c }))} />
            </div>
          </div>
          <Input label="Description" placeholder="What this number means, for whoever reads it next" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          <Select
            label="Direction"
            hint="Which way is good news, for the surfaces that colour a change."
            value={direction}
            options={[
              { value: '', label: 'No opinion' },
              { value: 'up_good', label: 'Up is good' },
              { value: 'down_good', label: 'Down is good' },
            ]}
            onValueChange={setDirection}
          />
        </div>
        <aside className={s.preview} aria-live="polite" aria-label="Preview">
          <span className={s.previewH}>Preview</span>
          <span className={s.previewValue}>{preview ? preview.display : '—'}</span>
          <span className={s.previewText}>{preview?.text}</span>
        </aside>
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
