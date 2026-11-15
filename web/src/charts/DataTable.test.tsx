import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable } from './DataTable';

describe('<DataTable>', () => {
  it('renders the reply as a table: headers, row headers, formatted cells, markup as text', () => {
    render(
      <DataTable
        label="Revenue by region"
        data={{ labels: ['East', '<b>West</b>', null], series: [{ name: 'Revenue', values: [1234.5678, 'n/a', null] }, { values: [1, 2, 3] }] }}
      />,
    );
    const table = screen.getByRole('table', { name: 'Revenue by region' });
    const cols = within(table).getAllByRole('columnheader').map((th) => th.textContent);
    expect(cols).toEqual(['Label', 'Revenue', '']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['East', '<b>West</b>', '']);
    expect(within(rows[0]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1,234.57', '1']);
    expect(within(rows[1]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['n/a', '2']);
  });

  it('says a table calculation as its kind, the figure it came from beside it (an answer card\'s "calc")', () => {
    render(
      <DataTable
        label="Share by region"
        data={{ labels: ['East', 'West'], series: [{ name: 'Revenue', values: [0.25, 0.75], raw: [1000, 3000], calc: { kind: 'pct_of_total', along: 'across' } }, { name: 'Orders', values: [3, 4] }] }}
      />,
    );
    const rows = within(screen.getByRole('table', { name: 'Share by region' })).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['25.0% of total · 1.0K', '3']);
    expect(within(rows[1]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['75.0% of total · 3.0K', '4']);
  });
});
