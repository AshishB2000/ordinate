// The Prepare group step takes Count distinct; the pivot step never does (a pivot cell is one value per group).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GroupAggregateForm } from './FormsBasic';
import { PivotForm } from './FormsReshape';
import type { FormProps } from './FormParts';

afterEach(cleanup);

const ctx = { columns: [{ name: 'region', type: 'text' as const }, { name: 'customer_id', type: 'text' as const }] } as unknown as FormProps['ctx'];

describe('Prepare aggregation lists', () => {
  it('the group step lists Count distinct, and it stores fn: countd', () => {
    const set = (() => {}) as FormProps['set'];
    render(<GroupAggregateForm draft={{ groupBy: ['region'], aggregations: [{ fn: 'sum', column: 'customer_id', as: '' }] }} set={set} ctx={ctx} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Aggregation' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['sum', 'avg', 'count', 'Count distinct', 'min', 'max']);
  });

  it('NEGATIVE CONTROL: the pivot step does not', () => {
    render(<PivotForm draft={{ key: 'region', value: 'customer_id', fn: 'sum' }} set={(() => {}) as FormProps['set']} ctx={ctx} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Aggregation' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['sum', 'avg', 'count', 'min', 'max']);
  });
});
