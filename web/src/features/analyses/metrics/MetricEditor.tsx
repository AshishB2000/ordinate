// One dialog for a whole metric (legacy metricEditor.ts): name, dataset,
// definition (Simple or Formula), filters, format, description, direction —
// with a LIVE figure from the server (`metric:preview` runs the resolver and
// the formatter the saved record will use). A draft without an id is a
// prefill: "Save as metric…" on a KPI hands one in. A duplicate name is
// refused by the server and said in the dialog, the work still in the boxes.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../../api/client';
import { toast } from '../../../ui/Toast';
import { ConflictBanner } from '../../editConflicts/ConflictBanner';
import { useEditGuard } from '../../editConflicts/useEditGuard';
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
import { isFormula, useMetricList, type Metric, type MetricFormat, type Snapshot } from './api';
import { DirectionSelect, FormatFields, saveMetric, type Direction } from './parts';
import s from './Metrics.module.css';

const AGGS: Agg[] = ['sum', 'avg', 'count', 'min', 'max'];
/** Long enough that typing a formula is not a query per keystroke (ME_PREVIEW_MS). */
const PREVIEW_MS = 300;

export type MetricDraft = Partial<Omit<Metric, 'definition'>> & { definition?: Metric['definition'] };

/** The Snapshot field's value, `take:column` (split on the first colon), or `''` for every row. */
const snapshotOf = (v: string): Snapshot | null => {
  const at = v.indexOf(':');
  return at > 0 ? { column: v.slice(at + 1), take: v.slice(0, at) === 'first' ? 'first' : 'last' } : null;
};

type EditorProps = { projectId: string; existing?: MetricDraft; onSaved: (m: Metric) => void; onClose: () => void };

/** The dialog, and its Reload (docs/edit-conflicts): the metric read again, in a new editor. */
export function MetricEditor(props: EditorProps) {
  const [current, setCurrent] = useState(props.existing);
  const [gen, setGen] = useState(0);
  const reload = async () => {
    const r = (await rpc('metric:get', { projectId: props.projectId, id: current?.id ?? '' }).catch(() => null)) as { ok: boolean; metric?: Metric; tag?: string } | null;
    if (!r?.ok || !r.metric) {
      toast('That metric could not be read.', { kind: 'error' });
      return props.onClose();
    }
    setCurrent({ ...r.metric, tag: r.tag });
    setGen((g) => g + 1);
  };
  return <EditorBody key={gen} {...props} existing={current} onReload={() => void reload()} />;
}

