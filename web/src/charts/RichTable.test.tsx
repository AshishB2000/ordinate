// The Table shape's table (RichTable.tsx): sorts, searches and draws a bar per
// cell from the server's own figures — never a figure of its own.

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RichTable } from './RichTable';

const DATA = {
  labels: ['Texas', 'California', 'Wyoming', 'Florida'],
  series: [{ name: 'Population', values: [30_500_000, 39_000_000, 580_000, null] }],
};
const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => within(r).getByRole('rowheader').textContent);

describe('RichTable', () => {
  it('starts in the server\'s order, every cell its formatted figure', () => {
    render(<RichTable data={DATA as never} label="States" />);
    expect(rows()).toEqual(['Texas', 'California', 'Wyoming', 'Florida']);
    expect(screen.getByRole('row', { name: /California/ }).textContent).toContain('39,000,000');
  });

  it('sorts a figure column largest first, then turns it round; a row with no figure stays last', () => {
    render(<RichTable data={DATA as never} label="States" />);
    const pop = screen.getByRole('button', { name: /Population/ });
    fireEvent.click(pop);
    expect(rows()).toEqual(['California', 'Texas', 'Wyoming', 'Florida']);
    expect(screen.getByRole('columnheader', { name: /Population/ }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(pop);
    expect(rows()).toEqual(['Wyoming', 'Texas', 'California', 'Florida']);
    fireEvent.click(screen.getByRole('button', { name: /Label/ }));
    expect(rows()).toEqual(['California', 'Florida', 'Texas', 'Wyoming']);
  });

  it('searches the row labels, and says when nothing matches', () => {
    render(<RichTable data={DATA as never} label="States" />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search States' }), { target: { value: 'or' } });
    expect(rows()).toEqual(['California', 'Florida']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search States' }), { target: { value: 'zz' } });
    expect(screen.getByText('No row matches “zz”.')).toBeTruthy();
  });

  it('draws each bar as the cell\'s share of its column\'s largest, and none without a figure', () => {
    const { container } = render(<RichTable data={DATA as never} label="States" />);
    const widths = Array.from(container.querySelectorAll('tbody tr')).map((r) => (r.querySelector('[style]') as HTMLElement | null)?.style.width ?? null);
    expect(widths[1]).toBe('100%');
    expect(Number.parseFloat(widths[0] ?? '')).toBeCloseTo((30_500_000 / 39_000_000) * 100, 6);
    expect(widths[3]).toBeNull();
  });
});
