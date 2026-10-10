// Quick starts: pick A and B, press Difference / Ratio / Percent of, and the
// formula is WRITTEN for you. That is all a template does — the text lands in
// the formula box, where the server validates it and computes its value like
// anything typed by hand (./api.ts templateText).

import { useState, type ReactNode } from 'react';
import { Select, type SelectOption } from '../../ui/Select';
import type { Column } from '../prepare/api';
import { TEMPLATES, templateText, type Operand, type TemplateId } from './api';
import c from './Calc.module.css';

const key = (o: Operand) => `${o.kind === 'metric' ? 'm' : 'c'}:${o.name}`;

export function QuickStarts({
  columns,
  metrics = [],
  measure,
  onFill,
  extra,
}: {
  columns: readonly Column[];
  /** Saved metrics a measure may be built from (none on a row). */
  metrics?: readonly string[];
  measure: boolean;
  onFill: (t: ReturnType<typeof templateText>) => void;
  /** Another way to start, at the end of the row (the Assistant's suggestion). */
  extra?: ReactNode;
}) {
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const operands: Operand[] = [...metrics.map((name): Operand => ({ kind: 'metric', name })), ...columns.filter((col) => col.type === 'number').map((col): Operand => ({ kind: 'column', name: col.name }))];
  const options: SelectOption[] = [];
  operands.forEach((o, i) => {
    if (i === 0 || operands[i - 1].kind !== o.kind) options.push({ value: `__h:${o.kind}`, label: o.kind === 'metric' ? 'Metrics' : measure ? 'Columns, totalled' : 'Columns', disabled: true });
    options.push({ value: key(o), label: o.name });
  });
  const pick = (v: string | null) => operands.find((o) => key(o) === v);
  const A = pick(a);
  const B = pick(b);
  const why = operands.length < 2 ? 'This needs two number columns or metrics.' : !A || !B ? 'Pick A and B first.' : undefined;

  return (
    <div className={c.quick} role="group" aria-label="Quick starts">
      <span className={c.quickLabel}>Quick start</span>
      <div className={c.quickPick}>
        <Select size="sm" aria-label="A" placeholder="A" value={a} options={options} disabled={operands.length < 2} onValueChange={setA} />
        <Select size="sm" aria-label="B" placeholder="B" value={b} options={options} disabled={operands.length < 2} onValueChange={setB} />
      </div>
      <div className={c.quickChips}>
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" className={c.chip} disabled={!!why} title={why ?? `${t.label}: ${t.hint}`} onClick={() => A && B && onFill(templateText(t.id as TemplateId, A, B, measure))}>
            <span>{t.label}</span>
            <span className={c.chipHint}>{t.hint}</span>
          </button>
        ))}
        {extra}
      </div>
    </div>
  );
}
