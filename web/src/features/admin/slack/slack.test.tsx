// Ordinate in Slack in the browser against a stubbed server: Admin → Slack (every state by design: loading, error, no
// accounts, empty, connected), the member's Slack row on Settings, and an agent's channel picker.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SlackTab } from './SlackTab';
import { SlackGroup } from '../../settings/SlackGroup';
import { SlackChannels } from '../../model/assistant/SlackChannels';
import { mount, serve } from '../../subscriptions/testServer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const install = (over: object = {}) => ({
  teamId: 'T1', teamName: 'Acme Slack', mode: 'events', enabled: true, allowGuests: false, allowShareOverride: false, botUserId: 'UB', clientId: 'cid',
  hasBotToken: true, hasSigningSecret: true, hasClientSecret: true, hasAppToken: false, ...over,
});
const status = (over: object = {}) => ({
  body: { ok: true, canSave: true, publicUrl: 'https://bi.example.com', install: null, linked: 0, manifest: { events: '{"settings":{"request_url":"https://bi.example.com/api/slack/events"}}', socket: '{"socket":true}' }, ...over },
});
const KEY = 'xoxb-' + 'k'.repeat(30);

describe('Admin → Slack', () => {
  it('shows a skeleton, then the empty set-up: manifest with Copy, keys form, nothing connected', async () => {
    serve({ 'slack:status': status() });
    mount(<SlackTab />);
    expect(screen.getByRole('status', { name: 'Loading Slack settings' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Ask Ordinate from Slack' })).toBeTruthy();
    expect(screen.getByText('App not connected')).toBeTruthy();
    expect(screen.getByTestId('slack-manifest').textContent).toContain('https://bi.example.com/api/slack/events');
    expect(screen.getByRole('button', { name: 'Copy manifest' })).toBeTruthy();
    expect(screen.getByText('Not set')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Connect to Slack' }) as HTMLButtonElement).disabled).toBe(true); // no token typed yet
    // Behaviour settings only exist once connected.
    expect(screen.queryByRole('switch', { name: 'Answer questions in Slack' })).toBeNull();
  });

  it('designs the error state with a retry', async () => {
    serve({ 'slack:status': { status: 500, body: { error: 'boom' } } });
    mount(<SlackTab />);
    expect(await screen.findByRole('heading', { name: 'Slack settings could not be loaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says so on a server with no database', async () => {
    serve({ 'slack:status': { body: { ok: false, error: 'Slack needs Postgres (DATABASE_URL).' } } });
    mount(<SlackTab />);
    expect(await screen.findByRole('heading', { name: 'Slack needs accounts' })).toBeTruthy();
  });

  it('offers only Socket Mode, and says why, when the server does not know its public address', async () => {
    serve({ 'slack:status': status({ publicUrl: null, manifest: { events: null, socket: '{"socket":true}' } }) });
    mount(<SlackTab />);
    await screen.findByRole('heading', { name: 'Ask Ordinate from Slack' });
    expect(screen.getByTestId('slack-manifest').textContent).toBe('{"socket":true}');
    expect(screen.getByText(/app-level token/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Slack calls Ordinate/ }));
    expect(await screen.findByText(/does not know its public address/)).toBeTruthy();
    expect(screen.getByText(/needs this server’s public address/)).toBeTruthy();
  });

  it('saves the keys through slack:install and never puts a stored key on the page', async () => {
    let saved: Record<string, unknown> | null = null;
    const calls = serve({
      'slack:status': () => status({ install: saved ? install() : null }),
      'slack:install': (input: unknown) => { saved = input as Record<string, unknown>; return { body: { ok: true, install: install() } }; },
    });
    const { container } = mount(<SlackTab />);
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: KEY } });
    fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'sign-secret-123' } });
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'cid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Slack' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'slack:install')).toBe(true));
    expect(saved).toMatchObject({ botToken: KEY, signingSecret: 'sign-secret-123', clientId: 'cid', mode: 'events' });
    expect(await screen.findByText('Connected to Acme Slack')).toBeTruthy();
    expect(container.innerHTML).not.toContain(KEY);
    expect(container.innerHTML).not.toContain('sign-secret-123');
    expect(screen.getByRole('switch', { name: 'Answer questions in Slack' })).toBeTruthy();
  });

  it('shows Slack\'s refusal in the form, in words', async () => {
    serve({ 'slack:status': status(), 'slack:install': { body: { ok: false, error: 'Slack did not accept that bot token.' } } });
    mount(<SlackTab />);
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Slack' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Slack did not accept that bot token.');
  });

  it('connected: has-key flags, the guest and override switches, and a confirmed disconnect', async () => {
    const calls = serve({
      'slack:status': status({ install: install(), linked: 3 }),
      'slack:settings': { body: { ok: true, install: install({ allowGuests: true }) } },
      'slack:uninstall': { body: { ok: true } },
    });
    mount(<SlackTab />);
    expect(await screen.findByText('Connected to Acme Slack')).toBeTruthy();
    expect(screen.getByText('3 people linked')).toBeTruthy();
    expect(screen.getAllByText('Stored. Leave blank to keep it.').length).toBe(2);
    expect((screen.getByRole('switch', { name: 'Let an asker share past a failed check' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Count guests as channel members' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'slack:settings')?.payload).toEqual({ allowGuests: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Slack…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'slack:uninstall')).toBe(true));
  });
});

describe('Settings → Slack row', () => {
  it('is hidden when Slack is not set up', async () => {
    serve({ 'slack:myLink': { body: { ok: true, available: false, links: [] } } });
    const { container } = mount(<SlackGroup />);
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('says not connected, and how to connect', async () => {
    serve({ 'slack:myLink': { body: { ok: true, available: true, teamName: 'Acme Slack', links: [] } } });
    mount(<SlackGroup />);
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(screen.getByText(/private Connect button/)).toBeTruthy();
  });

  it('shows the link and disconnects it', async () => {
    let linked = true;
    const calls = serve({
      'slack:myLink': () => ({ body: { ok: true, available: true, teamName: 'Acme Slack', links: linked ? [{ teamId: 'T1', slackUserId: 'U1', linkedAt: '2026-11-19' }] : [] } }),
      'slack:unlink': () => { linked = false; return { body: { ok: true, removed: 1 } }; },
    });
    mount(<SlackGroup />);
    expect(await screen.findByText('Connected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'slack:unlink').length).toBe(1);
  });

  it('designs the error state', async () => {
    serve({ 'slack:myLink': { status: 500, body: { error: 'x' } } });
    mount(<SlackGroup />);
    expect(await screen.findByRole('heading', { name: 'Could not read your Slack link' })).toBeTruthy();
  });
});

describe('Agent page → Slack channels', () => {
  const props = { projectId: 'p1', agentId: 'a1' };
  it('says to ask an admin when Slack is not connected', async () => {
    serve({ 'slack:channels': { body: { ok: true, connected: false, channels: [] } }, 'agent:slackChannels': { body: { ok: true, connected: false, channels: [] } } });
    mount(<SlackChannels {...props} />);
    expect(await screen.findByText(/not set up yet/)).toBeTruthy();
  });

  it('lists the channels the bot is in, marks the ones another agent holds, and saves the pick', async () => {
    const calls = serve({
      'slack:channels': { body: { ok: true, connected: true, channels: [
        { id: 'C1', name: 'sales', isPrivate: false, agentId: null, projectId: null },
        { id: 'C2', name: 'ops', isPrivate: true, agentId: 'other', projectId: 'p1' },
      ] } },
      'agent:slackChannels': { body: { ok: true, connected: true, channels: [] } },
    });
    mount(<SlackChannels {...props} />);
    expect(await screen.findByText('#sales')).toBeTruthy();
    expect(screen.getByText(/another agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /sales/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save channels' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'agent:slackChannels' && (c.payload as { channels?: unknown }).channels)?.payload).toMatchObject({ channels: [{ id: 'C1' }] }));
  });

  it('says how to add the bot when it is in no channel', async () => {
    serve({ 'slack:channels': { body: { ok: true, connected: true, channels: [] } }, 'agent:slackChannels': { body: { ok: true, connected: true, channels: [] } } });
    mount(<SlackChannels {...props} />);
    expect(await screen.findByText(/Invite @Ordinate/)).toBeTruthy();
  });
});
