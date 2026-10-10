// A scenario's SETUP (scenarioDrivers.ts): the metrics it moves, as chips, and
// its drivers, as sliders and inputs, in the order they apply. "Add driver"
// aims a new one at a column (every row, or only rows where a column has a
// value) or at a metric; the columns offered are the ones the metrics actually
// aggregate (`scenario:targets`), so a driver can always move something. Labels
// come back from the server with each compute.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { distinctValues } from '../../live/distinct';
import { Button, IconButton } from '../../../ui/Button';
import { Menu, type MenuEntry } from '../../../ui/Menu';
import { Select } from '../../../ui/Select';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import type { ScenarioDriver, ScenarioMetric, ScenarioResult, ScenarioTargets } from '../api';
import { Seg } from '../stats/StatsControls';
import s from './ScenarioEditor.module.css';

export interface Draft {
  name: string;
  baseMetricIds: string[];
  drivers: ScenarioDriver[];
}

/** A number field that keeps what is being typed ("-", "1.") until it reads as a number. */
function NumField({ value, onValue, label, className }: { value: number; onValue: (v: number) => void; label: string; className?: string }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  return (
    <input
      type="number"
      step="any"
      className={className}
      aria-label={label}
      value={text}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(v)) onValue(v);
      }}
    />
  );
}

function DriverRow({
  d,
  i,
  count,
  info,
  update,
  move,
  remove,
}: {
  d: ScenarioDriver;
  i: number;
  count: number;
  info: ScenarioResult['drivers'][number] | null;
  update: (patch: Partial<ScenarioDriver>) => void;
  move: (by: number) => void;
  remove: () => void;
}) {
  const n = i + 1;
  const pct = d.kind === 'pct';
  return (
    <div className={s.drv}>
      <div className={s.drvHead}>
        <span className={s.drvN} aria-hidden="true">
          {n}
        </span>
        <span className={s.drvLabel}>{info ? info.label : d.name || 'New driver'}</span>
        <span className={s.drvActs}>
          <IconButton icon="chevron-up" size="sm" label={`Apply driver ${n} earlier`} disabled={i === 0} onClick={() => move(-1)} />
          <IconButton icon="chevron-down" size="sm" label={`Apply driver ${n} later`} disabled={i === count - 1} onClick={() => move(1)} />
          <IconButton icon="trash" size="sm" label={`Remove driver ${n}`} onClick={remove} />
        </span>
      </div>
      {info?.targetText && <div className={s.drvTarget}>{info.targetText}</div>}
      <div className={s.drvCtl}>
        <select
          className={s.drvKind}
          aria-label={`Driver ${n}: change by a percent or set a value`}
          value={d.kind}
          onChange={(e) => update({ kind: e.target.value as 'pct' | 'abs', value: e.target.value === 'pct' ? 5 : 0 })}
        >
          <option value="pct">Change by</option>
          <option value="abs">Set to</option>
        </select>
        {pct && (
          <input
            type="range"
            step="0.5"
            className={s.drvRange}
            aria-label={`Driver ${n} percent change slider`}
            min={Math.max(-100, Math.min(-50, Math.floor(d.value)))}
            max={Math.max(50, Math.ceil(d.value))}
            value={d.value}
            onChange={(e) => update({ value: Number(e.target.value) })}
          />
        )}
        <NumField
          className={pct ? s.drvNum : `${s.drvNum} ${s.drvNumWide}`}
          label={pct ? `Driver ${n} percent change` : `Driver ${n} value`}
          value={d.value}
          onValue={(v) => update({ value: pct ? Math.max(-100, v) : v })}
        />
        <span className={s.drvUnit} aria-hidden="true">
          {pct ? '%' : ''}
        </span>
      </div>
      <div className={s.drvFoot}>
        <label className={s.drvParam}>
          <span>On a dashboard, follow parameter</span>
          <input
            type="text"
            className={s.drvParamIn}
            placeholder="none"
            spellCheck={false}
            aria-label={`Driver ${n}: dashboard number parameter it follows`}
            defaultValue={d.param ?? ''}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (d.param ?? '')) update({ param: v || undefined });
            }}
          />
        </label>
        {info && !info.applied && (
          <span className={s.drvHint}>
            <Icon name="alert" size={12} /> Changes none of these metrics
          </span>
        )}
      </div>
    </div>
  );
}

type Add = { mode: 'column' | 'metric'; column: string; fcol: string; fval: string; metricId: string; kind: 'pct' | 'abs'; value: string };
const ADD_DEFAULT: Add = { mode: 'column', column: '', fcol: '', fval: '', metricId: '', kind: 'pct', value: '5' };

