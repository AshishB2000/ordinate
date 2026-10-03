import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PageSkeleton, Skeleton, SkeletonBlock, SkeletonRows, SkeletonTable } from './Skeleton';
import { EmptyState, ErrorState } from './States';

describe('EmptyState', () => {
  it('a heading at the requested level, the line, and its actions', () => {
    render(
      <EmptyState icon="database" title="No datasets yet" heading={3} actions={<button type="button">Import</button>}>
        Bring data in.
      </EmptyState>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'No datasets yet' })).toBeTruthy();
    expect(screen.getByText('Bring data in.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('is an alert with the message and a working retry', () => {
    const retry = vi.fn();
    render(<ErrorState title="Could not load" message="502 from the server" onRetry={retry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('502 from the server');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('has no retry button without a handler', () => {
    render(<ErrorState compact title="Preview failed" message="Text column" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Skeleton', () => {
  it('each shape is ONE labelled busy status; the bars are hidden', () => {
    render(
      <>
        <SkeletonRows rows={3} label="Loading datasets" />
        <SkeletonTable rows={4} cols={3} label="Loading rows" />
        <SkeletonBlock label="Loading chart" />
        <PageSkeleton />
        <Skeleton />
      </>,
    );
    const names = screen.getAllByRole('status').map((s) => s.getAttribute('aria-label'));
    expect(names).toEqual(['Loading datasets', 'Loading rows', 'Loading chart', 'Loading page']);
    for (const s of screen.getAllByRole('status')) expect(s.getAttribute('aria-busy')).toBe('true');
    const table = screen.getByRole('status', { name: 'Loading rows' });
    expect(table.children).toHaveLength(5); // header + 4 rows
    expect(table.children[0].children).toHaveLength(3);
  });
});
