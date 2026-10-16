// Admin → Embedding against a stubbed server: every state by design, the
// switch held until a secret and a site exist, origins checked as typed, the
// secret shown once and only on the reply that made it, rotation confirmed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { EmbeddingTab } from './EmbeddingTab';
import { mount, serve } from '../subscriptions/testServer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SECRET = 'ord_embed_' + 'Q'.repeat(43);
const settings = (over: object = {}) => ({ body: { canStore: true, enabled: false, origins: [], secretSet: false, org: 'acme', maxOrigins: 20, maxTtlHours: 24, maxLockColumns: 8, ...over } });

describe('Admin → Embedding', () => {
  it('shows a skeleton, then the set-up: nothing done, the switch held, Generate offered', async () => {
    serve({ 'embed:settings': settings(), 'admin:projects': { body: [] } });
    mount(<EmbeddingTab />);
    expect(screen.getByRole('status', { name: 'Loading embedding settings' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Show published dashboards inside your portal or app' })).toBeTruthy();
    expect(screen.getByText('Not set')).toBeTruthy();
    const sw = screen.getByRole('switch', { name: 'Allow embedding' }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText('Generate a signing secret first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate secret' })).toBeTruthy();
    expect(screen.getByText(/No site yet/)).toBeTruthy();
    // The signing code names this org as the kid, and never a secret.
    expect(screen.getByTestId('snippet-node').textContent).toContain("kid: \"acme\"");
    expect(screen.getByTestId('snippet-node').textContent).toContain('process.env.ORDINATE_EMBED_SECRET');
  });

  it('designs the error state with a retry', async () => {
    serve({ 'embed:settings': { status: 403, body: { error: 'forbidden' } } });
    mount(<EmbeddingTab />);
    expect(await screen.findByRole('heading', { name: 'Embedding settings could not be loaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says why nothing can be set up on a server that cannot keep a secret', async () => {
    serve({ 'embed:settings': settings({ canStore: false }), 'admin:projects': { body: [] } });
    mount(<EmbeddingTab />);
    expect(await screen.findByRole('heading', { name: 'This server cannot keep a signing secret yet' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Generate secret' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Allow embedding' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('shows a new secret once, from the reply that made it, and forgets it when stored', async () => {
    let made = false;
    const calls = serve({
      'embed:settings': () => settings({ secretSet: made }),
      'embed:rotate': () => { made = true; return { body: { ok: true, secret: SECRET } }; },
      'admin:projects': { body: [] },
    });
    const { container } = mount(<EmbeddingTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Generate secret' }));
    expect((await screen.findByTestId('embed-secret')).textContent).toBe(SECRET);
    expect(screen.getByText(/This is the only time it is shown/)).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'embed:rotate').length).toBe(1);
    await screen.findByText('Stored');
    fireEvent.click(screen.getByRole('button', { name: 'I have stored it' }));
    await waitFor(() => expect(container.innerHTML).not.toContain(SECRET));
  });

  it('confirms a rotation, saying every embed stops', async () => {
    const calls = serve({ 'embed:settings': settings({ secretSet: true }), 'embed:rotate': { body: { ok: true, secret: SECRET } }, 'admin:projects': { body: [] } });
    mount(<EmbeddingTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rotate the signing secret?' });
    expect(within(dialog).getByText(/stops working at once/)).toBeTruthy();
    expect(calls.some((c) => c.channel === 'embed:rotate')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    expect((await screen.findByTestId('embed-secret')).textContent).toBe(SECRET);
  });

  it('checks an origin as it is typed, and saves the list with the new site', async () => {
    const calls = serve({ 'embed:settings': settings({ secretSet: true }), 'embed:save': { body: { ok: true } }, 'admin:projects': { body: [] } });
    mount(<EmbeddingTab />);
    const field = await screen.findByLabelText('Allow a site');
    const allow = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement;
    for (const bad of ['http://portal.example.com', 'https://portal.example.com/app', 'https://*.example.com', 'portal.example.com']) {
      fireEvent.change(field, { target: { value: bad } });
      expect(screen.getByText(/no path, no wildcard/)).toBeTruthy();
      expect(allow.disabled).toBe(true);
    }
    fireEvent.change(field, { target: { value: 'https://Portal.Example.com/' } });
    expect(allow.disabled).toBe(false);
    fireEvent.click(allow);
    await waitFor(() => expect(calls.find((c) => c.channel === 'embed:save')?.payload).toEqual({ enabled: false, origins: ['https://portal.example.com'] }));
  });

  it('turns embedding on once there is a secret and a site, and shows the server’s refusal beside it', async () => {
    const calls = serve({
      'embed:settings': settings({ secretSet: true, origins: ['https://portal.example.com'] }),
      'embed:save': { body: { ok: false, error: 'Generate a signing secret before turning embedding on.' } },
      'admin:projects': { body: [] },
    });
    mount(<EmbeddingTab />);
    const sw = (await screen.findByRole('switch', { name: 'Allow embedding' })) as HTMLInputElement;
    expect(sw.disabled).toBe(false);
    expect(screen.getByRole('list', { name: 'Allowed sites' }).textContent).toContain('https://portal.example.com');
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.channel === 'embed:save')?.payload).toEqual({ enabled: true, origins: ['https://portal.example.com'] }));
    expect((await screen.findByRole('alert')).textContent).toContain('Generate a signing secret');
  });

  it('keeps the last site while embedding is on (removing it would leave no one allowed)', async () => {
    serve({ 'embed:settings': settings({ secretSet: true, enabled: true, origins: ['https://portal.example.com'] }), 'admin:projects': { body: [] } });
    mount(<EmbeddingTab />);
    expect(((await screen.findByRole('button', { name: 'Remove https://portal.example.com' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('On')).toBeTruthy();
  });
});
