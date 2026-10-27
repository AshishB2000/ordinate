// A KPI's small trend (KpiTrend.tsx): the months as a line and the latest
// change exactly as the server worded and judged it — no figure made here.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrendChange, TrendLine } from './KpiTrend';
import type { KpiTrend } from '../api';

const TREND: KpiTrend = {
  labels: ['Jan 2025', 'Feb 2025', 'Mar 2025'],
  values: [10, null, 14],
  change: { delta: -3, pct: -17.6, deltaDisplay: '3', tone: 'bad', label: 'Mar 2025 vs Feb 2025' },
};

describe('KPI trend', () => {
  it('draws the months it has, and names the span', () => {
    render(<TrendLine trend={TREND} />);
    const line = screen.getByRole('img', { name: 'Monthly trend, Jan 2025 to Mar 2025' });
    // Two points with a figure: one move and one line, the empty month skipped.
    expect(line.querySelector('path')?.getAttribute('d')).toMatch(/^M0\.0,[\d.]+ L120\.0,[\d.]+$/);
  });

  it('draws nothing with fewer than two figures', () => {
    const { container } = render(<TrendLine trend={{ labels: ['Jan 2025'], values: [4] }} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows the server\'s change, its tone and what it compares', () => {
    const { container } = render(<TrendChange change={TREND.change!} pct="−17.6%" />);
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('(−17.6%)')).toBeTruthy();
    expect(screen.getByText('Mar 2025 vs Feb 2025')).toBeTruthy();
    expect(container.querySelector('[class*="bad"]')).not.toBeNull();
  });
});