function EditorBody({ projectId, existing, onSaved, onClose, onReload }: EditorProps & { onReload: () => void }) {
  const editingId = existing?.id ?? '';
  // The update's base: the tag `existing` was read with (metric:get).
  const guard = useEditGuard({ projectId, type: 'metric', id: editingId || undefined }, existing?.tag);
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
  // A snapshot (D8): `take:column`, or '' for every row. Always sent, so a clear (null) is told from an old tab's save.
  const [snapshot, setSnapshot] = useState(def && !isFormula(def) && def.snapshot ? `${def.snapshot.take}:${def.snapshot.column}` : '');
  const [snapError, setSnapError] = useState('');
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
  // The date it counts by (D9): `''` is the dashboard's date. Set only by a pick or by "Use <column>", never silently.
  const [timeColumn, setTimeColumn] = useState(existing?.timeColumn ?? '');
  const [dateError, setDateError] = useState('');
  const [preview, setPreview] = useState<{ display: string; text: string; error?: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const definition = mode === 'formula' ? { formula } : col ? { column: col, aggregation: agg, snapshot: snapshotOf(snapshot) } : null;
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
    setDateError('');
    setSnapError('');
    if (!name.trim()) return setError('A metric needs a name.');
    if (!ds || !definition) return setError('Choose a dataset and a column.');
    setSaving(true);
    // The date only when it changed: an edit that leaves it alone lets a formula take its new parts' date (the server's rule).
    const dated = editingId && timeColumn === (existing?.timeColumn ?? '') ? {} : { timeColumn };
    const r = await saveMetric(projectId, editingId, ds, { name: name.trim(), definition, filters: live, format, description, direction, ...dated }, guard);
    setSaving(false);
    if ('changed' in r) return; // the banner
    // In the dialog, not a toast: the user's work is still in these boxes — a date's refusal beside the date.
    if ('error' in r) return r.field === 'timeColumn' ? setDateError(r.error) : r.field === 'snapshot' ? setSnapError(r.error) : setError(r.error);
    onSaved(r.metric);
    onClose();
  };
  // Save mine as a copy: these boxes as a new metric, which the host then shows (a duplicate name is refused as ever).
  const copy = async () => {
    if (!ds || !definition) throw new Error('Choose a dataset and a column.');
    const r = await saveMetric(projectId, '', ds, { name: `${name.trim() || 'Metric'} (copy)`.slice(0, 200), definition, filters: live, format, description, direction, timeColumn });
    if ('error' in r) throw new Error(r.error);
    if ('metric' in r) {
      onSaved(r.metric);
      onClose();
    }
  };

  const refs = (others.data ?? []).filter((m) => m.id !== editingId && m.datasetId === ds).slice(0, 12);
  const columns = cols.data?.columns ?? [];
  const dates = columns.filter((c) => c.type === 'date').map((c) => c.name);
  // A stored date the dataset no longer has as a date column counts as unset on the server (metricDate): said here.
  const gone = !!timeColumn && cols.isSuccess && !dates.includes(timeColumn);
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
          <Button variant="primary" loading={saving} disabled={guard.changed} onClick={() => void save()}>
            {editingId ? 'Save' : 'Create metric'}
          </Button>
        </>
      }
    >
      {guard.changed && <ConflictBanner compact noun="metric" onReload={onReload} onCopy={copy} />}
      <div className={s.editor}>
        <div className={s.fields}>
          <Input label="Name" placeholder="Revenue" hint="Formulas reference a metric by this name." value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
          <Select
            label="Dataset"
            disabled={!!editingId || sets.isPending}
            placeholder={sets.isPending ? 'Loading…' : 'Choose a dataset'}
            hint={editingId ? 'A metric cannot change dataset. Duplicate it instead.' : undefined}
            error={
              sets.isError
                ? `The datasets could not be listed: ${sets.error.message}`
                : sets.isSuccess && !sets.data.length
                  ? 'This project has no datasets yet. Import one first.'
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
              setTimeColumn('');
              setSnapshot('');
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
              {(dates.length > 0 || snapshot) && (
                <Select
                  label="Snapshot"
                  value={snapshot}
                  disabled={!ds || cols.isPending}
                  hint="For balances, stock and headcount: keeps only the rows on the latest date in scope (per month on a chart by month), then aggregates them."
                  error={snapError || undefined}
                  options={[
                    { value: '', label: 'Every row' },
                    ...[...new Set(snapshot ? [...dates, snapshotOf(snapshot)!.column] : dates)].flatMap((c) => [
                      { value: `last:${c}`, label: `Latest ${c} only` },
                      { value: `first:${c}`, label: `Earliest ${c} only` },
                    ]),
                  ]}
                  onValueChange={(v) => {
                    setSnapshot(v);
                    setSnapError('');
                  }}
                />
              )}
            </>
          ) : (
            <>
              <Textarea
                ref={formulaRef}
                label="Formula"
                rows={3}
                spellCheck={false}
                placeholder="[Profit] / [Revenue]"
                hint="Other metrics by name in [brackets], or an aggregation of a column, for example sum(revenue) - sum(cost)."
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
            <Select
              label="Date it counts by"
              value={timeColumn}
              disabled={!ds || cols.isPending}
              hint={mode === 'formula' ? 'A dashboard’s date range lands on this date. Left on the dashboard’s, a formula takes the date its parts share.' : 'A dashboard’s date range lands on this date.'}
              error={dateError || (gone ? `“${timeColumn}” is no longer a date column of this dataset, so the metric counts by the dashboard’s date. Choose another, or the dashboard’s.` : undefined)}
              options={[{ value: '', label: 'The dashboard’s date' }, ...dates.map((c) => ({ value: c, label: c })), ...(gone ? [{ value: timeColumn, label: timeColumn }] : [])]}
              onValueChange={(v) => {
                setTimeColumn(v);
                setDateError('');
              }}
            />
            {!timeColumn && dates.length === 1 && (
              <div>
                <Button size="sm" icon="calendar" onClick={() => setTimeColumn(dates[0])}>
                  Use {dates[0]}
                </Button>
              </div>
            )}
          </div>
          <div className={s.group}>
            {ds && <FilterRows projectId={projectId} datasetId={ds} cols={columns} filters={filters} onChange={setFilters} />}
            <span className={s.filterHint}>Filters apply before the aggregation: they are part of what the metric means.</span>
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
