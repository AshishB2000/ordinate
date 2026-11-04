import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FilterRows } from './FilterRows';
import type { FilterStep } from '../api';

const TERM = { type: 'term', term: '7d2c1f4e-1111-4222-8333-444455556666' } as unknown as FilterStep;
const F: FilterStep = { type: 'filter', column: 'city', op: '=', value: 'Paris' };

function draw(filters: FilterStep[], onChange = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FilterRows projectId="p" datasetId="d" cols={[{ name: 'city', type: 'text' }]} filters={filters} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('a filter this version cannot edit', () => {
  it('is an inert row: named, with a remove and no column select or condition button', () => {
    const onChange = draw([TERM]);
    expect(screen.getByText('A filter from a newer version')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit the filter/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter from a newer version' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('removing it leaves the filters beside it; removing one of them leaves it', () => {
    const onChange = draw([F, TERM]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter from a newer version' }));
    expect(onChange).toHaveBeenLastCalledWith([F]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
    expect(onChange).toHaveBeenLastCalledWith([TERM]);
  });

  it('NEGATIVE CONTROL: a plain filter is still an editable row', () => {
    draw([F]);
    expect(screen.queryByText('A filter from a newer version')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit the filter on city' })).toBeTruthy();
  });
});
