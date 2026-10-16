import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { KpiStrip, stripPages } from './KpiStrip';
import { PointSheet } from './PointSheet';

describe('stripPages: the KPI strip’s dots from its scroll geometry', () => {
  it('a row that fits is one page and draws no dots', () => {
    expect(stripPages(300, 343, 0)).toEqual({ pages: 1, at: 0 });
    expect(stripPages(0, 0, 0)).toEqual({ pages: 1, at: 0 });
  });
  it('a row twice as wide is two pages; the end of the scroll is the last one', () => {
    expect(stripPages(686, 343, 0)).toEqual({ pages: 2, at: 0 });
    expect(stripPages(686, 343, 343)).toEqual({ pages: 2, at: 1 });
  });
  it('a peek past a whole page is a page of its own, and halfway rounds to the nearer dot', () => {
    expect(stripPages(800, 343, 0).pages).toBe(3);
    expect(stripPages(800, 343, 457 * 0.24).at).toBe(0);
    expect(stripPages(800, 343, 457 * 0.26).at).toBe(1);
  });
});

describe('KpiStrip', () => {
  it('is a focusable, named region holding the cards (no layout here: one page, no dots)', () => {
    render(
      <KpiStrip count={2}>
        <div>Revenue</div>
        <div>Profit</div>
      </KpiStrip>,
    );
    const region = screen.getByRole('region', { name: 'Key figures, 2' });
    expect(region.tabIndex).toBe(0);
    expect(region.textContent).toBe('RevenueProfit');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('PointSheet', () => {
  it('names the point and its chart, lists each action, and a choice closes the sheet THEN runs', () => {
    const calls: string[] = [];
    const onClose = vi.fn(() => calls.push('close'));
    render(
      <PointSheet
        title="Furniture"
        chart="Revenue by category"
        onClose={onClose}
        actions={[
          { label: 'Filter to “Furniture”', hint: 'Every other card shows category: Furniture', icon: 'target', run: () => calls.push('filter') },
          { label: 'Show the rows behind this point', icon: 'table', run: () => calls.push('rows') },
        ]}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Furniture' });
    expect(dialog.textContent).toContain('Revenue by category');
    expect(screen.getByRole('list', { name: 'What to do with Furniture' }).children).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Show the rows behind this point/ }));
    expect(calls).toEqual(['close', 'rows']);
  });
});
