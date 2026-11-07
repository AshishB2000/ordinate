import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { movesPin, pickerOrder, type StatusView } from './status';
import { StatusBadge } from './StatusBadge';

afterEach(cleanup);

const view = (state: StatusView['state'], extra: Partial<StatusView> = {}): StatusView => ({ state, by: 'ana@acme.com', at: '2026-11-03T10:00:00Z', note: 'checked', ...extra });
const item = (name: string, status?: StatusView) => ({ name, status });
const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe('pickerOrder', () => {
  const R = item('R', view('retired'));
  const N = item('N', view('needs_review'));
  const C = item('C', view('certified'));
  it('puts certified first, folds retired away, keeps needs_review with the unmarked', () => {
    expect(names(pickerOrder([R, N, C]).main)).toEqual(['C', 'N']);
    expect(names(pickerOrder([R, N, C]).retired)).toEqual(['R']);
  });
  it('NEGATIVE CONTROL: with no status anywhere the order is the input order', () => {
    const plain = [item('b'), item('a'), item('c')];
    expect(names(pickerOrder(plain).main)).toEqual(['b', 'a', 'c']);
    expect(pickerOrder(plain).retired).toEqual([]);
  });
});

describe('movesPin', () => {
  it('is false for a field the pin ignores and true for one it hashes', () => {
    expect(movesPin('metric', { description: 'x' })).toBe(false);
    expect(movesPin('metric', { filters: [] })).toBe(true);
    expect(movesPin('term', { aliases: ['a'] })).toBe(false);
    expect(movesPin('term', { filters: [] })).toBe(true);
  });
});

describe('StatusBadge', () => {
  it('draws nothing without a status', () => {
    const { container } = render(<StatusBadge />);
    expect(container.firstChild).toBeNull();
  });
  it('says each state in words and names who certified on hover', () => {
    const { rerender } = render(<StatusBadge status={view('certified')} />);
    const badge = screen.getByText('Certified');
    expect(badge.closest('[title]')?.getAttribute('title')).toContain('Certified by ana@acme.com');
    rerender(<StatusBadge status={view('needs_review')} />);
    expect(screen.getByText('Changed since certified')).toBeTruthy();
    rerender(<StatusBadge status={view('retired', { replacedBy: { ref: 'metric:x', name: 'Net revenue' } })} />);
    expect(screen.getByText('Retired · use Net revenue')).toBeTruthy();
    rerender(<StatusBadge status={view('retired')} />);
    expect(screen.getByText('Retired')).toBeTruthy();
  });
});
