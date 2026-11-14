// "Not what I asked" under an answer from a verified question: it hands the same words back to be asked of the model,
// and `ask` sends them with `skipVerified`. No button under a model's answer, or where no model can take the question.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { serveRpc } from '../../test-utils';
import { ask, type Turn } from './api';
import { Transcript } from './Transcript';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-14T10:00:00Z';
const asked: Turn = { id: 'u1', role: 'user', text: 'Revenue last month', createdAt: NOW };
const verified: Turn = { id: 'a1', role: 'assistant', text: '', createdAt: NOW, guidance: { verifiedId: 'v1', instructions: 0, examples: [] } };
const modelled: Turn = { id: 'a2', role: 'assistant', text: 'West leads.', createdAt: NOW, guidance: { instructions: 0, examples: ['v1'] } };

function draw(turns: Turn[], onNotThis?: (q: string) => void) {
  render(<Transcript turns={turns} pending={null} lastSteps={null} projectId={PID} threadId="t1" onFollowUp={async () => {}} onNotThis={onNotThis} />);
}

describe('Not what I asked', () => {
  it('under a verified answer: says why, and hands back the question that was asked', () => {
    const onNotThis = vi.fn();
    draw([asked, verified], onNotThis);
    expect(screen.getByTestId('verified-matched').textContent).toContain('Same words as a verified question');
    fireEvent.click(screen.getByRole('button', { name: 'Not what I asked' }));
    expect(onNotThis).toHaveBeenCalledWith('Revenue last month');
  });

  it('NEGATIVE CONTROL: none under a model answer, and none when no model can take it', () => {
    draw([asked, modelled], vi.fn());
    expect(screen.queryByRole('button', { name: 'Not what I asked' })).toBeNull();
    cleanup();
    draw([asked, verified]);
    expect(screen.queryByTestId('verified-matched')).toBeNull();
  });

  it('ask sends skipVerified only when set', async () => {
    const calls = serveRpc({ 'copilot:ask': { body: { ok: false, notReady: true } } });
    await ask(PID, { kind: '' }, 'Revenue last month', 't1', 'a', null, true);
    await ask(PID, { kind: '' }, 'Revenue last month', 't1', 'b');
    const sent = calls.filter((c) => c.channel === 'copilot:ask').map((c) => c.payload as Record<string, unknown>);
    expect(sent[0].skipVerified).toBe(true);
    expect('skipVerified' in sent[1]).toBe(false);
  });
});
