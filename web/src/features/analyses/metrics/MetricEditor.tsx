// One dialog for a whole metric (legacy metricEditor.ts): name, dataset,
// definition (Simple or Formula), filters, format, description, direction —
// with a LIVE figure from the server (`metric:preview` runs the resolver and
// the formatter the saved record will use). A draft without an id is a
// prefill: "Save as metric…" on a KPI hands one in. A duplicate name is
// refused by the server and said in the dialog, the work still in the boxes.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../../api/client';
import { useDatasetColumns, useDatasets } from '../../../api/datasets';
import { Button, buttonClass } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input, Textarea } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { Tab, TabList, Tabs } from '../../../ui/Tabs';
import { Icon } from '../../../ui/icons/Icon';
import { useTags } from '../../data/api';
import { RecordDetails } from '../../data/Details';
import { LineageDrawer } from '../../data/LineageDrawer';
import { TagChips, tagsOf } from '../../data/tags';
import type { FilterStep } from '../../visuals/api';
import { FilterRows } from '../../visuals/filters/FilterRows';
import { liveFilters } from '../../visuals/filters/filterText';
import { AGG_LABEL, failure, type Agg } from '../api';
import { isFormula, useMetricList, type Metric, type MetricFormat } from './api';
import { DirectionSelect, FormatFields, saveMetric, type Direction } from './parts';
import s from './Metrics.module.css';

const AGGS: Agg[] = ['sum', 'avg', 'count', 'min', 'max'];
/** Long enough that typing a formula is not a query per keystroke (ME_PREVIEW_MS). */
const PREVIEW_MS = 300;

