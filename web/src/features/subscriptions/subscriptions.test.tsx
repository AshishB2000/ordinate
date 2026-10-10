// Reports → Subscriptions and the Subscribe dialog, against a stubbed server.
// What they must do: draw the server's sentences as given (schedule, next run,
// outcome, the message itself), show every state by design (loading, empty,
// error, paused), offer a viewer nothing they cannot do, and send the server
// exactly the draft the author made.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import SubscribeDialog from './SubscribeDialog';
import { SubscriptionList } from './SubscriptionList';
import { timeZones } from './Steps';
import { AID, CARDS, PID, SLACK, TEAMS, mount, preview, serve, subscription } from './testServer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EDITOR = { 'projects:roles': { body: { [PID]: 'editor' } } };
const VIEWER = { 'projects:roles': { body: { [PID]: 'viewer' } } };
const frame = { channels: [SLACK, TEAMS], canStore: true, canManage: false };
const list = (subscriptions: unknown[], over: object = {}) => ({ body: { ok: true, subscriptions, ...frame, ...over } });

describe('Reports → Subscriptions', () => {
  it('shows a skeleton, then each row as the server worded it', async () => {
    serve({ ...EDITOR, 'subscription:list': list([subscription()]) });
    mount(<SubscriptionList projectId={PID} />);
    expect(screen.getByRole('list', { name: 'Loading subscriptions' }).getAttribute('aria-busy')).toBe('true');
    const row = await screen.findByRole('listitem', { name: 'Weekly board' });
    expect(within(row).getByRole('link', { name: 'Retail overview' }).getAttribute('href')).toBe(`/analyses/${PID}/${AID}`);
    expect(within(row).getByText('Every weekday at 08:00 (UTC)')).toBeTruthy();
    expect(within(row).getByText('Next: Mon 12 Oct, 08:00')).toBeTruthy();
    expect(within(row).getByText('#sales-weekly')).toBeTruthy();
    expect(within(row).getByText('Leadership')).toBeTruthy();
    expect(within(row).getByText('Sent')).toBeTruthy();
    expect(within(row).getByText('Sent to 2 channels.')).toBeTruthy();
    expect(screen.getByText('1 subscription')).toBeTruthy();
  });

  it('says why a paused one stopped, and that a removed channel is gone', async () => {
    const paused = subscription({
      enabled: false,
      nextRuns: [],
      channelIds: [SLACK.id, '99999999-9999-4999-8999-999999999999'],
      lastRun: { at: '2026-10-09T08:00:20.000Z', trigger: 'schedule', outcome: 'failed', text: 'Not delivered: #sales-weekly answered HTTP 404.' },
      paused: { at: '2026-10-09T08:00:20.000Z', text: 'Paused after 5 failed runs in a row. Fix the cause, then switch it back on.', reason: 'Not delivered: #sales-weekly answered HTTP 404.' },
    });
    serve({ ...EDITOR, 'subscription:list': list([paused]) });
    mount(<SubscriptionList projectId={PID} />);
    const row = await screen.findByRole('listitem', { name: 'Weekly board' });
    expect(within(row).getByText('Paused')).toBeTruthy();
    expect(within(row).getByRole('note').textContent).toContain('Paused after 5 failed runs in a row.');
    expect(within(row).getByRole('note').textContent).toContain('answered HTTP 404');
    expect(within(row).getByText('Failed')).toBeTruthy();
    expect(within(row).getByText('Off — no next run')).toBeTruthy();
    expect(within(row).getByText('Removed channel')).toBeTruthy();
  });

  it('designs the empty state: what a subscription is, and the first action for an editor', async () => {
    serve({ ...EDITOR, 'subscription:list': list([], { channels: [], canManage: true }) });
    mount(<SubscriptionList projectId={PID} />);
    expect(await screen.findByRole('heading', { name: 'Nothing is scheduled yet' })).toBeTruthy();
    expect(screen.getByText(/posts a dashboard’s figures to a Slack or Teams channel on a schedule/)).toBeTruthy();
    expect(screen.getByText(/add one in Admin → Channels/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'New subscription' })).toBeTruthy();
  });

  it('gives a viewer the list and its runs, and no control that writes', async () => {
    serve({ ...VIEWER, 'subscription:list': list([subscription()]) });
    mount(<SubscriptionList projectId={PID} />);
    const row = await screen.findByRole('listitem', { name: 'Weekly board' });
    expect(within(row).queryByRole('switch')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Send now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New subscription' })).toBeNull();
  });

  it('tells a viewer of an empty project that an editor can create one', async () => {
    serve({ ...VIEWER, 'subscription:list': list([]) });
    mount(<SubscriptionList projectId={PID} />);
    expect(await screen.findByText(/An editor of this project can create one/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New subscription' })).toBeNull();
  });

  it('designs the error state with a retry', async () => {
    serve({ ...EDITOR, 'subscription:list': { status: 500, body: { error: 'handler failed' } } });
    mount(<SubscriptionList projectId={PID} />);
    expect(await screen.findByRole('heading', { name: 'Subscriptions could not be loaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('switches one off, and sends one now — saying what the server said either way', async () => {
    let sends = 0;
    const calls = serve({
      ...EDITOR,
      'subscription:list': list([subscription()]),
      'subscription:setEnabled': { body: { ok: true, subscription: subscription({ enabled: false }) } },
      'subscription:sendNow': () => ({
        body: sends++ === 0
          ? { ok: true, run: { at: '2026-10-12T09:00:00Z', trigger: 'manual', outcome: 'sent', text: 'Sent to 2 channels.' } }
          : { ok: false, error: 'Not delivered: #sales-weekly could not be reached.' },
      }),
    });
    mount(<SubscriptionList projectId={PID} />);
    const row = await screen.findByRole('listitem', { name: 'Weekly board' });
    const toggle = await within(row).findByRole('switch', { name: 'Send Weekly board on its schedule' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.find((c) => c.channel === 'subscription:setEnabled')?.payload).toEqual({ projectId: PID, id: subscription().id, enabled: false }));
    fireEvent.click(within(row).getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(within(screen.getByRole('status')).getByText('Sent to 2 channels.')).toBeTruthy());
    fireEvent.click(within(screen.getByRole('listitem', { name: 'Weekly board' })).getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText('Not delivered: #sales-weekly could not be reached.')).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'subscription:sendNow').map((c) => c.payload)).toEqual([{ projectId: PID, id: subscription().id }, { projectId: PID, id: subscription().id }]);
  });
});

function openDialog(routes: Record<string, import('./testServer').Reply> = {}) {
  const calls = serve({ ...EDITOR, 'channel:list': { body: { ok: true, ...frame } }, 'subscription:preview': preview(), ...routes });
  const onClose = vi.fn();
  mount(<SubscribeDialog projectId={PID} dashboard={{ id: AID, name: 'Retail overview' }} onClose={onClose} />);
  return { calls, onClose };
}
const lastPreview = (calls: { channel: string; payload: any }[]) => calls.filter((c) => c.channel === 'subscription:preview').at(-1)?.payload.draft; // any: the draft sent

describe('Subscribe dialog', () => {
  it('opens on What with the preview beside it, drawn from the server’s model', async () => {
    const { calls } = openDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Subscribe to Retail overview' });
    expect(within(dialog).getByRole('button', { name: /What/ }).getAttribute('aria-current')).toBe('step');
    expect(within(dialog).getByRole('status', { name: 'Building the preview' })).toBeTruthy();
    const slack = await within(dialog).findByTestId('preview-slack');
    expect(within(slack).getByText('$5.2M')).toBeTruthy();
    expect(within(slack).getByText('▲ +4.3% vs previous period · good')).toBeTruthy();
    expect(within(slack).getByText('West leads with 400.')).toBeTruthy();
    expect(within(slack).getByText('+2 more in the dashboard')).toBeTruthy();
    expect(within(slack).getByText('Open in Ordinate')).toBeTruthy();
    expect(within(dialog).getByText('7 of 50 blocks · 1 KB')).toBeTruthy();
    // The dashboard is fixed when opened from one: no picker, and no dashboard list is fetched.
    expect(within(dialog).queryByRole('combobox', { name: 'Dashboard' })).toBeNull();
    expect(calls.some((c) => c.channel === 'analysis:gallery')).toBe(false);
    expect(lastPreview(calls)).toMatchObject({ analysisId: AID, content: { mode: 'all', cardIds: [] }, schedule: { cadence: 'weekdays', at: '08:00' } });
  });

  it('the Teams tab draws the Teams cut and says what the limit did', async () => {
    openDialog();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('preview-slack');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Teams' }));
    const teams = within(dialog).getByTestId('preview-teams');
    expect(within(teams).getByText('Retail overview (Teams cut)')).toBeTruthy();
    expect(within(dialog).getByText('3 KB of 28 KB')).toBeTruthy();
    expect(within(dialog).getByText(/Shortened to fit Teams/)).toBeTruthy();
  });

  it('What: lists the dashboard’s cards by title and type, and sends the ticked ones in the dashboard’s order', async () => {
    const { calls } = openDialog();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('preview-slack');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Chosen cards' }));
    expect(within(dialog).getByText('KPI · Overview')).toBeTruthy();
    expect(within(dialog).getByText('Visual · bar · Overview')).toBeTruthy();
    expect(within(dialog).getByText('Visual · line · Trend')).toBeTruthy();
    expect(within(dialog).getByText('Tick at least one card.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Monthly sales' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Revenue' }));
    await waitFor(() => expect(lastPreview(calls).content).toEqual({ mode: 'cards', cardIds: [CARDS[0].id, CARDS[2].id] }));
    expect(within(dialog).getByText('Cards · 2 of 3')).toBeTruthy();
  });

  it('What: offers a saved view only when the dashboard has one', async () => {
    openDialog({ 'subscription:preview': preview({ views: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'West only' }] }) });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('combobox', { name: 'Saved view' })).toBeTruthy();
    expect(within(dialog).queryByText(/has no saved views/)).toBeNull();
  });

  it('When: presets, day chips for weekly, and the next runs in the server’s words', async () => {
    const { calls } = openDialog();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('preview-slack');
    fireEvent.click(within(dialog).getByRole('button', { name: /When/ }));
    expect(within(dialog).getByRole('radio', { name: 'Weekdays' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByRole('status', { name: 'Next runs' }).textContent).toContain('Next: Mon 12 Oct, 08:00 · Tue 13 Oct, 08:00 · Wed 14 Oct, 08:00');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Weekly' }));
    const monday = within(dialog).getByRole('button', { name: 'Monday' });
    expect(monday.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(monday); // the only day: it stays on
    expect(monday.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Thursday' }));
    fireEvent.change(within(dialog).getByLabelText('At'), { target: { value: '09:30' } });
    await waitFor(() => expect(lastPreview(calls).schedule).toEqual({ cadence: 'weekly', at: '09:30', days: [1, 4] }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Monthly' }));
    fireEvent.change(within(dialog).getByLabelText('Day of the month'), { target: { value: '31' } });
    await waitFor(() => expect(lastPreview(calls).schedule).toEqual({ cadence: 'monthly', at: '09:30', dayOfMonth: 31 }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Hourly' }));
    fireEvent.change(within(dialog).getByLabelText('Minute past the hour'), { target: { value: '15' } });
    await waitFor(() => expect(lastPreview(calls).schedule).toEqual({ cadence: 'hourly', at: '00:15' }));
  });

  it('When: the time zone list holds the reader’s own zone and UTC', () => {
    const zones = timeZones('Asia/Kolkata').map((z) => z.value);
    expect(zones).toContain('UTC');
    expect(zones).toContain('Asia/Kolkata');
    expect(new Set(zones).size).toBe(zones.length);
  });

  it('Where: channels with their platform; Subscribe waits for one', async () => {
    const { calls, onClose } = openDialog({ 'subscription:save': { body: { ok: true, subscription: subscription() } } });
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('preview-slack');
    const subscribe = within(dialog).getByRole('button', { name: 'Subscribe' }) as HTMLButtonElement;
    expect(subscribe.disabled).toBe(true);
    expect(within(dialog).getByText('Choose at least one channel.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Where/ }));
    // Each channel says which platform it is on (its hint), beside the mark.
    const hintOf = (name: string) => document.getElementById(within(dialog).getByRole('checkbox', { name }).getAttribute('aria-describedby') as string)?.textContent;
    expect(hintOf('#sales-weekly')).toBe('Slack');
    expect(hintOf('Leadership')).toBe('Teams');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Leadership' }));
    expect(within(dialog).getByText('Send to · 1 chosen')).toBeTruthy();
    // The preview opens on the platform of the channel that was chosen.
    expect(within(dialog).getByTestId('preview-teams')).toBeTruthy();
    expect(subscribe.disabled).toBe(false);
    fireEvent.click(subscribe);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const saved = calls.find((c) => c.channel === 'subscription:save')?.payload;
    expect(saved.projectId).toBe(PID);
    expect(saved.id).toBeUndefined();
    expect(saved.subscription).toMatchObject({ analysisId: AID, channelIds: [TEAMS.id], name: 'Retail overview — weekdays', message: { includeLink: true } });
    expect(await screen.findByText('Subscribed — next: Mon 12 Oct, 08:00')).toBeTruthy();
  });

  it('Where, with no channels: a member is told to ask an admin; an admin gets the link', async () => {
    openDialog({ 'channel:list': { body: { ok: true, channels: [], canStore: true, canManage: false } } });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Where/ }));
    expect(await within(dialog).findByRole('heading', { name: 'No channels yet' })).toBeTruthy();
    expect(within(dialog).getByText(/Ask an admin to add the channel you need/)).toBeTruthy();
    expect(within(dialog).queryByRole('link', { name: 'Add a channel in Admin' })).toBeNull();
  });

  it('Where, with no channels, as an admin: the link to add one', async () => {
    openDialog({ 'channel:list': { body: { ok: true, channels: [], canStore: true, canManage: true } } });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Where/ }));
    expect((await within(dialog).findByRole('link', { name: 'Add a channel in Admin' })).getAttribute('href')).toBe('/admin?tab=channels');
  });

  it('Where: a failed channel load is an error state with a retry, not an empty list', async () => {
    openDialog({ 'channel:list': { status: 500, body: { error: 'handler failed' } } });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Where/ }));
    expect(await within(dialog).findByRole('heading', { name: 'Channels could not be loaded' })).toBeTruthy();
  });

  it('Message: title, note, link and conditions go into the draft; the link note is the server’s', async () => {
    const { calls } = openDialog({ 'subscription:preview': preview({ linkNote: 'No link is sent: this server does not know its public address. An administrator can set ORDINATE_PUBLIC_URL.' }) });
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('preview-slack');
    fireEvent.click(within(dialog).getByRole('button', { name: /Message/ }));
    expect(within(dialog).getByText(/this server does not know its public address/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Monday numbers' } });
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'For the review.' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Something changed' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Include a link to the dashboard' }));
    await waitFor(() => expect(lastPreview(calls)).toMatchObject({ message: { title: 'Monday numbers', note: 'For the review.', includeLink: false }, conditions: { skipUnchanged: true, onlyWhenRefreshed: false } }));
    fireEvent.change(within(dialog).getByLabelText('Subscription name'), { target: { value: '  ' } });
    expect(within(dialog).getByText('Choose at least one channel.')).toBeTruthy();
  });

  it('when there is nothing to send, the preview says why instead of drawing an empty message', async () => {
    openDialog({ 'subscription:preview': preview({ empty: 'Not sent: none of the chosen cards are on the dashboard any more.', slack: null, teams: null }) });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Not sent: none of the chosen cards are on the dashboard any more.')).toBeTruthy();
    expect(within(dialog).queryByTestId('preview-slack')).toBeNull();
  });

  it('a preview that fails is an error state with a retry', async () => {
    openDialog({ 'subscription:preview': { status: 500, body: { error: 'handler failed' } } });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('heading', { name: 'The preview could not be built' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('editing a saved subscription starts from it and saves under its id', async () => {
    const existing = subscription({ channelIds: [SLACK.id], schedule: { cadence: 'weekly', at: '07:15', days: [2] }, message: { title: 'T', note: '', includeLink: false } });
    const calls = serve({ ...EDITOR, 'channel:list': { body: { ok: true, ...frame } }, 'subscription:preview': preview(), 'subscription:save': { body: { ok: true, subscription: existing } } });
    const onClose = vi.fn();
    mount(<SubscribeDialog projectId={PID} existing={existing} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Edit Weekly board' });
    await within(dialog).findByTestId('preview-slack');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.channel === 'subscription:save')?.payload).toMatchObject({ projectId: PID, id: existing.id, subscription: { schedule: { cadence: 'weekly', at: '07:15', days: [2] }, channelIds: [SLACK.id] } });
  });
});
