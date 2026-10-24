// The top bar's bell is on every page: closed, it asks for no role (the shell
// costs a page nothing more); opened by a project viewer, it reads the inbox
// and the rules, and marks what THEY have seen — nothing that changes a rule or
// silences anyone. The editor's bell is the negative control.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const RULE = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const PROJECT = { id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false };
const ALERTS = {
  ok: true,
  digest: false,
  unseen: 1,
  rules: [{ id: RULE, name: 'Revenue drop', datasetId: D, metric: { column: 'revenue', aggregation: 'sum' }, compare: 'threshold', enabled: true, threshold: { op: '<', value: 10 }, quietHours: { from: 22, to: 6 } }],
  events: [{ id: 'e1', ruleId: RULE, ruleName: 'Revenue drop', datasetId: D, message: 'Revenue fell to 8.', at: '2026-10-01T10:00:00Z', value: 8, seen: false }],
};

const routes = (role: string, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'projects:overview': { body: [PROJECT] },
  'projects:roles': { body: { [P]: role } },
  'alerts:list': { body: ALERTS },
  ...extra,
});

async function openBell() {
  const bell = await screen.findByRole('button', { name: /^Alerts/ });
  await waitFor(() => expect(bell.hasAttribute('disabled')).toBe(false)); // the current project is known
  fireEvent.click(bell);
  return screen.findByRole('dialog', { name: 'Alerts' });
}

describe('the alert bell', () => {
  it('closed, asks for no role; opened by a viewer, offers Mark seen and Mark all seen but no Snooze', async () => {
    const calls = serveRpc(routes('viewer'));
    renderApp('/no-such-page');
    await screen.findByRole('button', { name: /^Alerts/ });
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:overview')).toBe(true));
    expect(calls.some((c) => c.channel === 'projects:roles')).toBe(false);
    const inbox = await openBell();
    expect(await within(inbox).findByText('Revenue fell to 8.')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    await within(inbox).findByRole('button', { name: 'Rules' });
    for (const name of ['Snooze for everyone · 24 h', 'Manage rules']) expect(within(inbox).queryByRole('button', { name })).toBeNull();
    expect(within(inbox).getByRole('button', { name: 'Mark seen' })).toBeTruthy(); // their own inbox
    expect(within(inbox).getByRole('button', { name: 'Mark all seen' })).toBeTruthy();
    expect(within(inbox).getByRole('button', { name: 'Explain' })).toBeTruthy(); // reading is theirs
    fireEvent.click(within(inbox).getByRole('button', { name: 'Rules' }));
    const rules = await screen.findByRole('dialog', { name: 'Alert rules' });
    expect(within(rules).getByRole('switch', { name: 'Enable Revenue drop' }).hasAttribute('disabled')).toBe(true);
    expect(within(rules).getByRole('checkbox', { name: 'One digest notification per refresh' }).hasAttribute('disabled')).toBe(true);
    expect(within(rules).getByRole('combobox', { name: 'Quiet from, Revenue drop' }).hasAttribute('disabled')).toBe(true);
    expect(within(rules).queryByRole('button', { name: 'No quiet hours for Revenue drop' })).toBeNull();
    expect(within(rules).queryByRole('button', { name: 'Delete Revenue drop' })).toBeNull();
    expect(calls.filter((c) => /^alerts:(patch|markSeen|delete|setDigest|save)$/.test(c.channel))).toEqual([]);
  }, 30_000);

  it('a viewer\'s Mark seen and Mark all seen write their own inbox (alerts:markSeen), never a rule', async () => {
    const calls = serveRpc(routes('viewer', { 'alerts:markSeen': { body: { ok: true } } }));
    renderApp('/no-such-page');
    const inbox = await openBell();
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Mark seen' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'alerts:markSeen' && (c.payload as { eventId?: string }).eventId === 'e1')).toBe(true));
    fireEvent.click(within(inbox).getByRole('button', { name: 'Mark all seen' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'alerts:markSeen').length).toBe(2));
    // Mark all seen covers what the bell drew: the newest event's time goes with it.
    expect(calls.filter((c) => c.channel === 'alerts:markSeen')[1]?.payload).toEqual({ projectId: P, through: '2026-10-01T10:00:00Z' });
    expect(calls.filter((c) => /^alerts:(patch|delete|setDigest|save)$/.test(c.channel))).toEqual([]);
    cleanup();
  }, 30_000);

  it('negative control: an editor\'s bell marks seen, snoozes and manages the rules', async () => {
    serveRpc(routes('editor'));
    renderApp('/no-such-page');
    const inbox = await openBell();
    expect(await within(inbox).findByRole('button', { name: 'Mark all seen' })).toBeTruthy();
    expect(within(inbox).getByRole('button', { name: 'Snooze for everyone · 24 h' })).toBeTruthy();
    expect(within(inbox).getByRole('button', { name: 'Mark seen' })).toBeTruthy();
    fireEvent.click(within(inbox).getByRole('button', { name: 'Manage rules' }));
    const rules = await screen.findByRole('dialog', { name: 'Alert rules' });
    expect(within(rules).getByRole('button', { name: 'Delete Revenue drop' })).toBeTruthy();
    expect(within(rules).getByRole('switch', { name: 'Enable Revenue drop' }).hasAttribute('disabled')).toBe(false);
    cleanup();
  }, 30_000);
});
