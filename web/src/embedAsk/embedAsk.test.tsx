// The embedded Assistant's page (docs/embedded-assistant, phase 3) against a stubbed /embed/ask: the token from the URL goes in the BODY,
// answers draw a chart and a table, the states are designed (empty, working, failed, held back), and nothing is stored.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { ask, historyOf, tokenFromPath, type Card } from './api';
import { MiniChart } from './MiniChart';

afterEach(() => vi.restoreAllMocks());

const TOKEN = 'aaa.bbb.ccc';
const card = (over: Partial<Card> = {}): Card => ({
  title: 'Shipments by city', chartType: 'column', datasetName: 'Shipments', caption: 'Sum of qty by city', headline: [{ label: 'Total', value: 9, display: '9' }],
  bullets: ['Austin leads'], filterLabels: ['status = late'], notes: [], data: { labels: ['Austin', 'Boston'], series: [{ name: 'qty', values: [6, 3] }] }, ...over,
});
const reply = (body: unknown, init: ResponseInit = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, ...init })) as unknown as typeof fetch;

describe('the page URL and what is sent', () => {
  it('reads the token from /embed/ask/<token> and nothing else', () => {
    expect(tokenFromPath('/embed/ask/aaa.bbb.ccc')).toBe(TOKEN);
    expect(tokenFromPath('/embed/ask/aaa.bbb.ccc/')).toBe(TOKEN);
    for (const bad of ['/embed/ask/', '/embed/ask/a.b', '/embed/aaa.bbb.ccc', '/embed/ask/aaa.bbb.ccc/x', '/x/embed/ask/aaa.bbb.ccc']) expect(tokenFromPath(bad)).toBeNull();
  });
  it('sends the token in the body (never a URL) and only text history, at most 10 turns', async () => {
    const f = reply({ ok: true, text: 'ok', card: null });
    await ask(TOKEN, 'q', historyOf([{ role: 'user', text: 'a' }, { role: 'error', text: 'x' }, { role: 'assistant', text: 'b', card: card() }]), f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/embed/ask');
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN, question: 'q', history: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] });
    expect(historyOf(Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, text: String(i) }))).length).toBe(10);
  });
  it('a network failure, a bad body and a 429 each become a designed failure', async () => {
    expect(await ask(TOKEN, 'q', [], vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual({ ok: false, error: 'The assistant could not answer. Try again.' });
    expect(await ask(TOKEN, 'q', [], vi.fn(async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch)).toMatchObject({ ok: false });
    const limited = await ask(TOKEN, 'q', [], vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Too many questions right now. Try again later.' }), { status: 429, headers: { 'retry-after': '7' } })) as unknown as typeof fetch);
    expect(limited).toEqual({ ok: false, error: 'Too many questions right now. Try again later.', retryAfter: 7 });
  });
});

describe('the page', () => {
  it('starts empty, with the composer and the promise that only their data shows', () => {
    render(<App token={TOKEN} fetcher={reply({})} />);
    expect(screen.getByText(/Ask a question in your own words/)).toBeTruthy();
    expect(screen.getByText('You see only your own data.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.dataset.ready).toBe('true');
  });
  it('asks on Enter, shows the question, then the answer with its chart, table and notes', async () => {
    const f = reply({ ok: true, text: 'Austin has the most.', card: card() });
    render(<App token={TOKEN} fetcher={f} />);
    const box = screen.getByLabelText('Your question');
    fireEvent.change(box, { target: { value: 'shipments by city?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Austin has the most.')).toBeTruthy();
    expect(screen.getByText('shipments by city?')).toBeTruthy();
    const section = screen.getByRole('region', { name: 'Shipments by city' });
    expect(within(section).getByRole('img').getAttribute('aria-label')).toContain('Sum of qty by city');
    expect(within(section).getAllByRole('row').length).toBe(3);
    expect(within(section).getByText('status = late')).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe('');
  });
  it('Shift+Enter does not send', () => {
    const f = reply({ ok: true, text: 'x', card: null });
    render(<App token={TOKEN} fetcher={f} />);
    const box = screen.getByLabelText('Your question');
    fireEvent.change(box, { target: { value: 'q' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(f).not.toHaveBeenCalled();
  });
  it('a failure is an alert, and the question can be asked again', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'The assistant could not answer. Try again.' }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, text: 'Now it works.', card: null }), { status: 200 }));
    render(<App token={TOKEN} fetcher={f as unknown as typeof fetch} />);
    const box = screen.getByLabelText('Your question');
    fireEvent.change(box, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect((await screen.findByRole('alert')).textContent).toContain('could not answer');
    fireEvent.change(box, { target: { value: 'q again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Now it works.')).toBeTruthy();
  });
  it('a held-back question says so and waits out Retry-After before the composer is open again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const f = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Too many questions right now. Try again later.' }), { status: 429, headers: { 'retry-after': '2' } }));
      render(<App token={TOKEN} fetcher={f as unknown as typeof fetch} />);
      fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
      expect((await screen.findByRole('alert')).textContent).toContain('Too many questions');
      fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'again' } });
      expect((screen.getByRole('button', { name: /Wait/ }) as HTMLButtonElement).disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(2100);
      await waitFor(() => expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps nothing: no storage is written', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    render(<App token={TOKEN} fetcher={reply({ ok: true, text: 'x', card: card() })} />);
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('x');
    expect(set).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
  });
});

describe('the chart', () => {
  it('draws one bar per value, from the server\'s numbers, and a line for a line answer', () => {
    const { container, rerender } = render(<MiniChart card={card()} />);
    expect(container.querySelectorAll('rect').length).toBe(2);
    rerender(<MiniChart card={card({ chartType: 'line' })} />);
    expect(container.querySelectorAll('polyline').length).toBe(1);
  });
  it('draws nothing for an empty answer, and says when labels are cut', () => {
    const { container, rerender } = render(<MiniChart card={card({ data: { labels: [], series: [] } })} />);
    expect(container.querySelector('svg')).toBeNull();
    const labels = Array.from({ length: 30 }, (_, i) => `L${i}`);
    rerender(<MiniChart card={card({ data: { labels, series: [{ name: 'qty', values: labels.map((_, i) => i + 1) }] } })} />);
    expect(screen.getByText('6 more in the table.')).toBeTruthy();
    expect(container.querySelectorAll('rect').length).toBe(24);
  });
});
