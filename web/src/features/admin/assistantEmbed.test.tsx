// Admin → Embedding → Assistant against a stubbed server: the states by design (loading, error, off, nothing marked, marked, a lock
// that no longer holds), the metadata ceiling stated, caps validated and saved, and a marking sent as the admin picked it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AssistantEmbedCard } from './AssistantEmbedCard';
import { mount, serve } from '../subscriptions/testServer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AGENT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const PROJECT = '6f1c1b5e-6a0e-4a8f-9c55-1f8e4c0d2a10';
const DS = '7f1c1b5e-6a0e-4a8f-9c55-1f8e4c0d2a10';
const settings = (over: object = {}) => ({
  body: {
    canStore: true, org: 'acme', embeddingOn: true, agents: [], caps: { daily: 1000, perMinute: 10 },
    limits: { maxDaily: 1_000_000, maxPerMinute: 600, maxDatasets: 12, defaultDaily: 1000, defaultPerMinute: 10 }, counts: { today: 12, limited: 3 }, ...over,
  },
});
const marked = (state = 'ok', enabled = true) => ({ agentId: AGENT, projectId: PROJECT, projectName: 'Portal', agentName: 'Shipping helper', gone: false, enabled, datasets: [{ id: DS, name: 'Shipments', column: 'customer_id', state }] });

describe('Admin → Embedding → Assistant', () => {
  it('shows a skeleton, then the empty state with the metadata ceiling stated', async () => {
    serve({ 'embedAssistant:settings': settings() });
    mount(<AssistantEmbedCard />);
    expect(screen.getByRole('status', { name: 'Loading the embedded assistant settings' })).toBeTruthy();
    expect(await screen.findByText(/No agent is embeddable yet/)).toBeTruthy();
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('shown to every customer');
    expect(note.textContent).toContain('Do not put a customer’s name in them');
    expect(note.textContent).toContain('never shown to embedded customers');
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByTestId('assistant-snippet-node').textContent).toContain('kid: "acme"');
    expect(screen.getByTestId('assistant-snippet-node').textContent).not.toMatch(/ord_embed_/);
  });
  it('designs the error state with a retry', async () => {
    serve({ 'embedAssistant:settings': { status: 403, body: { error: 'forbidden' } } });
    mount(<AssistantEmbedCard />);
    expect(await screen.findByRole('heading', { name: 'The embedded assistant settings could not be loaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
  it('holds everything when the server cannot keep a secret, and says when embedding is off above', async () => {
    serve({ 'embedAssistant:settings': settings({ canStore: false, embeddingOn: false }) });
    mount(<AssistantEmbedCard />);
    expect(await screen.findByText(/Needs a database and ORDINATE_MASTER_KEY/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Mark an agent' }) as HTMLButtonElement).disabled).toBe(true);
    serve({ 'embedAssistant:settings': settings({ embeddingOn: false }) });
    mount(<AssistantEmbedCard />);
    expect(await screen.findByText(/Embedding is off above/)).toBeTruthy();
  });
  it('lists a marked agent with its lock column, fills the snippet with its id and column, and turns it off', async () => {
    const calls = serve({ 'embedAssistant:settings': settings({ agents: [marked()] }), 'embedAssistant:save': { body: { ok: true } } });
    mount(<AssistantEmbedCard />);
    const list = await screen.findByRole('list', { name: 'Embeddable agents' });
    expect(within(list).getByText('Shipping helper')).toBeTruthy();
    expect(within(list).getByText('customer_id')).toBeTruthy();
    expect(within(list).getByText('Locked')).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByTestId('assistant-snippet-node').textContent).toContain(AGENT);
    expect(screen.getByTestId('assistant-snippet-node').textContent).toContain('"customer_id": [user.customerId]');
    fireEvent.click(screen.getByRole('switch', { name: 'Embeddable' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'embedAssistant:save')?.payload).toEqual({ projectId: PROJECT, agentId: AGENT, enabled: false, datasets: [{ id: DS, column: 'customer_id' }] }));
  });
  it('a lock that no longer holds is flagged, with what to do', async () => {
    serve({ 'embedAssistant:settings': settings({ agents: [marked('changed')] }) });
    mount(<AssistantEmbedCard />);
    expect(await screen.findByText('Steps changed: save again')).toBeTruthy();
    expect(screen.getByText(/Questions are refused until you press Edit and Save/)).toBeTruthy();
  });
  it('stops embedding an agent', async () => {
    const calls = serve({ 'embedAssistant:settings': settings({ agents: [marked()] }), 'embedAssistant:remove': { body: { ok: true } } });
    mount(<AssistantEmbedCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop embedding' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'embedAssistant:remove')?.payload).toEqual({ agentId: AGENT }));
  });
  it('caps: shows the numbers and the counts, refuses out-of-range ones, and saves whole numbers', async () => {
    const calls = serve({ 'embedAssistant:settings': settings(), 'embedAssistant:setLimits': { body: { ok: true } } });
    mount(<AssistantEmbedCard />);
    const daily = (await screen.findByLabelText('Questions a day, whole org')) as HTMLInputElement;
    const minute = screen.getByLabelText('Questions a minute, per customer') as HTMLInputElement;
    expect(daily.value).toBe('1000');
    expect(screen.getByText(/12 answered and 3 held back/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save caps' }) as HTMLButtonElement;
    fireEvent.change(minute, { target: { value: '601' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(minute, { target: { value: '2.5' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(minute, { target: { value: '5' } });
    fireEvent.change(daily, { target: { value: '200' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.channel === 'embedAssistant:setLimits')?.payload).toEqual({ daily: 200, perMinute: 5 }));
  });
  it('marks an agent: project, agent, a dataset and its lock column go to the server as picked, and a refusal is shown', async () => {
    const calls = serve({
      'embedAssistant:settings': settings(),
      'projects:list': { body: [{ id: PROJECT, name: 'Portal', createdAt: '', updatedAt: '' }] },
      'embedAssistant:options': { body: { ok: true, agents: [{ id: AGENT, name: 'Shipping helper' }], datasets: [{ id: DS, name: 'Shipments', textColumns: ['customer_id', 'city'] }] } },
      'embedAssistant:save': { body: { ok: false, error: 'Shipments has row access rules, or is built from a dataset that has them. An embedded assistant cannot use it.' } },
    });
    mount(<AssistantEmbedCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark an agent' }));
    const pick = async (label: string, option: string) => {
      const trigger = await screen.findByRole('combobox', { name: new RegExp(label) });
      await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('option', { name: option }));
    };
    await pick('Project', 'Portal');
    await pick('Assistant agent', 'Shipping helper');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Shipments' }));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    await pick('Lock column of Shipments', 'city');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'embedAssistant:save')?.payload).toEqual({ projectId: PROJECT, agentId: AGENT, enabled: true, datasets: [{ id: DS, column: 'city' }] }));
    expect((await screen.findByRole('alert')).textContent).toContain('row access rules');
  });
});
