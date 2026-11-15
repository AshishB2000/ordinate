// Admin → Settings → Assistant: "Delete conversations unused for (days)" (src/server/admin/org.ts,
// applied by the shared sweep). Empty keeps every conversation; 1–3650 days, checked before it is sent.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp, serveRpc } from '../../test-utils';

afterEach(() => vi.unstubAllGlobals());

const ADMIN = { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true };
const SAVED = { publicLinks: false, aiProviders: [], uploadCapMb: null, assistantRetentionDays: null, maxUploadMb: 200, providers: [] };

describe('Admin → Settings, Assistant retention', () => {
  it('starts empty (kept), refuses 0 days, and saves a number of days, then empty again as null', async () => {
    const calls = serveRpc({ '/api/auth/me': { body: ADMIN }, 'admin:settings': { body: SAVED }, 'admin:saveSettings': { body: { ok: true } } });
    renderApp('/admin?tab=settings');
    const days = (await screen.findByLabelText('Delete conversations unused for (days)')) as HTMLInputElement;
    const save = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(days.value).toBe('');
    expect(days.placeholder).toBe('Keep them all');
    expect(save.disabled).toBe(true); // nothing changed

    fireEvent.change(days, { target: { value: '0' } });
    expect(screen.getByText('A whole number of days, from 1 to 3650.')).toBeTruthy();
    expect(save.disabled).toBe(true);

    fireEvent.change(days, { target: { value: '90' } });
    expect(screen.queryByText('A whole number of days, from 1 to 3650.')).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.channel === 'admin:saveSettings')?.payload).toEqual({ publicLinks: false, uploadCapMb: null, assistantRetentionDays: 90 }));
  });

  it('shows a stored window, and clearing it sends null (keep them all)', async () => {
    const calls = serveRpc({ '/api/auth/me': { body: ADMIN }, 'admin:settings': { body: { ...SAVED, assistantRetentionDays: 30 } }, 'admin:saveSettings': { body: { ok: true } } });
    renderApp('/admin?tab=settings');
    const days = (await screen.findByLabelText('Delete conversations unused for (days)')) as HTMLInputElement;
    expect(days.value).toBe('30');
    fireEvent.change(days, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'admin:saveSettings')?.payload).toEqual({ publicLinks: false, uploadCapMb: null, assistantRetentionDays: null }));
  });
});
