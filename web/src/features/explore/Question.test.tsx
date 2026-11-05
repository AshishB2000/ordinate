// A question can hold a step this version cannot edit (a glossary term, a newer release's) — it
// rides in through the link. Its pill is inert: shown, removable, never opened, so an edit can
// never splice a plain filter over it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Question } from './Question';
import type { Question as Q } from './spec';
import type { FilterStep } from '../visuals/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

const TERM = { type: 'term', term: '7d2c1f4e-1111-4222-8333-444455556666' } as unknown as FilterStep;
const F: FilterStep = { type: 'filter', column: 'region', op: '=', value: 'East' };
const FIELDS = [{ name: 'region', kind: 'dimension' as const, type: 'text' as const }];

function tree(filters: FilterStep[], onChange: () => void) {
  const question: Q = { chartType: '', encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, filters };
  return (
    <QueryClientProvider client={client}>
      <Question projectId="p" datasetId="d" fields={FIELDS} question={question} onChange={onChange} onFields={() => {}} />
    </QueryClientProvider>
  );
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function draw(filters: FilterStep[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const onChange = vi.fn();
  const view = render(tree(filters, onChange));
  return { onChange, redraw: (next: FilterStep[]) => view.rerender(tree(next, onChange)) };
}

describe('a filter this version cannot edit, in the question', () => {
  it('is an inert pill: its sentence, no edit, and Remove takes it out alone', () => {
    const { onChange } = draw([F, TERM]);
    expect(screen.getByText('A filter from a newer version')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Change the filter on/ })).toHaveLength(1); // the plain filter's, not the term's
    expect(screen.queryByText(/undefined/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter from a newer version' }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]![0].filters).toEqual([F]);
  });

  it('NEGATIVE CONTROL: a plain filter pill still opens its editor', () => {
    draw([F, TERM]);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change the filter on region' }));
    expect(screen.getByRole('dialog', { name: 'Filter: region' })).toBeTruthy();
  });

  it('an open editor closes if the question changes under it to a kept step at that place — an apply would splice over it', () => {
    const { redraw } = draw([F]);
    fireEvent.click(screen.getByRole('button', { name: 'Change the filter on region' }));
    expect(screen.getByRole('dialog', { name: 'Filter: region' })).toBeTruthy();
    redraw([TERM]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
