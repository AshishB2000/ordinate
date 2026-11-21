// A thumbs up or down under an Assistant answer (docs/eval-suites/00-design.md, phase 1). The thumbs-down opens a small panel first,
// with the reasons and the notice "Editors will see this question": nothing is sent until Send, so the person reads the notice BEFORE
// the question is shared (the owner's answer to Q1). The question is the server's to read from the stored conversation; this sends only
// ids, a value and a reason code. Pressing the same thumb again takes it back.

import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button, IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import type { Turn } from './api';
import s from './Thumbs.module.css';

type Feedback = NonNullable<Turn['feedback']>;
type Reply = { ok: true; feedback: Feedback | null } | { ok: false; error?: string };

export const REASONS = [
  { id: 'wrong_number', label: 'Wrong number' },
  { id: 'wrong_data', label: 'Wrong data' },
  { id: 'didnt_answer', label: 'Didn’t answer' },
  { id: 'other', label: 'Something else' },
] as const;
export const NOTICE = 'Editors will see this question. They never see the answer.';

export function Thumbs({ projectId, threadId, turn }: { projectId: string; threadId: string; turn: Pick<Turn, 'id' | 'feedback'> }) {
  const [fb, setFb] = useState<Feedback | null>(turn.feedback ?? null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [said, setSaid] = useState('');

  async function send(value: 'up' | 'down' | 'none', why?: string): Promise<void> {
    setBusy(true);
    setProblem('');
    try {
      const r = (await rpc('feedback:rate', { projectId, threadId, turnId: turn.id, value, ...(why ? { reason: why as never } : {}) })) as Reply;
      if (!r.ok) return setProblem(r.error || 'That could not be saved.');
      setFb(r.feedback);
      setAsking(false);
      setSaid(r.feedback?.value === 'down' ? 'Thanks. The question went to the editors.' : r.feedback?.value === 'up' ? 'Thanks for the feedback.' : '');
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  const pressUp = () => void send(fb?.value === 'up' ? 'none' : 'up');
  const pressDown = () => (fb?.value === 'down' ? void send('none') : (setReason(''), setAsking(!asking)));

  return (
    <div className={s.wrap} data-testid="thumbs">
      <div className={s.row}>
        <IconButton icon="thumbs-up" size="sm" label="Good answer" aria-pressed={fb?.value === 'up'} disabled={busy} className={fb?.value === 'up' ? s.on : undefined} onClick={pressUp} />
        <IconButton
          icon="thumbs-down" size="sm" label="Bad answer" aria-pressed={fb?.value === 'down'} aria-expanded={asking} disabled={busy} className={fb?.value === 'down' ? `${s.on} ${s.onDown}` : undefined}
          title="Bad answer. Editors will see the question." onClick={pressDown}
        />
        {said && !asking && <span className={s.said} role="status">{said}</span>}
      </div>
      {asking && (
        <div className={s.panel} role="group" aria-label="Why was it a bad answer?" data-testid="thumbs-panel">
          <div className={s.chips}>
            {REASONS.map((r) => (
              <button key={r.id} type="button" className={reason === r.id ? `${s.chip} ${s.chipOn}` : s.chip} aria-pressed={reason === r.id} onClick={() => setReason(reason === r.id ? '' : r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          <p className={s.notice}>
            <Icon name="info" size={12} />
            <span>{NOTICE}</span>
          </p>
          <div className={s.actions}>
            <Button size="sm" variant="primary" icon="send" loading={busy} onClick={() => void send('down', reason || undefined)}>
              Send
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {problem && <p className={s.problem} role="alert">{problem}</p>}
    </div>
  );
}
