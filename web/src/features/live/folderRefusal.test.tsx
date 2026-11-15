// A folder refusal (docs/team-folders D15) is drawn in the same refusal state as a row access one: the
// server's sentence, a lock, no "Make a copy". The route's 409 and a handler's caught reply both read as one.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RpcError } from '../../api/client';
import { FOLDER_OFF_FALLBACK, isFolderRefusal, isRowRefusal, liveRefusalOf } from './refusal';
import { LiveRefusal } from './LiveOff';

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const CLOSED = "This is in a folder you can't open.";
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);

describe('a folder refusal', () => {
  it('is read from the route’s 409 and from a caught reply, with the server’s sentence', () => {
    expect(liveRefusalOf(new RpcError(409, 'folder', CLOSED))).toBe(CLOSED);
    expect(liveRefusalOf({ ok: false, code: 'folder', reason: 'closed', error: CLOSED })).toBe(CLOSED);
    expect(liveRefusalOf({ ok: false, code: 'folder', reason: 'closed' })).toBe(FOLDER_OFF_FALLBACK);
    expect(isFolderRefusal({ ok: false, code: 'folder', error: CLOSED })).toBe(true);
    expect(isRowRefusal({ ok: false, code: 'folder', error: CLOSED })).toBe(false);
  });
  it('is drawn about access, with no Make a copy', () => {
    const { container } = wrap(<LiveRefusal refusal={{ ok: false, code: 'folder', reason: 'closed', error: CLOSED }} projectId={P} datasetId={D} liveMessage="Live words" />);
    expect(screen.getByText('Limited by your access')).toBeTruthy();
    expect(screen.getByText(CLOSED)).toBeTruthy();
    expect(screen.queryByText('Live words')).toBeNull();
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    expect(container.querySelector('[data-folder-refusal]')).not.toBeNull();
    expect(container.querySelector('[data-row-refusal]')).toBeNull();
  });
  it('NEGATIVE CONTROLS: a success, another code and a plain error are not folder refusals', () => {
    expect(isFolderRefusal({ ok: true, code: 'folder' })).toBe(false);
    expect(isFolderRefusal({ ok: false, code: 'row_policy', error: 'x y' })).toBe(false);
    expect(liveRefusalOf(new Error(CLOSED))).toBeNull();
    expect(liveRefusalOf({ ok: false, error: CLOSED })).toBeNull();
  });
});
