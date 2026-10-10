// Admin → Channels against a stubbed server: every state by design, the URL
// write-only (sent once, never drawn), a test message, and a delete that names
// what it would break.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ChannelsTab } from './ChannelsTab';
import { SLACK, TEAMS, mount, serve } from '../subscriptions/testServer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const channels = (list: unknown[], over: object = {}) => ({ body: { ok: true, channels: list, canStore: true, canManage: true, ...over } });
const URL_IN = 'https://hooks.slack.com/services/T000/B000/secret-token';

describe('Admin → Channels', () => {
  it('shows a skeleton, then each channel with its platform — and whether a URL is stored, never the URL', async () => {
    serve({ 'channel:list': channels([SLACK, { ...TEAMS, secretSet: false }]) });
    const { container } = mount(<ChannelsTab />);
    expect(screen.getByRole('status', { name: 'Loading channels' })).toBeTruthy();
    const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
    expect(await screen.findByText('#sales-weekly')).toBeTruthy();
    expect(within(row('#sales-weekly')).getByText('Slack')).toBeTruthy();
    expect(within(row('#sales-weekly')).getByText('Stored')).toBeTruthy();
    expect(within(row('Leadership')).getByText('Missing')).toBeTruthy();
    expect((within(row('Leadership')).getByRole('button', { name: 'Send a test message' }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.innerHTML).not.toContain('hooks.');
  });

  it('designs the empty state and offers the first channel', async () => {
    serve({ 'channel:list': channels([]) });
    mount(<ChannelsTab />);
    expect(await screen.findByRole('heading', { name: 'No channels yet' })).toBeTruthy();
    expect(screen.getByText(/You paste a webhook URL once; Ordinate encrypts it/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Add a channel/ }).length).toBe(2);
  });

  it('says why nothing can be added on a server that cannot keep a secret', async () => {
    serve({ 'channel:list': channels([], { canStore: false }) });
    mount(<ChannelsTab />);
    expect(await screen.findByRole('heading', { name: 'This server cannot keep webhook URLs yet' })).toBeTruthy();
    expect(screen.getByText(/Set DATABASE_URL and ORDINATE_MASTER_KEY/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add a channel' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('designs the error state with a retry', async () => {
    serve({ 'channel:list': { status: 403, body: { error: 'forbidden' } } });
    mount(<ChannelsTab />);
    expect(await screen.findByRole('heading', { name: 'Channels could not be loaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('adds a channel: platform, name, URL — with the how-to for the platform picked', async () => {
    const calls = serve({ 'channel:list': channels([]), 'channel:save': { body: { ok: true, channel: SLACK } } });
    mount(<ChannelsTab />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Add a channel/ }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Add a channel' });
    expect(within(dialog).getByText(/an incoming webhook posts to one channel/)).toBeTruthy();
    const add = within(dialog).getByRole('button', { name: 'Add channel' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Microsoft Teams' }));
    expect(within(dialog).getByText(/Post to a channel when a webhook request is received/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Slack' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' #sales-weekly ' } });
    fireEvent.change(within(dialog).getByLabelText('Webhook URL'), { target: { value: URL_IN } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(calls.find((c) => c.channel === 'channel:save')?.payload).toEqual({ name: '#sales-weekly', kind: 'slack', webhookUrl: URL_IN }));
    expect(await screen.findByText(/Added #sales-weekly/)).toBeTruthy();
  });

  it('puts the server’s refusal beside the URL field, and keeps the dialog open', async () => {
    serve({ 'channel:list': channels([]), 'channel:save': { body: { ok: false, error: 'A webhook URL must start with https:// and carry no user name or password.' } } });
    mount(<ChannelsTab />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Add a channel/ }))[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(within(dialog).getByLabelText('Webhook URL'), { target: { value: 'http://plain.example/x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add channel' }));
    expect(await within(dialog).findByText('A webhook URL must start with https:// and carry no user name or password.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Webhook URL').getAttribute('aria-invalid')).toBe('true');
  });

  it('editing never shows the stored URL, and leaves it alone unless a new one is pasted', async () => {
    const calls = serve({ 'channel:list': channels([SLACK]), 'channel:save': { body: { ok: true, channel: { ...SLACK, name: 'Sales' } } } });
    mount(<ChannelsTab />);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Actions for #sales-weekly' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit #sales-weekly' });
    const url = within(dialog).getByLabelText('Webhook URL') as HTMLInputElement;
    expect(url.value).toBe('');
    expect(url.placeholder).toBe('Stored — paste a new URL to replace it');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Sales' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'channel:save')?.payload).toEqual({ id: SLACK.id, name: 'Sales', kind: 'slack' }));
  });

  it('sends a test message, and says what the server said when it fails', async () => {
    let n = 0;
    const calls = serve({ 'channel:list': channels([SLACK]), 'channel:test': () => ({ body: n++ === 0 ? { ok: true } : { ok: false, error: 'Not delivered: #sales-weekly answered HTTP 404.' } }) });
    mount(<ChannelsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test message' }));
    expect(await screen.findByText('Test message sent to #sales-weekly')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'channel:test')?.payload).toEqual({ id: SLACK.id });
    fireEvent.click(screen.getByRole('button', { name: 'Send a test message' }));
    expect(await screen.findByText('Not delivered: #sales-weekly answered HTTP 404.')).toBeTruthy();
  });

  it('removing a channel names the subscriptions and alerts that post to it first', async () => {
    const calls = serve({
      'channel:list': channels([SLACK]),
      'channel:usage': { body: { ok: true, subscriptions: [{ projectId: 'p1', project: 'Retail', id: 's1', name: 'Weekly board' }], alerts: [{ projectId: 'p1', project: 'Retail', id: 'a1', name: 'Revenue below 1M' }] } },
      'channel:delete': { body: { ok: true } },
    });
    mount(<ChannelsTab />);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Actions for #sales-weekly' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove #sales-weekly?' });
    const warning = await within(dialog).findByRole('alert');
    expect(warning.textContent).toContain('2 things post to this channel and will stop sending here');
    expect(within(warning).getByText('Weekly board')).toBeTruthy();
    expect(warning.textContent).toContain('subscription in Retail');
    expect(within(warning).getByText('Revenue below 1M')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove channel' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'channel:delete')?.payload).toEqual({ id: SLACK.id }));
  });

  it('removing an unused channel says nothing posts to it', async () => {
    serve({ 'channel:list': channels([SLACK]), 'channel:usage': { body: { ok: true, subscriptions: [], alerts: [] } } });
    mount(<ChannelsTab />);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Actions for #sales-weekly' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
    expect(await screen.findByText('Nothing posts to this channel right now.')).toBeTruthy();
  });
});
