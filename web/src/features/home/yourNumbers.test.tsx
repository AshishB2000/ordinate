// Home's "Your numbers" (YourNumbers.tsx): the tiles say what the server said,
// word for word; following and unfollowing ask the server and read again; and
// a project with nothing to show has no section.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { serveRpc, type RpcReply } from '../../test-utils';
import { YourNumbers } from './YourNumbers';

const P = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REVENUE = {
  kind: 'metric', id: 'm1', name: 'Revenue', dataset: 'Retail orders', display: '$187.4K', period: 'Dec 2024',
  change: { text: '+6.2%', up: true, tone: 'good', vs: 'Nov 2024' }, spark: [3, 4, null, 6],
};
const COSTS = { ...REVENUE, id: 'm2', name: 'Costs', display: '$21.9K', change: { text: '−18%', up: false, tone: 'bad', vs: 'Nov 2024' }, spark: null };
const GOALS = { kind: 'scorecard', id: 's1', name: 'Company goals', period: 'Q4 2024', off: 3, warn: 2, good: 7, scored: 12 };
const CHOICES = [
  { kind: 'metric', id: 'm1', name: 'Revenue', followed: true },
  { kind: 'metric', id: 'm3', name: 'Orders', followed: false },
  { kind: 'scorecard', id: 's1', name: 'Company goals', followed: true },
];

function show(numbers: RpcReply, follow: RpcReply = { body: { ok: true, followed: [] } }) {
  const calls = serveRpc({ 'numbers:get': numbers, 'numbers:follow': follow });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <YourNumbers projectId={P} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('Your numbers', () => {
  it('shows each followed tile as the server worded it', async () => {
    show({ body: { ok: true, tiles: [REVENUE, COSTS, GOALS], suggestions: [], choices: CHOICES } });
    const rev = await screen.findByRole('article', { name: /^Revenue:/ });
    expect(within(rev).getByText('$187.4K')).toBeTruthy();
    expect(within(rev).getByText('Retail orders · Dec 2024')).toBeTruthy();
    const change = within(rev).getByText('+6.2%', { exact: false });
    expect(change.textContent).toBe('+6.2% vs Nov 2024');
    expect(change.getAttribute('data-tone')).toBe('good');
    expect(rev.querySelector('polyline')?.getAttribute('points')?.split(' ').length).toBe(3); // the gap is skipped, not drawn as zero
    expect(within(screen.getByRole('article', { name: /^Costs:/ })).getByText('−18%', { exact: false }).getAttribute('data-tone')).toBe('bad');
    const goals = screen.getByRole('article', { name: 'Company goals: 3 of 12 goals off track, 2 at risk' });
    expect(within(goals).getByText('of 12 off track')).toBeTruthy();
    // Followed: no suggestions and no "follow" hint; the row's last column offers another.
    expect(screen.queryByText(/stay up here/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Follow another metric or scorecard' }).closest('li')?.getAttribute('data-free')).toBe('1');
  });

  it('unfollows from a tile, and reads the tiles again', async () => {
    const calls = show({ body: { ok: true, tiles: [REVENUE], suggestions: [], choices: CHOICES } });
    fireEvent.click(await screen.findByRole('button', { name: 'Unfollow Revenue' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'numbers:follow')?.payload).toEqual({ projectId: P, kind: 'metric', id: 'm1', on: false }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'numbers:get').length).toBe(2));
  });

  it('follows from the menu, metrics and scorecards apart', async () => {
    const calls = show({ body: { ok: true, tiles: [REVENUE], suggestions: [], choices: CHOICES } });
    const trigger = await screen.findByRole('button', { name: 'Follow a metric' });
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(await screen.findByText('Metrics')).toBeTruthy();
    expect(screen.getByText('Scorecards')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Orders' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'numbers:follow')?.payload).toEqual({ projectId: P, kind: 'metric', id: 'm3', on: true }));
  });

  it('offers the project\'s metrics while nothing is followed', async () => {
    const calls = show({ body: { ok: true, tiles: [], suggestions: [{ ...REVENUE, change: null, spark: null }], choices: CHOICES } });
    const tile = await screen.findByRole('article', { name: 'Revenue: $187.4K, suggested' });
    expect(screen.getByText('Follow the numbers you check most and they stay up here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Follow any metric or scorecard' }).closest('li')?.getAttribute('data-free')).toBe('3');
    fireEvent.click(within(tile).getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'numbers:follow')?.payload).toEqual({ projectId: P, kind: 'metric', id: 'm1', on: true }));
  });

  it('shows nothing for a project with no metrics, and a failed read with its retry', async () => {
    const calls = show({ body: { ok: true, tiles: [], suggestions: [], choices: [] } });
    await waitFor(() => expect(calls.some((c) => c.channel === 'numbers:get')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'Your numbers' })).toBeNull();
    cleanup();
    // Negative control: the same section, its read failing, says so.
    show({ body: { ok: false, error: 'disk on fire' } });
    expect(await screen.findByText('Your numbers could not be loaded')).toBeTruthy();
    expect(screen.getByText('disk on fire')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
