// The cohort and event-funnel shelves (cohortBuilder.ts). Like the pivot's,
// they REPLACE the encoding form's chart fields while the chart type is
// `cohort` / `event_funnel`; filters stay where they are. Each picker offers
// only the columns that fit it — dates for the event date and the timestamp,
// numbers for a value — and a funnel's steps come from the event column's own
// distinct values, read on the server (`dataset:distinct`), never scanned here.
// Controlled: reads the encoding, reports the full new one (the block plus
// the mirrored chart fields, ./gridEncoding engineEncoding).

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button, IconButton } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Input } from '../../../ui/Field';
import { Menu } from '../../../ui/Menu';
import { Select } from '../../../ui/Select';
import type { Encoding } from '../../visuals/api';
import type { Column } from '../../visuals/model';
import { engineEncoding, entityPool, fitCohort, fitFunnel, MAX_STEPS, type CohortBlock, type EngineKind, type FunnelBlock } from './gridEncoding';
import b from '../../visuals/Builder.module.css';
import s from './Shelves.module.css';

/** A row of toggle buttons, one pressed (the desktop's `.eng-seg`). */
function Segmented({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string; disabled?: boolean; title?: string }>; onChange: (v: string) => void }) {
  return (
    <div className={s.seg} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? `${s.segBtn} ${s.segOn}` : s.segBtn}
          aria-pressed={o.value === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const pick = (pool: readonly Column[], empty: string) => [{ value: '', label: empty }, ...pool.map((c) => ({ value: c.name, label: c.name }))];

function CohortForm({ cols, block, onChange }: { cols: readonly Column[]; block: CohortBlock; onChange: (c: CohortBlock) => void }) {
  const set = (patch: Partial<CohortBlock>) => {
    const next = { ...block, ...patch } as CohortBlock & Record<string, unknown>;
    for (const k of Object.keys(patch)) if (next[k] === undefined || next[k] === '') delete next[k];
    if (!next.value) next.show = 'retention';
    onChange(next);
  };
  return (
    <div className={b.encoding}>
      <Select label="Entity" aria-label="Cohort entity column" value={block.entity} options={pick(entityPool(cols), 'Pick a column')} onValueChange={(v) => set({ entity: v })} />
      <Select label="Event date" aria-label="Cohort event date column" value={block.date} options={pick(cols.filter((c) => c.type === 'date'), 'Pick a date column')} onValueChange={(v) => set({ date: v })} />
      <Select label="Value" aria-label="Cohort value column" value={block.value ?? ''} options={pick(cols.filter((c) => c.type === 'number'), 'None — retention only')} onValueChange={(v) => set({ value: v || undefined })} />
      <div className={b.row}>
        <span className={b.label}>Grain</span>
        <Segmented
          label="Cohort grain"
          value={block.grain}
          options={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
            { value: 'quarter', label: 'Quarter' },
          ]}
          onChange={(g) => set({ grain: g as CohortBlock['grain'] })}
        />
      </div>
      <div className={b.row}>
        <span className={b.label}>Show</span>
        <Segmented
          label="Cohort figure"
          value={block.show}
          options={[
            { value: 'retention', label: 'Retention' },
            { value: 'value', label: 'Cumulative value', disabled: !block.value, title: block.value ? undefined : 'Pick a value column first' },
          ]}
          onChange={(v) => set({ show: v as CohortBlock['show'] })}
        />
      </div>
      <div className={b.row}>
        <span className={b.label}>Retention curve</span>
        <div className={s.checkRow}>
          <Checkbox label="Show as a line per cohort" checked={block.curve} onCheckedChange={(on) => set({ curve: on })} />
        </div>
      </div>
      <p className={b.note}>A member’s cohort is the period of their first event; each column counts who came back that many periods later.</p>
    </div>
  );
}

function FunnelForm({ projectId, datasetId, cols, block, onChange }: { projectId: string; datasetId: string; cols: readonly Column[]; block: FunnelBlock; onChange: (f: FunnelBlock) => void }) {
  const set = (patch: Partial<FunnelBlock>) => {
    const next = { ...block, ...patch } as FunnelBlock & Record<string, unknown>;
    for (const k of Object.keys(patch)) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange(next);
  };
  // The event column's own values, from the server (≤ 200), for the step picker.
  const distinct = useQuery({
    queryKey: ['dataset:distinct', projectId, datasetId, block.event, 200, ''],
    enabled: !!block.event,
    queryFn: async () => ((await rpc('dataset:distinct', { projectId, datasetId, column: block.event, limit: 200 })) as { values?: unknown[] } | null)?.values?.map(String) ?? [],
  });
  const values = distinct.data ?? [];
  const free = values.filter((v) => v !== '' && !block.steps.includes(v)).slice(0, 60);
  const swap = (a: number, c: number) => {
    const steps = block.steps.slice();
    [steps[a], steps[c]] = [steps[c], steps[a]];
    set({ steps });
  };
  const full = block.steps.length >= MAX_STEPS;
  return (
    <div className={b.encoding}>
      <Select label="Entity" aria-label="Funnel entity column" value={block.entity} options={pick(entityPool(cols), 'Pick a column')} onValueChange={(v) => set({ entity: v })} />
      <Select label="Event name" aria-label="Funnel event name column" value={block.event} options={pick(cols.filter((c) => c.type === 'text'), 'Pick a column')} onValueChange={(v) => set({ event: v, steps: [] })} />
      <Select label="Timestamp" aria-label="Funnel timestamp column" value={block.time} options={pick(cols.filter((c) => c.type === 'date'), 'Pick a timestamp column')} onValueChange={(v) => set({ time: v })} />
      <div className={b.row} role="group" aria-labelledby="funnel-steps">
        <span className={b.label} id="funnel-steps">
          Steps
        </span>
        {block.steps.length === 0 ? (
          <p className={s.empty}>{block.event ? 'Add at least two steps, in order.' : 'Pick the event name column first.'}</p>
        ) : (
          <ol className={s.chips}>
            {block.steps.map((step, i) => (
              <li key={step} className={s.chip}>
                <span className={s.stepN}>{i + 1}</span>
                <span className={s.chipName} title={step}>
                  {step}
                </span>
                <IconButton icon="arrow-up" size="sm" label={`Move ${step} earlier`} disabled={i === 0} onClick={() => swap(i, i - 1)} />
                <IconButton icon="arrow-down" size="sm" label={`Move ${step} later`} disabled={i === block.steps.length - 1} onClick={() => swap(i, i + 1)} />
                <IconButton icon="x" size="sm" label={`Remove step ${step}`} onClick={() => set({ steps: block.steps.filter((_, j) => j !== i) })} />
              </li>
            ))}
          </ol>
        )}
        <Menu
          label="Add a step"
          trigger={
            <Button size="sm" icon="plus" className={b.addSlot} disabled={!block.event || full} title={full ? 'A funnel has at most eight steps.' : undefined}>
              Add step
            </Button>
          }
          items={
            distinct.isPending
              ? [{ label: 'Reading the values…', disabled: true, onSelect: () => undefined }]
              : free.length
                ? free.map((v) => ({ label: v, onSelect: () => set({ steps: [...block.steps, v] }) }))
                : [{ label: values.length ? 'Every value is already a step' : 'No values in this column', disabled: true, onSelect: () => undefined }]
          }
        />
      </div>
      <div className={b.row}>
        <span className={b.label}>Window</span>
        <div className={s.window}>
          <Input
            size="sm"
            type="number"
            min={0.1}
            step="any"
            aria-label="Conversion window length"
            value={String(block.window.n)}
            onChange={(e) => {
              const n = Number(e.target.value);
              set({ window: { ...block.window, n: Number.isFinite(n) && n > 0 ? n : 7 } });
            }}
          />
          <Select
            size="sm"
            aria-label="Conversion window unit"
            value={block.window.unit}
            options={[
              { value: 'hours', label: 'hours' },
              { value: 'days', label: 'days' },
            ]}
            onValueChange={(u) => set({ window: { ...block.window, unit: u === 'hours' ? 'hours' : 'days' } })}
          />
        </div>
      </div>
      <Select
        label="Breakdown"
        aria-label="Funnel breakdown column"
        value={block.breakdown ?? ''}
        options={pick(cols.filter((c) => c.type !== 'date' && c.name !== block.entity), 'None')}
        onValueChange={(v) => set({ breakdown: v || undefined })}
      />
      <p className={b.note}>Strict order: each step counts only entities that did the previous one first, within the window of their first step.</p>
    </div>
  );
}

export function EngineShelves({
  kind,
  projectId,
  datasetId,
  cols,
  encoding,
  onChange,
}: {
  kind: EngineKind;
  projectId: string;
  datasetId: string;
  cols: readonly Column[];
  encoding: Encoding;
  onChange: (e: Encoding) => void;
}) {
  if (kind === 'cohort') {
    return <CohortForm cols={cols} block={fitCohort(encoding.cohort, cols)} onChange={(c) => onChange(engineEncoding('cohort', c))} />;
  }
  return <FunnelForm projectId={projectId} datasetId={datasetId} cols={cols} block={fitFunnel(encoding.eventFunnel, cols)} onChange={(f) => onChange(engineEncoding('event_funnel', f))} />;
}