function AddDriver({ projectId, targets, onAdd }: { projectId: string; targets: ScenarioTargets | null; onAdd: (d: ScenarioDriver) => void }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState<Add>(ADD_DEFAULT);
  const cols = targets?.columns ?? [];
  const ms = targets?.metrics ?? [];
  const column = a.column || (cols[0] ? `${cols[0].datasetId}|${cols[0].column}` : '');
  const metricId = a.metricId || ms[0]?.id || '';
  const dsId = column.split('|')[0];
  const ds = targets?.datasets.find((x) => x.id === dsId);
  const values = useQuery({
    queryKey: ['dataset:distinct', projectId, dsId, a.fcol],
    queryFn: async () => (await distinctValues({ projectId, datasetId: dsId, column: a.fcol, limit: 200 })).values.map((v) => String(v)),
    enabled: open && a.mode === 'column' && !!a.fcol && !!dsId,
  });
  const fval = values.data?.includes(a.fval) ? a.fval : (values.data?.[0] ?? '');

  if (!open) {
    return (
      <button
        type="button"
        className={s.addBtn}
        onClick={() => {
          setA(ADD_DEFAULT);
          setOpen(true);
        }}
      >
        <Icon name="plus" size={12} /> Add driver
      </button>
    );
  }
  function confirm() {
    const v = Number(a.value);
    if (a.value.trim() === '' || !Number.isFinite(v)) {
      toast('Give the driver a number.', { kind: 'error' });
      return;
    }
    let target: ScenarioDriver['target'];
    if (a.mode === 'metric') {
      if (!metricId) return;
      target = { metricId };
    } else {
      const name = column.split('|').slice(1).join('|');
      if (!name) return;
      target = a.fcol ? { column: name, filter: { type: 'filter', column: a.fcol, op: '=', value: fval } } : { column: name };
    }
    onAdd({ name: '', kind: a.kind, value: a.kind === 'pct' ? Math.max(-100, v) : v, target });
    setOpen(false);
  }
  return (
    <div className={s.addForm} role="group" aria-label="New driver">
      <Seg label="What the driver moves" options={[['column', 'A column'], ['metric', 'A metric']]} value={a.mode} onChange={(v) => setA({ ...a, mode: v as Add['mode'] })} />
      {a.mode === 'column' ? (
        cols.length === 0 ? (
          <p className={s.sideEmpty}>These metrics aggregate no column a driver can move. Add a sum, average, min or max metric.</p>
        ) : (
          <>
            <Select
              label="Column"
              size="sm"
              value={column}
              options={cols.map((c) => ({ value: `${c.datasetId}|${c.column}`, label: `${c.column} — in ${c.metrics.join(', ')}` }))}
              onValueChange={(v) => setA({ ...a, column: v, fcol: '', fval: '' })}
            />
            <Select
              label="Only rows where"
              size="sm"
              value={a.fcol}
              options={[{ value: '', label: 'All rows' }, ...(ds ? ds.columns.filter((c) => c.type !== 'number').map((c) => ({ value: c.name, label: c.name })) : [])]}
              onValueChange={(v) => setA({ ...a, fcol: v, fval: '' })}
            />
            {a.fcol && (
              <Select
                label="is"
                size="sm"
                value={values.data?.length ? fval : null}
                placeholder={values.isPending ? 'Loading…' : 'No values'}
                disabled={!values.data?.length}
                options={(values.data ?? []).map((v) => ({ value: v, label: v === '' ? '(empty)' : v }))}
                onValueChange={(v) => setA({ ...a, fval: v })}
              />
            )}
          </>
        )
      ) : (
        <Select label="Metric" size="sm" value={metricId || null} options={ms.map((m) => ({ value: m.id, label: m.name }))} onValueChange={(v) => setA({ ...a, metricId: v })} />
      )}
      <div className={s.addLine}>
        <Select
          label="Change"
          size="sm"
          value={a.kind}
          options={[
            { value: 'pct', label: 'By %' },
            { value: 'abs', label: 'Set to' },
          ]}
          onValueChange={(v) => setA({ ...a, kind: v as Add['kind'], value: v === 'pct' ? '5' : '0' })}
        />
        <label className={s.field}>
          <span className={s.fieldLabel}>{a.kind === 'pct' ? 'Percent' : 'Value'}</span>
          <input type="number" step="any" className={s.input} value={a.value} onChange={(e) => setA({ ...a, value: e.target.value })} />
        </label>
      </div>
      <div className={s.addActions}>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={confirm}>
          Add driver
        </Button>
      </div>
    </div>
  );
}

