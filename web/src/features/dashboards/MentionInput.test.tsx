// The @ picker's keyboard (docs/notifications/00-design.md §5.11): @ at a word's
// start lists the people the server offers; ↓ ↑ move (and wrap); Enter and Tab
// insert `@(address) `; Esc closes the list and NOT the drawer around it (a
// second Esc does); off, the box is a plain one and never asks anyone.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Drawer } from '../../ui/Dialog';
import { serveRpc } from '../../test-utils';
import { MentionInput, mentionQuery } from './MentionInput';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const PEOPLE = [
  { email: 'ann.lee@acme.com', name: 'Ann Lee' },
  { email: 'bea@acme.com', name: 'Bea' },
  { email: 'cal@acme.com', name: 'Cal' },
];

function Box({ enabled = true, onClose }: { enabled?: boolean; onClose?: () => void }) {
  const [v, setV] = useState('');
  return (
    <Drawer open onOpenChange={(o) => !o && onClose?.()} title="Comments">
      <MentionInput projectId={P} enabled={enabled} label="New comment" value={v} onValueChange={setV} />
      <output data-testid="value">{v}</output>
    </Drawer>
  );
}

function mount(enabled = true) {
  const calls = serveRpc({ 'comment:mentionable': { body: { ok: true, available: true, people: PEOPLE } } });
  const closed = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Box enabled={enabled} onClose={closed} />
    </QueryClientProvider>,
  );
  const box = screen.getByLabelText('New comment') as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  return { calls, closed, box, type, value: () => screen.getByTestId('value').textContent };
}

describe('the @ picker', () => {
  it('finds the word after an @ at a word start, and nothing else', () => {
    expect(mentionQuery('hi @an', 6)).toEqual({ from: 3, q: 'an' });
    expect(mentionQuery('@', 1)).toEqual({ from: 0, q: '' });
    expect(mentionQuery('mail a@b', 8)).toBeNull(); // an address being typed is not a mention
    expect(mentionQuery('hi @an there', 12)).toBeNull();
  });

  it('opens on @, moves with the arrows (wrapping) and inserts with Enter', async () => {
    const { box, type, value } = mount();
    type('Look @');
    const list = await screen.findByRole('listbox', { name: 'People who can read this project' });
    await within(list).findByText('Ann Lee');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    const selected = () => within(list).getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected()).toBe(0);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(selected()).toBe(1);
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(selected()).toBe(2); // wrapped to the last
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(value()).toBe('Look @(cal@acme.com) ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab inserts too', async () => {
    const { box, type, value } = mount();
    type('@be');
    await within(await screen.findByRole('listbox')).findByText('Ann Lee');
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(value()).toBe('@(ann.lee@acme.com) ');
  });

  it('Esc closes the list and not the drawer; a second Esc closes the drawer', async () => {
    const { box, type, closed } = mount();
    type('@');
    await within(await screen.findByRole('listbox')).findByText('Bea');
    act(() => {
      fireEvent.keyDown(box, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Comments' })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(box, { key: 'Escape' });
    });
    await waitFor(() => expect(closed).toHaveBeenCalled());
  });

  it('NEGATIVE CONTROL: off (no user directory), @ opens nothing and asks no one', async () => {
    const { type, calls, box } = mount(false);
    type('Look @');
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(calls.some((c) => c.channel === 'comment:mentionable')).toBe(false);
    expect(box.getAttribute('role')).toBeNull();
  });
});
