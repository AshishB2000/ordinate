// The two kinds of calculated field, explained where the choice is made: one
// sentence each, and one tiny worked example of why it matters. The example's
// figures are fixed text about two made-up orders — nothing here is computed.

import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../ui/icons/Icon';
import c from './Calc.module.css';

export type Kind = 'measure' | 'column';

const KINDS: { id: Kind; icon: IconName; title: string; when: string; what: string; example: string }[] = [
  {
    id: 'measure',
    icon: 'function',
    title: 'Measure',
    when: 'calculated after totals',
    what: 'The chart totals each column first, then runs the formula once for every bar, slice or cell. Right for ratios, rates and shares.',
    example: 'sum([Profit]) / sum([Revenue])',
  },
  {
    id: 'column',
    icon: 'columns',
    title: 'Column',
    when: 'calculated on every row',
    what: 'The formula runs on each row and is saved as a new column of the dataset, which charts then total like any other. Right for a per-row amount.',
    example: '[Price] * [Quantity]',
  },
];

export function KindPicker({ value, onChange, columnOff }: {
  value: Kind;
  onChange: (kind: Kind) => void;
  /** Why the Column kind is not on offer (a Live dataset), with its way out; absent when it is. */
  columnOff?: ReactNode;
}) {
  return (
    <div className={c.kinds}>
      <div className={c.kindRow} role="radiogroup" aria-label="Kind of calculated field">
        {KINDS.map((k) => {
          const off = k.id === 'column' && !!columnOff;
          return (
            <div key={k.id} className={[c.kind, value === k.id && c.kindOn, off && c.kindOff].filter(Boolean).join(' ')}>
              <button type="button" role="radio" aria-checked={value === k.id} aria-disabled={off || undefined} className={c.kindPick} onClick={() => !off && onChange(k.id)}>
                <span className={c.kindIcon}>
                  <Icon name={k.icon} size={20} />
                </span>
                <span className={c.kindTitle}>
                  {k.title} <span className={c.kindWhen}>({k.when})</span>
                </span>
                <span className={c.kindWhat}>{k.what}</span>
                <code className={c.kindExample}>{k.example}</code>
              </button>
              {off && <div className={c.kindWhy}>{columnOff}</div>}
            </div>
          );
        })}
      </div>
      <WorkedExample />
    </div>
  );
}

/** Why "Margin %" must be a measure: the same two orders, both ways. */
function WorkedExample() {
  return (
    <figure className={c.example} aria-label="Why Margin % must be a measure">
      <figcaption className={c.exampleHead}>Why it matters: Margin % over two orders</figcaption>
      <table className={c.exampleTable}>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Profit</th>
            <th scope="col">Revenue</th>
            <th scope="col">Margin</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">A</th>
            <td>10</td>
            <td>100</td>
            <td>10%</td>
          </tr>
          <tr>
            <th scope="row">B</th>
            <td>90</td>
            <td>300</td>
            <td>30%</td>
          </tr>
        </tbody>
      </table>
      <ul className={c.exampleWays}>
        <li className={c.right}>
          <Icon name="circle-check" />
          <span>
            <strong>As a measure:</strong> 100 ÷ 400 = <b>25%</b> — the margin on everything sold.
          </span>
        </li>
        <li className={c.wrong}>
          <Icon name="alert" />
          <span>
            <strong>As a column, then averaged:</strong> (10% + 30%) ÷ 2 = <b>20%</b> — wrong: the small order counts as much as the large one.
          </span>
        </li>
      </ul>
    </figure>
  );
}