export function ScenarioSetup({
  projectId,
  draft,
  metrics,
  targets,
  result,
  onChange,
}: {
  projectId: string;
  draft: Draft;
  metrics: readonly ScenarioMetric[];
  targets: ScenarioTargets | null;
  result: ScenarioResult | null;
  onChange: (next: Draft) => void;
}) {
  const nameOf = (id: string) => metrics.find((m) => m.id === id)?.name ?? 'Missing metric';
  const left = metrics.filter((m) => !draft.baseMetricIds.includes(m.id));
  const menu: MenuEntry[] =
    !left.length || draft.baseMetricIds.length >= 12
      ? [{ kind: 'heading', label: left.length ? 'Twelve metrics is the most a scenario shows.' : 'Every metric in this project is already here.' }]
      : left.map((m) => ({ label: m.name, onSelect: () => onChange({ ...draft, baseMetricIds: [...draft.baseMetricIds, m.id] }) }));
  /** The server's words for driver i — only while its result still describes that driver. */
  const infoOf = (i: number) => {
    const d = draft.drivers[i];
    const info = result?.drivers[i];
    return d && info && info.kind === d.kind && JSON.stringify(info.target) === JSON.stringify(d.target) ? info : null;
  };
  const setDrivers = (drivers: ScenarioDriver[]) => onChange({ ...draft, drivers });
  const ideas: Array<{ text: string; driver: ScenarioDriver }> = [];
  const cols = targets?.columns ?? [];
  if (cols[0]) ideas.push({ text: `${cols[0].column} +5%`, driver: { name: '', kind: 'pct', value: 5, target: { column: cols[0].column } } });
  if (cols[1]) ideas.push({ text: `${cols[1].column} −3%`, driver: { name: '', kind: 'pct', value: -3, target: { column: cols[1].column } } });
  const ms = targets?.metrics ?? [];
  if (ms[0]) ideas.push({ text: `${ms[0].name} −10%`, driver: { name: '', kind: 'pct', value: -10, target: { metricId: ms[0].id } } });

  return (
    <aside className={s.side} aria-label="Scenario setup">
      <section className={s.sec} aria-labelledby="sn-metrics-h">
        <div className={s.secHead}>
          <h2 className={s.secH} id="sn-metrics-h">
            Metrics
          </h2>
          <Menu
            align="end"
            trigger={
              <Button size="sm" icon="plus">
                Metric
              </Button>
            }
            items={menu}
          />
        </div>
        <div className={s.mchips}>
          {draft.baseMetricIds.length === 0 ? (
            <p className={s.sideEmpty}>No metrics yet — add the ones you want to see move.</p>
          ) : (
            draft.baseMetricIds.map((id) => (
              <span key={id} className={s.mchip}>
                <span>{nameOf(id)}</span>
                <IconButton
                  icon="x"
                  size="sm"
                  label={`Remove ${nameOf(id)}`}
                  className={s.mchipX}
                  onClick={() => onChange({ ...draft, baseMetricIds: draft.baseMetricIds.filter((m) => m !== id) })}
                />
              </span>
            ))
          )}
        </div>
      </section>
      <section className={s.sec} aria-labelledby="sn-drivers-h">
        <div className={s.secHead}>
          <h2 className={s.secH} id="sn-drivers-h">
            Drivers {draft.drivers.length > 0 && <span className={s.count}>{draft.drivers.length}</span>}
          </h2>
          <span className={s.secNote}>Applied top to bottom</span>
        </div>
        <div className={s.drivers}>
          {draft.drivers.length === 0 ? (
            <div className={s.driversEmpty}>
              <p className={s.driversEmptyH}>No drivers yet — every figure is its baseline</p>
              <p>A driver moves one input: a column&apos;s values (every row, or only some rows) or a metric&apos;s result. The stored data never changes.</p>
              {ideas.length > 0 && (
                <div className={s.ideas}>
                  {ideas.map((idea) => (
                    <button key={idea.text} type="button" className={s.idea} aria-label={`Add the driver ${idea.text}`} onClick={() => setDrivers([{ ...idea.driver, name: idea.text }])}>
                      {idea.text}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            draft.drivers.map((d, i) => (
              <DriverRow
                key={`${i}-${d.kind}-${JSON.stringify(d.target)}`}
                d={d}
                i={i}
                count={draft.drivers.length}
                info={infoOf(i)}
                update={(patch) => setDrivers(draft.drivers.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
                move={(by) => {
                  const to = i + by;
                  if (to < 0 || to >= draft.drivers.length) return;
                  const next = draft.drivers.slice();
                  [next[i], next[to]] = [next[to], next[i]];
                  setDrivers(next);
                }}
                remove={() => setDrivers(draft.drivers.filter((_, j) => j !== i))}
              />
            ))
          )}
        </div>
        <AddDriver projectId={projectId} targets={targets} onAdd={(d) => setDrivers([...draft.drivers, d])} />
      </section>
    </aside>
  );
}
