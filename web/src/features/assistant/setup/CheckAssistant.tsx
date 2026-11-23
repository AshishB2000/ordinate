// Check the Assistant (semantic part 3 D13 (3), the owner's answer 3): an editor asks the project's model each working
// verified question once (`verified:check`, a job on the server) and each row of the list then says how the Assistant
// did on it. The run lives in a record any pod reads (`verified:checkResult`); this tab reads it again when its own job
// pushes say the check moved, never on a timer. Every count is the server's; nothing here adds one up.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { useServerEvent } from '../../../api/events';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Icon } from '../../../ui/icons/Icon';
import { useAiStatus } from '../../assistant/api';
import type { Fail } from '../../data/api';
import { formatNumber, stamp } from '../../data/format';
import { checkKey, useCheckResult, type CheckResult } from './api';
import c from './Check.module.css';

const KIND = 'assistant-check';
const NO_MODEL = 'Connect a model to check the Assistant.';
const NOTHING = 'There are no working verified questions to check.';
const n = (v: number) => formatNumber(v);

/** A job push that is about a check: the tab's slice with one running, or one finishing. */
const moves = (p: unknown): boolean => !!(p as { active?: { kind?: string }[] } | null)?.active?.some((j) => j.kind === KIND);
const ends = (p: unknown): boolean => (p as { kind?: string } | null)?.kind === KIND;

const OUTCOME: Record<CheckResult['outcome'], string> = {
  match: '✓ The Assistant gets this',
  differs: '✗ The Assistant answers it differently',
  refused: '✗ The Assistant could not answer it',
};

/** One row's line from the last check, and the server's reason when there is one. */
export function CheckOutcome({ result }: { result: CheckResult }) {
  return (
    <>
      <p className={`${c.outcome} ${result.outcome === 'match' ? c.pass : c.fail}`}>{OUTCOME[result.outcome]}</p>
      {result.reason && <p className={c.reason}>{result.reason}</p>}
    </>
  );
}

/** The button in the verified questions' head: editors only. `working`: the server's rows that still run. */
export function CheckAssistant({ projectId, working }: { projectId: string; working: number }) {
  const qc = useQueryClient();
  const q = useCheckResult(projectId);
  const status = useAiStatus();
  const [asking, setAsking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState('');
  const reread = () => void qc.invalidateQueries({ queryKey: checkKey(projectId) });
  useServerEvent('jobs:changed', (p) => moves(p) && reread());
  useServerEvent('jobs:finished', (p) => ends(p) && reread());

  async function start(): Promise<void> {
    setStarting(true);
    setFailed('');
    try {
      const r = (await rpc('verified:check', { projectId })) as { ok: true; runId: string } | Fail;
      if (r.ok) await qc.invalidateQueries({ queryKey: checkKey(projectId) });
      else setFailed(r.error || 'Try again.');
    } catch (e) {
      setFailed(e instanceof Error && e.message ? e.message : 'Try again.');
    }
    setStarting(false);
    setAsking(false);
  }

  const run = q.data ?? null;
  const running = run?.state === 'running';
  const why = status.data?.ready === false ? NO_MODEL : working === 0 ? NOTHING : '';
  const label = running ? `Checking… ${n(run.asked)} of ${n(run.total)}` : run?.state === 'done' ? `Check the Assistant · ${n(run.matched)} of ${n(run.total)}` : 'Check the Assistant';

  let line = null;
  if (failed || q.isError) {
    line = (
      <p className={c.error} role="alert">
        <Icon name="alert" size={12} />
        <span>{failed ? `The check could not start: ${failed}` : `The last check could not be read: ${q.error?.message || 'try again.'}`}</span>
        <Button variant="ghost" size="sm" onClick={() => (failed ? void start() : void q.refetch())}>
          Try again
        </Button>
      </p>
    );
  } else if (why) line = <p className={c.meta}>{why}</p>;
  else if (run && (run.state === 'stopped' || run.state === 'error')) {
    line = <p className={c.meta}>{`The last check stopped before the end, after ${n(run.asked)} of ${n(run.total)} questions.`}</p>;
  } else if (run?.state === 'done' && run.finishedAt) line = <p className={c.meta}>{`Last checked ${stamp(run.finishedAt)}`}</p>;

  return (
    <div className={c.check}>
      <Button icon="sparkles" loading={running || starting} disabled={!!why || q.isPending} title={why || undefined} onClick={() => setAsking(true)}>
        {label}
      </Button>
      {line}
      {asking && (
        <Dialog
          open
          onOpenChange={(o) => !o && setAsking(false)}
          size="sm"
          title={`Check the Assistant on ${n(working)} verified ${working === 1 ? 'question' : 'questions'}?`}
          description="It asks the model once per question (at most 50)."
          footer={
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button variant="primary" loading={starting} onClick={() => void start()}>
                Check
              </Button>
            </>
          }
        >
          <p className={c.body}>Each question is asked in its own words, without its own answer as an example. The answers are scored against the verified ones; nothing is saved to a conversation.</p>
        </Dialog>
      )}
    </div>
  );
}
