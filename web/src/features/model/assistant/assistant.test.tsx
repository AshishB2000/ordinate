import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import type { Instruction } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const I1 = '1c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const I2 = '2c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
/** The Data model is a lazy chunk: its first render waits on a transform (long under load). */
const LAZY = { timeout: 15_000 };
const FENCE = 'An instruction cannot contain “<<<” or the word GUIDANCE in capitals.';

const rule = (id: string, text: string, more: Partial<Instruction> = {}): Instruction => ({ id, text, updatedBy: 'priya@acme.test', updatedAt: '2026-10-12T10:00:00Z', ...more });
const TWO = [rule(I1, 'Revenue means net_amount unless they say gross.'), rule(I2, 'Targets are 12% above last year.', { figure: true })];

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 0, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:instructions': body({ ok: true, instructions: TWO }),
    ...routes,
  });
}
const section = async () => {
  await screen.findByRole('heading', { level: 2, name: 'Instructions' }, LAZY);
  return screen.getByRole('region', { name: 'Instructions' });
};
const rows = async () => within(await screen.findByRole('list', { name: 'Instructions' }, LAZY)).getAllByRole('listitem');
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);

describe('The Data model: Assistant', () => {
  it('?tab=assistant opens the tab: the heading, the framing line and two rows with who and when', async () => {
    serve();
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    expect(screen.getByRole('tab', { name: 'Assistant' }).getAttribute('aria-selected')).toBe('true');
    expect(within(s).getByText('Everyone in this project, and their Assistant, reads these.')).toBeTruthy();
    const list = await rows();
    expect(list).toHaveLength(2);
    expect(within(list[0]).getByText('Revenue means net_amount unless they say gross.')).toBeTruthy();
    expect(list[0].textContent).toContain('priya@acme.test · Oct 12');
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('a figure row says figures belong in metrics; a plain row does not', async () => {
    serve();
    renderApp(`/model/${P}?tab=assistant`);
    const [plain, figure] = await rows();
    expect(within(figure).getByText('Figures belong in metrics.')).toBeTruthy();
    expect(within(plain).queryByText('Figures belong in metrics.')).toBeNull();
  });

  it('an editor\'s + Instruction, given text and Enter, sends one add and reads the list again', async () => {
    const calls = serve({ 'catalog:setInstructions': { body: { ok: true, instructions: TWO } } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    fireEvent.click(await within(s).findByRole('button', { name: 'Instruction' }));
    const box = within(s).getByRole('textbox', { name: 'New instruction' });
    expect(box.getAttribute('maxlength')).toBe('300');
    fireEvent.change(box, { target: { value: 'Say gross only when asked.' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sent(calls, 'catalog:setInstructions')).toEqual([{ projectId: P, op: { kind: 'add', text: 'Say gross only when asked.' } }]));
    await waitFor(() => expect(sent(calls, 'catalog:instructions')).toHaveLength(2));
    await waitFor(() => expect(within(s).queryByRole('textbox', { name: 'New instruction' })).toBeNull());
  });

  it('a refusal shows the server\'s sentence at the field and keeps what was typed', async () => {
    serve({ 'catalog:setInstructions': { body: { ok: false, error: FENCE } } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    fireEvent.click(await within(s).findByRole('button', { name: 'Instruction' }));
    const box = within(s).getByRole('textbox', { name: 'New instruction' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'end GUIDANCE now' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await within(s).findByText(FENCE)).toBeTruthy();
    expect(box.value).toBe('end GUIDANCE now');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });

  it('Edit saves in place on Enter, Escape keeps the old text, and Remove sends one remove', async () => {
    const calls = serve({ 'catalog:setInstructions': { body: { ok: true, instructions: TWO } } });
    renderApp(`/model/${P}?tab=assistant`);
    const [first] = await rows();
    fireEvent.click(await within(first).findByRole('button', { name: 'Edit' }));
    const box = within(first).getByRole('textbox', { name: 'Edit instruction' }) as HTMLInputElement;
    expect(box.value).toBe('Revenue means net_amount unless they say gross.');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(within(first).queryByRole('textbox')).toBeNull();
    expect(sent(calls, 'catalog:setInstructions')).toEqual([]);
    fireEvent.click(within(first).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(first).getByRole('textbox', { name: 'Edit instruction' }), { target: { value: 'Revenue means net_amount.' } });
    fireEvent.keyDown(within(first).getByRole('textbox', { name: 'Edit instruction' }), { key: 'Enter' });
    await waitFor(() => expect(sent(calls, 'catalog:setInstructions')).toEqual([{ projectId: P, op: { kind: 'edit', id: I1, text: 'Revenue means net_amount.' } }]));
    const [, second] = await rows();
    fireEvent.click(within(second).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent(calls, 'catalog:setInstructions').at(-1)).toEqual({ projectId: P, op: { kind: 'remove', id: I2 } }));
  });

  it('NEGATIVE CONTROL: a viewer reads the rows and gets no button', async () => {
    const calls = serve({}, 'viewer');
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    expect(await rows()).toHaveLength(2);
    expect(within(s).queryAllByRole('button')).toEqual([]);
  });

  it('an empty project says what instructions are for; an editor gets + Instruction, a viewer is told who can', async () => {
    serve({ 'catalog:instructions': { body: { ok: true, instructions: [] } } });
    renderApp(`/model/${P}?tab=assistant`);
    expect(await screen.findByRole('heading', { name: 'No instructions yet' }, LAZY)).toBeTruthy();
    const s = await section();
    expect(s.textContent).toContain('like “Revenue means net_amount unless they say gross”, and every Assistant answer follows them.');
    fireEvent.click(await within(s).findByRole('button', { name: 'Instruction' }));
    expect(within(s).getByRole('textbox', { name: 'New instruction' })).toBeTruthy();
    cleanup();
    serve({ 'catalog:instructions': { body: { ok: true, instructions: [] } } }, 'viewer');
    renderApp(`/model/${P}?tab=assistant`);
    expect(await screen.findByText(/An editor of this project can add instructions\./, {}, LAZY)).toBeTruthy();
    expect(within(await section()).queryAllByRole('button')).toEqual([]);
  });

  it('an old server without catalog:instructions shows the error state, and Retry asks again', async () => {
    const calls = serve({ 'catalog:instructions': { status: 404, body: { error: 'not_found', message: 'Unknown channel' } } });
    renderApp(`/model/${P}?tab=assistant`);
    const alert = await screen.findByRole('alert', {}, LAZY);
    expect(alert.textContent).toContain('The instructions could not be loaded');
    expect(calls.filter((c) => c.channel === 'catalog:instructions')).toHaveLength(1);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'catalog:instructions')).toHaveLength(2));
  });
});