export type MetricDraft = Partial<Omit<Metric, 'definition'>> & { definition?: Metric['definition'] };

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
  // The builder's filter rows and typed dialog (filterDialog.ts): values, conditions, ranges, periods — never a guessed type.
  const [filters, setFilters] = useState<FilterStep[]>((existing?.filters ?? []) as FilterStep[]);
  const formulaRef = useRef<HTMLTextAreaElement>(null);
  const [lineage, setLineage] = useState(false);
  const tags = useTags(projectId);
  const fmt0 = existing?.format;
  const [format, setFormat] = useState<MetricFormat>({
    kind: fmt0?.kind ?? 'number',
    decimals: fmt0?.decimals ?? 0,
    prefix: fmt0?.prefix ?? '',
    suffix: fmt0?.suffix ?? '',
    compact: fmt0?.compact === true,
  });
  const [description, setDescription] = useState(existing?.description ?? '');
  const [direction, setDirection] = useState<Direction>(existing?.direction ?? '');
  const [preview, setPreview] = useState<{ display: string; text: string; error?: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const definition = mode === 'formula' ? { formula } : col ? { column: col, aggregation: agg } : null;
  const live = liveFilters(filters);
  const key = JSON.stringify([ds, definition, live, format]);
  useEffect(() => {
    const [d, dfn, flt, f] = JSON.parse(key) as [string | null, Metric['definition'] | null, FilterStep[], MetricFormat];
    if (!d || !dfn) return setPreview(null);
    let on = true;
    setPreviewing(true);
    const t = setTimeout(() => {
      rpc('metric:preview', { projectId, datasetId: d, definition: dfn, filters: flt, format: f })
        .then(
          (r) => {
            const res = r as { ok: boolean; display?: string; definitionText?: string; error?: string };
            // A refusal keeps the server's reason (a formula naming an unknown metric) instead of a bare dash.
            if (on) setPreview(res.ok ? { display: res.display || '—', text: res.definitionText || '' } : { display: '—', text: '', error: res.error || 'This definition cannot be computed.' });
          },
          (err: unknown) => on && setPreview({ display: '—', text: '', error: failure(err, 'The preview could not be computed.') }),
        )
        .finally(() => on && setPreviewing(false));
    }, PREVIEW_MS);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [key, projectId]);

  /** Put `[name]` at the caret (metricEditor.ts meInsertRef), then give the box its focus back. */
  const insertRef = (name: string) => {
    const el = formulaRef.current;
    const at = el ? el.selectionStart : formula.length;
    const end = el ? el.selectionEnd : formula.length;
    const text = `[${name}]`;
    setFormula(formula.slice(0, at) + text + formula.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + text.length, at + text.length);
    });
  };

  const save = async () => {
    setError('');
    if (!name.trim()) return setError('A metric needs a name.');
    if (!ds || !definition) return setError('Choose a dataset and a column.');
    setSaving(true);
    const r = await saveMetric(projectId, editingId, ds, { name: name.trim(), definition, filters: live, format, description, direction });
    setSaving(false);
    // In the dialog, not a toast: the user's work is still in these boxes.
    if ('error' in r) return setError(r.error);
    onSaved(r.metric);
    onClose();
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
            <>
              <Link className={buttonClass('ghost', 'sm', s.history)} to={`/versions/${projectId}/metric/${editingId}`}>
                <Icon name="history" />
                <span>History</span>
              </Link>
              <Button variant="ghost" size="sm" icon="lineage" onClick={() => setLineage(true)}>
                Lineage
              </Button>
            </>
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
            disabled={!!editingId || sets.isPending}
            placeholder={sets.isPending ? 'Loading…' : 'Choose a dataset'}
            hint={editingId ? 'A metric cannot change dataset — duplicate it instead.' : undefined}
            error={
              sets.isError
                ? `The datasets could not be listed: ${sets.error.message}`
                : sets.isSuccess && !sets.data.length
                  ? 'This project has no datasets yet — import one first.'
                  : editingId && sets.isSuccess && !sets.data.some((d) => d.id === ds)
                    ? 'This metric’s dataset is no longer in the project.'
                    : undefined
            }
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
              <Select
                label="Column"
                value={col}
                disabled={!ds || cols.isPending}
                placeholder={ds && cols.isPending ? 'Loading…' : 'Choose a column'}
                error={cols.isError ? `The columns could not be read: ${cols.error.message}` : undefined}
                options={columns.map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))}
                onValueChange={setColumn}
              />
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
                ref={formulaRef}
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
                    <button key={m.id} type="button" className={s.ref} title={m.definitionText} onClick={() => insertRef(m.name)}>
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div className={s.group}>
            {ds && <FilterRows projectId={projectId} datasetId={ds} cols={columns} filters={filters} onChange={setFilters} />}
            <span className={s.filterHint}>Filters apply before the aggregation — they are part of what the metric means.</span>
          </div>
          {editingId && (
            <div className={s.group}>
              <span className={s.groupLabel}>Tags & owner</span>
              <div className={s.tagsRow}>
                {tagsOf(tags.data, `metric:${editingId}`).length ? <TagChips tags={tagsOf(tags.data, `metric:${editingId}`)} max={6} /> : <span className={s.groupHint}>No tags yet</span>}
                <RecordDetails projectId={projectId} kind="metric" id={editingId} name={name || 'Metric'} trigger={<Button size="sm" icon="info">Edit</Button>} />
              </div>
            </div>
          )}
          <div className={s.group}>
            <span className={s.groupLabel}>Format</span>
            <FormatFields format={format} onChange={setFormat} affixes />
          </div>
          <Input label="Description" placeholder="What this number means, for whoever reads it next" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          <DirectionSelect value={direction} onChange={setDirection} />
        </div>
        <aside className={s.preview} aria-live="polite" aria-label="Preview">
          <span className={s.previewH}>Preview</span>
          <span className={s.previewValue} aria-busy={previewing || undefined}>
            {previewing && !preview ? '…' : preview ? preview.display : '—'}
          </span>
          {preview?.error ? <span className={s.previewError}>{preview.error}</span> : <span className={s.previewText}>{preview?.text}</span>}
          {previewing && preview && <span className={s.previewText}>Updating…</span>}
        </aside>
        {lineage && editingId && <LineageDrawer projectId={projectId} type="metric" id={editingId} name={name || 'Metric'} onClose={() => setLineage(false)} />}
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
