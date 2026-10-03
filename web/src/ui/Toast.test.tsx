import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { toast, Toaster } from './Toast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => { vi.runAllTimers(); }); // empty the module-level stack for the next test
  vi.useRealTimers();
});

describe('Toast', () => {
  it('the stack is a polite live region, present before any message', () => {
    render(<Toaster />);
    const region = screen.getByRole('status', { name: 'Notifications' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.childElementCount).toBe(0);
    act(() => void toast('Saved', { kind: 'success' }));
    expect(region.textContent).toBe('Saved');
  });

  it('keeps three at most: a fourth pushes the oldest out', () => {
    render(<Toaster />);
    act(() => {
      toast('one');
      toast('two');
      toast('three');
      toast('four');
    });
    const region = screen.getByRole('status');
    expect([...region.children].map((c) => c.textContent)).toEqual(['two', 'three', 'four']);
  });

  it('each goes away after 4 seconds', () => {
    render(<Toaster />);
    act(() => void toast('Copied'));
    act(() => { vi.advanceTimersByTime(3999); });
    expect(screen.queryByText('Copied')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('an action runs and dismisses its toast', () => {
    const retry = vi.fn();
    render(<Toaster />);
    act(() => void toast('Export failed', { kind: 'error', action: { label: 'Retry', onClick: retry } }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText('Export failed')).toBeNull();
  });

  it('renders a message as text, never markup', () => {
    render(<Toaster />);
    act(() => void toast('<img src=x onerror=alert(1)>'));
    expect(screen.getByRole('status').querySelector('img')).toBeNull();
  });
});
