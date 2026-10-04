// "+ KPI" (legacy dashAdd.ts handleAddMetric + metricPicker.ts): the metric
// PICKER first — a project that has named its numbers is not asked for a
// column and an aggregation again — with each row's live figure; "Custom…"
// falls through to the column form with its own live preview. Every figure is
// the server's (`metric:values`, `analysis:tiles`).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useDatasetColumns, useDatasets } from '../../../api/datasets';
import { fmtWith } from '../../../charts/format';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { AGG_LABEL, useTile, type Agg, type Card, type MetricTile } from '../api';
import { formatBadge, isFormula, useMetricList, useMetricValues, type MetricSummary } from '../metrics/api';
import { useEditor } from './context';
import { findSlot } from './geometry';
import { uuid } from './doc';
import s from './Dialogs.module.css';

const AGGS: Agg[] = ['sum', 'avg', 'count', 'min', 'max'];
/** Rows past this and the picker is a list to scroll — which is what search is for (MPK_MAX_ROWS). */
const MAX_ROWS = 40;

function useAddKpi() {
  const ed = useEditor();
  return (metric: NonNullable<Card['metric']>) => {
    const id = uuid();
    ed.edit('Add KPI', (d) => {
      const sheet = d.sheets[ed.sheet];
      sheet.cards.push({ id, type: 'metric', metric, layout: { ...findSlot(sheet.cards, 3, 2), w: 3, h: 2 } });
    });
    ed.select(id);
  };
}

function Picker({ onPick, onCustom }: { onPick: (m: MetricSummary) => void; onCustom: () => void }) {
  const ed = useEditor();
  const list = useMetricList(ed.projectId);
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const all = list.data ?? [];
    const k = q.trim().toLowerCase();
    return (k ? all.filter((m) => m.name.toLowerCase().includes(k) || m.definitionText.toLowerCase().includes(k)) : all).slice(0, MAX_ROWS);
  }, [list.data, q]);
  const values = useMetricValues(
    ed.projectId,
    shown.map((m) => m.id),
    ed.filters,
    ed.params,
  );
  return (
    <div className={s.picker}>
      <Input icon="search" type="search" aria-label="Search metrics" placeholder="Search metrics" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className={s.mpkRows} role="list">
        {list.isPending ? (
          <p className={s.empty}>Loading…</p>
        ) : list.isError ? (
          <p className={s.empty}>{list.error.message}</p>
        ) : shown.length === 0 ? (
          <p className={s.empty}>
            {(list.data ?? []).length ? 'No metric matches that.' : 'No metrics in this project yet. Data → Metrics defines one.'}
          </p>
        ) : (
          shown.map((m) => (
            <button key={m.id} type="button" role="listitem" className={s.mpkRow} title={m.definitionText} onClick={() => onPick(m)}>
              <span className={s.mpkName}>{m.name}</span>
              <span className={s.badge}>{formatBadge(m.format)}</span>
              <span className={s.mpkValue}>{values.data?.get(m.id) ?? '…'}</span>
            </button>
          ))
        )}
      </div>
      <div className={s.pickerFoot}>
        <Button variant="ghost" onClick={onCustom}>
          Custom…
        </Button>
        <Link className={s.link} to={`/data/metrics?project=${ed.projectId}`}>
          Manage metrics
        </Link>
      </div>
    </div>
  );
}

function CustomForm({ onDraft }: { onDraft: (m: NonNullable<Card['metric']> | null) => void }) {
  const ed = useEditor();
  const sets = useDatasets(ed.projectId);
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const ds = datasetId ?? sets.data?.[0]?.id ?? null;
  const cols = useDatasetColumns(ed.projectId, ds ?? undefined);
  const [column, setColumn] = useState<string | null>(null);
  const col = column && cols.data?.columns.some((c) => c.name === column) ? column : (cols.data?.columns.find((c) => c.type === 'number') ?? cols.data?.columns[0])?.name ?? null;
  const [agg, setAgg] = useState<Agg>('sum');
  const [label, setLabel] = useState('');
  const auto = `${AGG_LABEL[agg]} of ${col ?? ''}`;
  const req = ds && col ? { kind: 'metric' as const, datasetId: ds, column: col, aggregation: agg, filters: ed.filters } : undefined;
  const preview = useTile<MetricTile>(ed.projectId, ed.params, req);
  const draft = ds && col ? { datasetId: ds, column: col, aggregation: agg, ...(label.trim() ? { label: label.trim() } : {}) } : null;
  // Handed up by VALUE: the footer's Add builds the card from it.
  const key = JSON.stringify(draft);
  useEffect(() => onDraft(JSON.parse(key) as NonNullable<Card['metric']> | null), [key, onDraft]);

  if (sets.data && sets.data.length === 0) return <p className={s.empty}>Import a dataset first — a metric is computed from one.</p>;
  return (
    <div className={s.form}>
      <Select
        label="Dataset"
        value={ds}
        options={(sets.data ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
        onValueChange={(v) => {
          setDatasetId(v);
          setColumn(null);
        }}
      />
      <Select
        label="Column"
        value={col}
        options={(cols.data?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))}
        onValueChange={setColumn}
      />
      <div className={s.aggs} role="radiogroup" aria-label="Aggregation">
        {AGGS.map((a) => (
          <button key={a} type="button" role="radio" aria-checked={a === agg} className={a === agg ? `${s.agg} ${s.on}` : s.agg} onClick={() => setAgg(a)}>
            {AGG_LABEL[a]}
          </button>
        ))}
      </div>
      <Input label="Label" placeholder={auto} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
      <div className={s.kpiPreview} aria-live="polite">
        <span className={s.kpiValue}>
          {!req || preview.isPending ? '…' : preview.data?.ok ? (typeof preview.data.value === 'number' ? fmtWith(preview.data.value, 'auto') : '—') : '—'}
        </span>
        <span className={s.kpiLabel}>{label.trim() || auto}</span>
      </div>
    </div>
  );
}

export function AddKpiDialog({ onClose }: { onClose: () => void }) {
  const add = useAddKpi();
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState<NonNullable<Card['metric']> | null>(null);
  const pick = (m: MetricSummary) => {
    // column / aggregation are stored ALONGSIDE the id: a card whose metric is
    // later deleted keeps its number from them. A formula has no column.
    const def = m.definition;
    add({
      datasetId: m.datasetId,
      column: isFormula(def) ? '' : def.column,
      aggregation: isFormula(def) ? 'count' : def.aggregation,
      label: m.name,
      metricId: m.id,
    });
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={custom ? 'Add a metric' : 'Add a KPI'}
      description={custom ? 'A column rolled up — computed by the server under the sheet’s filters.' : 'Pick a defined metric, or build one from a column.'}
      footer={
        <>
          {custom && (
            <Button variant="ghost" icon="chevron-left" onClick={() => setCustom(false)}>
              Metrics
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          {custom && (
            <Button
              variant="primary"
              disabled={!draft}
              onClick={() => {
                if (!draft) return;
                add(draft);
                onClose();
              }}
            >
              Add
            </Button>
          )}
        </>
      }
    >
      {custom ? (
        <CustomForm onDraft={setDraft} />
      ) : (
        <Picker onPick={pick} onCustom={() => setCustom(true)} />
      )}
    </Dialog>
  );
}
