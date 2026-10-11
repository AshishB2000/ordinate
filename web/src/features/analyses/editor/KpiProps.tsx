// A KPI card's Compare setting (legacy kpiCompare.ts anRenderCompareProps):
// which other period its delta line measures against. The delta itself is a
// second resolution on the server, recomputed on every render, never stored.

import { useState } from 'react';
import { Select } from '../../../ui/Select';
import type { Card } from '../api';
import { useScenarios } from '../../analytics/api';
import { useEditor } from './context';
import s from './Properties.module.css';

const OPTIONS = [
  { value: '', label: 'No comparison' },
  { value: 'previous_period', label: 'Previous period' },
  { value: 'previous_year', label: 'Same period last year' },
  { value: 'custom', label: 'Custom range…' },
];

export function KpiCompare({ card }: { card: Card }) {
  const ed = useEditor();
  const cur = card.metric?.compare;
  const [mode, setMode] = useState<string>(cur?.mode ?? '');
  const [from, setFrom] = useState(cur?.mode === 'custom' ? (cur.from ?? '') : '');
  const [to, setTo] = useState(cur?.mode === 'custom' ? (cur.to ?? '') : '');

  const write = (m: string, f: string, t: string) => {
    if (m === 'custom' && (!f || !t)) return; // half a range compares nothing
    ed.edit('Compare', (d) => {
      const c = d.sheets[ed.sheet].cards.find((x) => x.id === card.id);
      if (!c?.metric) return;
      if (!m) delete c.metric.compare;
      else if (m === 'custom') c.metric.compare = { mode: 'custom', from: f, to: t };
      else c.metric.compare = { mode: m as 'previous_period' | 'previous_year' };
    });
  };

  return (
    <div className={s.section}>
      <Select
        label="Compare with"
        value={mode}
        options={OPTIONS}
        onValueChange={(m) => {
          setMode(m);
          write(m, from, to);
        }}
      />
      {mode === 'custom' && (
        <div className={s.range}>
          <label className={s.dateField}>
            <span>From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                write(mode, e.target.value, to);
              }}
            />
          </label>
          <label className={s.dateField}>
            <span>To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                write(mode, from, e.target.value);
              }}
            />
          </label>
        </div>
      )}
      <p className={s.note}>
        {mode === 'custom'
          ? "The card's figure against the same figure over these dates."
          : mode
            ? "Moves the date range of the dashboard's filters and resolves the figure again — so it needs a date filter or date control in scope."
            : 'Show how the figure changed against another period, coloured by whether up is good.'}
      </p>
    </div>
  );
}

/**
 * A KPI on a saved metric can show it under a what-if scenario (Analytics →
 * Scenarios): the figure with the scenario's drivers applied, beside its
 * baseline. The server computes both on every render; the card stores only
 * which scenario. A driver that follows a dashboard parameter takes that
 * parameter's current value — so a parameter control on the sheet is its slider.
 */
export function KpiScenario({ card }: { card: Card }) {
  const ed = useEditor();
  const q = useScenarios(ed.projectId);
  const cur = card.metric?.scenarioId ?? '';
  const list = q.data ?? [];
  // A scenario deleted since stays listed (as that), so the card says what it is asking for until it is changed.
  const options = [{ value: '', label: 'None' }, ...list.map((x) => ({ value: x.id, label: x.name })), ...(cur && !q.isPending && !list.some((x) => x.id === cur) ? [{ value: cur, label: 'A deleted scenario' }] : [])];
  return (
    <div className={s.section}>
      <Select
        label="What-if scenario"
        value={cur}
        options={options}
        disabled={q.isPending}
        onValueChange={(id) =>
          ed.edit('What-if scenario', (d) => {
            const c = d.sheets[ed.sheet].cards.find((x) => x.id === card.id);
            if (!c?.metric) return;
            if (id) c.metric.scenarioId = id;
            else delete c.metric.scenarioId;
          })
        }
      />
      <p className={s.note}>
        {cur
          ? 'The card shows this metric under the scenario, with its change on the baseline. A driver that follows a parameter moves with that parameter’s control on this sheet.'
          : list.length
            ? 'Show this metric as it would be under a scenario — and move it from a slider by adding a parameter control.'
            : 'No scenarios yet. Build one in Analytics → Scenarios, then pick it here.'}
      </p>
    </div>
  );
}
